/**
 * @file Content script (bundled to dist/content.js).
 *
 * Runs on every supported chat page. It:
 *   1. detects the service from the hostname (does nothing if unsupported);
 *   2. injects a floating "⤓ Export" pill (emerald, bottom-right) that exports
 *      using the last-saved options from chrome.storage;
 *   3. listens for `{action:'EXPORT', options}` / `{action:'DETECT'}` messages
 *      from the popup and reports progress + the last result back.
 *
 * Image fetches (FETCH_IMAGE) and optional NAS sync are routed to the
 * background service worker to bypass the page's CSP / CORS restrictions.
 */
import { detectService, toArchivedChat } from './adapter';
import { runScrape } from './scrapers';
import { runExport } from './export-runner';
import { loadOptions } from './storage';
import type { ChatService, ExtensionExportOptions } from './types';

const service: ChatService | null = detectService(location.hostname);

interface StatusPayload {
  phase: 'idle' | 'scraping' | 'exporting' | 'done' | 'error';
  message: string;
  service?: ChatService | null;
  messageCount?: number;
  at: number;
}

function setStatus(payload: Omit<StatusPayload, 'at'>): void {
  const full: StatusPayload = { ...payload, at: Date.now() };
  try {
    chrome.storage.local.set({ lastStatus: full });
  } catch {
    /* storage may be unavailable during teardown */
  }
  try {
    chrome.runtime.sendMessage({ action: 'STATUS', status: full });
  } catch {
    /* popup may be closed */
  }
}

/** Fire-and-forget optional NAS sync via the background worker. Never throws. */
function syncToNas(chat: unknown): void {
  try {
    chrome.runtime.sendMessage({ action: 'NAS_SYNC', chat });
  } catch {
    /* best-effort only */
  }
}

let exporting = false;

async function doExport(options: ExtensionExportOptions): Promise<{ ok: boolean; error?: string }> {
  if (!service) return { ok: false, error: 'Unsupported site' };
  if (exporting) return { ok: false, error: 'Export already in progress' };
  exporting = true;
  try {
    setStatus({ phase: 'scraping', message: 'Reading conversation…', service });
    const result = await runScrape(service);
    if (result.error) {
      setStatus({ phase: 'error', message: `Scrape failed: ${result.error}`, service });
      return { ok: false, error: result.error };
    }
    if (!result.messages.length) {
      setStatus({ phase: 'error', message: 'No messages found on this page.', service });
      return { ok: false, error: 'No messages found' };
    }
    const chat = toArchivedChat(result, service, location.href);
    setStatus({
      phase: 'exporting',
      message: `Exporting ${chat.messages.length} messages…`,
      service,
      messageCount: chat.messages.length,
    });
    await runExport(chat, options);
    syncToNas(chat);
    setStatus({
      phase: 'done',
      message: `Exported "${chat.title}" (${chat.messages.length} messages).`,
      service,
      messageCount: chat.messages.length,
    });
    return { ok: true };
  } catch (e) {
    const error = String((e && (e as Error).message) || e);
    setStatus({ phase: 'error', message: `Export failed: ${error}`, service });
    return { ok: false, error };
  } finally {
    exporting = false;
  }
}

// ─── Floating export pill ─────────────────────────────────────────────────────
function injectPill(): void {
  if (!service) return;
  if (document.getElementById('ai-pilot-export-pill')) return;

  const pill = document.createElement('button');
  pill.id = 'ai-pilot-export-pill';
  pill.type = 'button';
  pill.title = 'Export this chat (AI-Pilot Chat Exporter)';
  pill.textContent = '⤓ Export';
  pill.setAttribute(
    'style',
    [
      'position:fixed',
      'right:20px',
      'bottom:20px',
      'z-index:2147483647',
      'display:inline-flex',
      'align-items:center',
      'gap:6px',
      'padding:10px 16px',
      'border:none',
      'border-radius:9999px',
      'background:#10b981',
      'color:#04120c',
      'font:600 13px/1 system-ui,-apple-system,"Segoe UI",sans-serif',
      'letter-spacing:.02em',
      'cursor:pointer',
      'box-shadow:0 6px 18px rgba(16,185,129,.35),0 2px 4px rgba(0,0,0,.2)',
      'transition:transform .12s ease,box-shadow .12s ease,opacity .12s ease',
      'user-select:none',
    ].join(';'),
  );
  pill.addEventListener('mouseenter', () => {
    pill.style.transform = 'translateY(-1px)';
  });
  pill.addEventListener('mouseleave', () => {
    pill.style.transform = 'translateY(0)';
  });

  pill.addEventListener('click', async () => {
    if (exporting) return;
    const original = pill.textContent;
    pill.textContent = '… Exporting';
    pill.style.opacity = '0.75';
    try {
      const options = await loadOptions();
      await doExport(options);
    } finally {
      pill.textContent = original;
      pill.style.opacity = '1';
    }
  });

  document.body.appendChild(pill);
}

if (service) {
  if (document.body) injectPill();
  else document.addEventListener('DOMContentLoaded', injectPill, { once: true });

  // Popup → content messages.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;
    if (message.action === 'DETECT') {
      sendResponse({ service });
      return undefined;
    }
    if (message.action === 'EXPORT') {
      const options = (message.options as ExtensionExportOptions) || undefined;
      loadOptions().then((saved) => {
        doExport(options || saved).then((res) => sendResponse(res));
      });
      return true; // async response
    }
    return undefined;
  });
}
