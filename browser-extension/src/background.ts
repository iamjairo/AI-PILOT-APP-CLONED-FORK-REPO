/**
 * @file Background service worker (bundled to dist/background.js).
 *
 * Two responsibilities, both to escape the content script's page-CSP / CORS
 * sandbox:
 *   - FETCH_IMAGE: fetch a (possibly cross-origin) image URL → base64 data URL,
 *     so user-uploaded images survive export. Mirrors the reference extension's
 *     service-worker exactly.
 *   - NAS_SYNC: optional fire-and-forget POST of the ArchivedChat JSON to a
 *     user-configured companion endpoint. Guarded, never blocks anything.
 */

interface FetchUrlMessage {
  action: 'FETCH_IMAGE' | 'FETCH_FILE';
  url: string;
}
interface NasSyncMessage {
  action: 'NAS_SYNC';
  chat: unknown;
}
type BgMessage = FetchUrlMessage | NasSyncMessage | { action: string };

chrome.runtime.onMessage.addListener((request: BgMessage, _sender, sendResponse) => {
  // FETCH_IMAGE (user-uploaded images) and FETCH_FILE (generated download cards)
  // share the same fetch → base64 path. Running in the background worker gives
  // them the user's session cookies and bypasses the content script's page CSP.
  if (request && (request.action === 'FETCH_IMAGE' || request.action === 'FETCH_FILE')) {
    fetch((request as FetchUrlMessage).url, { credentials: 'include' })
      .then((res) => res.blob())
      .then((blob) => {
        const reader = new FileReader();
        reader.onloadend = () => sendResponse({ base64: reader.result });
        reader.onerror = () => sendResponse({ base64: null });
        reader.readAsDataURL(blob);
      })
      .catch(() => sendResponse({ base64: null }));
    return true; // async response
  }

  if (request && request.action === 'NAS_SYNC') {
    void syncToNas((request as NasSyncMessage).chat);
    // Fire-and-forget: no response awaited.
    return false;
  }

  return false;
});

/** Optional NAS companion sync. Reads settings from storage; never throws. */
async function syncToNas(chat: unknown): Promise<void> {
  try {
    const cfg = await chrome.storage.sync.get(['nasSyncEnabled', 'nasEndpoint']);
    if (!cfg.nasSyncEnabled) return;
    const endpoint = typeof cfg.nasEndpoint === 'string' ? cfg.nasEndpoint.trim() : '';
    if (!endpoint) return;
    // `no-cors` keeps this a best-effort beacon that needs no host permission
    // for the (user-configured) NAS origin; the response is opaque and ignored.
    await fetch(endpoint, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chat),
    });
  } catch {
    /* best-effort — swallow all errors, never block the download */
  }
}
