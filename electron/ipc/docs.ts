/**
 * @file Docs URL-fetch IPC handler.
 *
 * Fetches an arbitrary docs/reader web page server-side (in the Electron main
 * process), extracts the readable article with Mozilla Readability, and
 * sanitizes the resulting HTML with DOMPurify before returning it to the
 * renderer. All of jsdom / Readability / DOMPurify run here in the main
 * process only — they are Node-only and must never be imported into renderer
 * code.
 */

import { ipcMain } from 'electron';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import createDOMPurify, { type WindowLike } from 'dompurify';
import { IPC } from '../../shared/ipc';
import type { DocsFetchResult } from '../../shared/types';

/** Max time to wait for the remote fetch before aborting. */
const FETCH_TIMEOUT_MS = 15_000;
/** Cap the downloaded body size to avoid pulling huge pages into memory. */
const MAX_BODY_BYTES = 5 * 1024 * 1024; // ~5MB
/** Desktop UA so sites serve their normal (non-mobile / non-bot) markup. */
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export function registerDocsIpc(): void {
  ipcMain.handle(
    IPC.DOCS_FETCH_URL,
    async (_event, url: string): Promise<DocsFetchResult> => {
      // NEVER throw out of this handler — always resolve a DocsFetchResult.
      try {
        if (typeof url !== 'string' || url.trim() === '') {
          return { ok: false, url: String(url ?? ''), error: 'A URL is required' };
        }

        // ── Guard 1: URL scheme — http/https only ──────────────────────────
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return { ok: false, url, error: 'Invalid URL' };
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { ok: false, url, error: 'Only http/https URLs are supported' };
        }

        // ── Guard 2: timeout via AbortController ───────────────────────────
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        let response: Response;
        try {
          response = await fetch(parsed.toString(), {
            signal: controller.signal,
            redirect: 'follow',
            headers: {
              'User-Agent': DESKTOP_USER_AGENT,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
          });
        } catch (err) {
          const aborted = err instanceof Error && err.name === 'AbortError';
          return {
            ok: false,
            url,
            error: aborted
              ? `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
              : `Failed to fetch: ${err instanceof Error ? err.message : String(err)}`,
          };
        } finally {
          clearTimeout(timeout);
        }

        if (!response.ok) {
          return { ok: false, url, error: `HTTP ${response.status} ${response.statusText}` };
        }

        const finalUrl = response.url || parsed.toString();

        // ── Guard 3: cap body size while streaming ─────────────────────────
        const html = await readBodyCapped(response, MAX_BODY_BYTES);
        if (html === null) {
          return { ok: false, url, error: 'Page exceeds the maximum size (5MB)' };
        }

        // ── Parse with jsdom, extract with Readability ─────────────────────
        const dom = new JSDOM(html, { url: finalUrl });
        const article = new Readability(dom.window.document).parse();

        if (!article || !article.content) {
          return { ok: false, url, error: 'Could not extract readable content from this page' };
        }

        // ── Sanitize the article HTML against the jsdom window ─────────────
        // Drop scripts/styles/iframes/forms and inline event handlers so the
        // renderer can safely inject the HTML via dangerouslySetInnerHTML.
        const purify = createDOMPurify(dom.window as unknown as WindowLike);
        const clean = purify.sanitize(article.content, {
          FORBID_TAGS: ['script', 'style', 'iframe', 'form'],
          FORBID_ATTR: ['onerror', 'onload', 'onclick'],
        });

        return {
          ok: true,
          url,
          finalUrl,
          title: article.title ?? undefined,
          byline: article.byline ?? undefined,
          html: clean,
          text: article.textContent ?? undefined,
        };
      } catch (err) {
        return {
          ok: false,
          url: typeof url === 'string' ? url : String(url ?? ''),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  );
}

/**
 * Read a fetch Response body as text while enforcing a byte cap. Returns null
 * if the body exceeds `maxBytes`. Falls back to `response.text()` when the body
 * is not a readable stream.
 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string | null> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf-8') > maxBytes ? null : text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
}
