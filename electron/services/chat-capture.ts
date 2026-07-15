/**
 * @file Chat Exporter capture engine (main process).
 *
 * Imports the user's OWN conversations from AI chat services into the Postgres
 * chat archive. This is a legitimate personal-data import: the user logs in
 * themselves in a real BrowserWindow, and we replay the site's own APIs / read
 * its own DOM using the session the user established — the same technique as
 * the user's Chrome extension, now in-app. We NEVER type credentials.
 *
 * Session isolation: each service gets its own Electron partition
 * (`persist:chat-<service>`) so cookies/localStorage for one service never mix
 * with another or with the host app.
 *
 * Capture strategy, per service:
 *   - chatgpt : official API replay from page context (cookies apply):
 *               `/api/auth/session` → bearer token → `/backend-api/conversations`
 *               and `/backend-api/conversation/{id}` (JSON tree → linear msgs).
 *   - all others: open the conversation in a BrowserWindow and run the ported
 *               DOM scraper (chat-scrapers.ts) via executeJavaScript. Listing
 *               is best-effort sidebar-link scraping, falling back to
 *               import-the-currently-open-conversation-only.
 *
 * Everything is wrapped so nothing throws out to IPC; failures surface as a
 * `phase:'error'` progress event and an empty/partial result.
 */

import { BrowserWindow, session as electronSession } from 'electron';
import { JSDOM } from 'jsdom';
import createDOMPurify, { type WindowLike } from 'dompurify';
import type {
  ArchivedChat,
  ChatMessage,
  ChatService,
  ChatServiceInfo,
  ChatCaptureProgress,
  RemoteChatSummary,
} from '../../shared/types';
import { getEditorStore } from './editor-store';
import { getLogger } from './logger';
import {
  buildScrapeScript,
  buildSidebarListScript,
  buildCurrentConversationScript,
  type ScrapeResult,
} from './chat-scrapers';

const log = getLogger('chat-capture');

// ── Service table ────────────────────────────────────────────────────────
// Hosts taken from the reference scraper PLATFORM constants.

interface ServiceDef {
  id: ChatService;
  name: string;
  host: string;
  /** Where the login window points. */
  loginUrl: string;
  /** Origin messages / conversation URLs must belong to (http/https only). */
  origins: string[];
  /** Cookie names that hint an authenticated session exists (heuristic). */
  authCookies: string[];
  /** True when import is only reliable for the currently-open conversation. */
  importsCurrentOnly: boolean;
}

const SERVICES: Record<ChatService, ServiceDef> = {
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    host: 'chatgpt.com',
    loginUrl: 'https://chatgpt.com/',
    origins: ['https://chatgpt.com', 'https://chat.openai.com'],
    authCookies: ['__Secure-next-auth.session-token', '__Secure-next-auth.session-token.0'],
    importsCurrentOnly: false,
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    host: 'claude.ai',
    loginUrl: 'https://claude.ai/',
    origins: ['https://claude.ai'],
    authCookies: ['sessionKey', '__Secure-next-auth.session-token'],
    importsCurrentOnly: false,
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    host: 'gemini.google.com',
    loginUrl: 'https://gemini.google.com/app',
    origins: ['https://gemini.google.com'],
    authCookies: ['__Secure-1PSID', '__Secure-3PSID', 'SID'],
    // Gemini conversations aren't cleanly URL-addressable from the sidebar.
    importsCurrentOnly: true,
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    host: 'chat.deepseek.com',
    loginUrl: 'https://chat.deepseek.com/',
    origins: ['https://chat.deepseek.com'],
    // DeepSeek keeps its auth token largely in localStorage; cookie hints are
    // unreliable, so connected-state may under-report until a cookie exists.
    authCookies: ['ds_session_id', 'cf_clearance'],
    importsCurrentOnly: false,
  },
  lechat: {
    id: 'lechat',
    name: 'Le Chat',
    host: 'chat.mistral.ai',
    loginUrl: 'https://chat.mistral.ai/',
    origins: ['https://chat.mistral.ai'],
    authCookies: ['ory_session', 'JWT'],
    importsCurrentOnly: false,
  },
  qwen: {
    id: 'qwen',
    name: 'Qwen',
    host: 'chat.qwen.ai',
    loginUrl: 'https://chat.qwen.ai/',
    origins: ['https://chat.qwen.ai'],
    // Qwen also stores its token in localStorage; cookie hints are unreliable.
    authCookies: ['token', 'ssxmod_itna'],
    importsCurrentOnly: false,
  },
};

const PARTITION_PREFIX = 'persist:chat-';
const LOAD_TIMEOUT_MS = 30_000;
const SCRAPE_SETTLE_MS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;

function partitionFor(service: ChatService): string {
  return PARTITION_PREFIX + service;
}

/** Only ever operate on the service's own http(s) origins. */
function isAllowedUrl(service: ChatService, url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return SERVICES[service].origins.some((o) => url.startsWith(o));
  } catch {
    return false;
  }
}

// ── Small utilities ────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Create a hidden BrowserWindow bound to the service's persisted partition. */
function createHiddenWindow(service: ChatService): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: {
      partition: partitionFor(service),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // Keep pages from spawning extra renderers we don't manage.
      backgroundThrottling: false,
    },
  });
}

/** Load a URL into a window, resolving once loading has stopped (or timing out). */
async function loadUrl(win: BrowserWindow, url: string): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const done = () => {
        win.webContents.off('did-finish-load', onFinish);
        win.webContents.off('did-stop-loading', onFinish);
        win.webContents.off('did-fail-load', onFail);
        resolve();
      };
      const onFinish = () => done();
      const onFail = (_e: unknown, code: number, desc: string) => {
        // -3 == ABORTED (SPA client-side redirects). Treat as non-fatal.
        if (code === -3) return;
        win.webContents.off('did-finish-load', onFinish);
        win.webContents.off('did-stop-loading', onFinish);
        win.webContents.off('did-fail-load', onFail);
        reject(new Error(`Failed to load (${code}): ${desc}`));
      };
      win.webContents.on('did-finish-load', onFinish);
      win.webContents.on('did-stop-loading', onFinish);
      win.webContents.on('did-fail-load', onFail);
      win.loadURL(url).catch(onFail as never);
    }),
    LOAD_TIMEOUT_MS,
    'Page load',
  );
}

/** Run JS in the page, bounded by a timeout. Never rejects with page errors. */
async function runInPage<T>(win: BrowserWindow, script: string): Promise<T> {
  return withTimeout(
    win.webContents.executeJavaScript(script, true) as Promise<T>,
    REQUEST_TIMEOUT_MS,
    'executeJavaScript',
  );
}

// ── HTML normalization (main process, jsdom + DOMPurify) ────────────────────

// One reusable jsdom window for parsing + sanitizing scraped HTML.
const jsdom = new JSDOM('<!doctype html><html><body></body></html>');
const purify = createDOMPurify(jsdom.window as unknown as WindowLike);

function sanitizeHtml(html: string): string {
  return purify.sanitize(html, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'object', 'embed'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
    // Preserve data: image URIs (attachments captured inline by the scraper).
    ADD_DATA_URI_TAGS: ['img'],
  });
}

/** Parse `<pre><code>` fenced blocks out of an HTML fragment. */
function parseCodeBlocksFromHtml(html: string): { lang?: string; code: string }[] {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const blocks: { lang?: string; code: string }[] = [];
  doc.querySelectorAll('pre').forEach((pre) => {
    const codeEl = pre.querySelector('code') || pre;
    const code = codeEl.textContent ?? '';
    if (!code.trim()) return;
    let lang: string | undefined;
    const cls = codeEl.getAttribute('class') || pre.getAttribute('class') || '';
    const m = cls.match(/language-([\w+-]+)/i);
    if (m) lang = m[1].toLowerCase();
    blocks.push(lang ? { lang, code } : { code });
  });
  return blocks;
}

/** Parse fenced ```lang\ncode``` blocks out of markdown/plain text. */
function parseCodeBlocksFromMarkdown(text: string): { lang?: string; code: string }[] {
  const blocks: { lang?: string; code: string }[] = [];
  const re = /```([\w+-]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const lang = m[1]?.trim().toLowerCase();
    const code = m[2] ?? '';
    if (!code.trim()) continue;
    blocks.push(lang ? { lang, code } : { code });
  }
  return blocks;
}

/** Pull inline images (data: URIs or remote src) out of a fragment. */
function parseAttachmentsFromHtml(html: string): { name: string; url: string; mime?: string }[] {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const out: { name: string; url: string; mime?: string }[] = [];
  let i = 0;
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!src) return;
    if (!src.startsWith('data:') && !src.startsWith('http:') && !src.startsWith('https:')) return;
    let mime: string | undefined;
    const dm = src.match(/^data:([^;,]+)[;,]/);
    if (dm) mime = dm[1];
    out.push({ name: img.getAttribute('alt') || `image-${++i}`, url: src, mime });
  });
  return out;
}

function htmlToText(html: string): string {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Map the scraper's 'user' | 'model' role onto the ChatMessage role. */
function normalizeRole(role: string): ChatMessage['role'] {
  return role === 'user' ? 'user' : 'assistant';
}

/** Normalize one scraped `{ role, htmlContent }` into a ChatMessage. */
function normalizeScrapedMessage(role: string, htmlContent: string): ChatMessage {
  const html = sanitizeHtml(htmlContent);
  const text = htmlToText(html);
  const codeBlocks = parseCodeBlocksFromHtml(html);
  const attachments = parseAttachmentsFromHtml(html);
  const msg: ChatMessage = { role: normalizeRole(role), html, text };
  if (codeBlocks.length) msg.codeBlocks = codeBlocks;
  if (attachments.length) msg.attachments = attachments;
  return msg;
}

// ── ChatGPT API replay types ────────────────────────────────────────────────

interface GptConversationsResponse {
  items?: { id: string; title?: string; update_time?: number; create_time?: number }[];
  error?: string;
  __err?: string;
}

interface GptMessageNode {
  id: string;
  message?: {
    author?: { role?: string };
    content?: { content_type?: string; parts?: unknown[] };
    create_time?: number | null;
  } | null;
  parent?: string | null;
  children?: string[];
}

interface GptConversationDetail {
  title?: string;
  create_time?: number;
  mapping?: Record<string, GptMessageNode>;
  current_node?: string;
  error?: string;
  __err?: string;
}

/**
 * Script (page context) that grabs the session bearer token and calls a
 * same-origin backend-api path. Cookies apply automatically. Returns parsed
 * JSON or an `{ __err }` marker; never throws out of executeJavaScript.
 */
function gptFetchScript(path: string): string {
  return (
    '(async () => { try {' +
    " var s = await fetch('/api/auth/session', { credentials: 'include' }).then(function(r){return r.json();}).catch(function(){return null;});" +
    ' var token = s && s.accessToken;' +
    " if (!token) return { __err: 'no-access-token' };" +
    ' var res = await fetch(' + JSON.stringify(path) + ', {' +
    "   headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }," +
    "   credentials: 'include'" +
    ' }).then(function(r){ return r.json(); });' +
    ' return res;' +
    ' } catch (e) { return { __err: String(e && e.message || e) }; } })()'
  );
}

/** Walk a ChatGPT mapping tree from current_node up to the root → linear. */
function linearizeGptMapping(detail: GptConversationDetail): ChatMessage[] {
  const mapping = detail.mapping;
  if (!mapping) return [];
  // Prefer the current_node parent-chain (the active branch).
  const ordered: GptMessageNode[] = [];
  let cursor: string | undefined = detail.current_node;
  if (cursor && mapping[cursor]) {
    const chain: GptMessageNode[] = [];
    const guard = new Set<string>();
    while (cursor && mapping[cursor] && !guard.has(cursor)) {
      guard.add(cursor);
      chain.push(mapping[cursor]);
      cursor = mapping[cursor].parent ?? undefined;
    }
    chain.reverse();
    ordered.push(...chain);
  } else {
    // Fallback: root-first DFS through children.
    const roots = Object.values(mapping).filter((n) => !n.parent);
    const visit = (node: GptMessageNode) => {
      ordered.push(node);
      (node.children || []).forEach((cid) => { if (mapping[cid]) visit(mapping[cid]); });
    };
    roots.forEach(visit);
  }

  const messages: ChatMessage[] = [];
  for (const node of ordered) {
    const m = node.message;
    if (!m || !m.author) continue;
    const role = m.author.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') continue;
    if (role === 'system') continue; // skip hidden system prompts
    const parts = m.content?.parts ?? [];
    const textParts: string[] = [];
    const attachments: { name: string; url: string; mime?: string }[] = [];
    let imgIdx = 0;
    for (const part of parts) {
      if (typeof part === 'string') {
        textParts.push(part);
      } else if (part && typeof part === 'object') {
        // Multimodal image pointer — we can't easily download the binary here,
        // so we record a reference. (best-effort)
        const p = part as Record<string, unknown>;
        const ptr = (p.asset_pointer || p.image_url || p.file_id) as string | undefined;
        if (ptr) attachments.push({ name: `image-${++imgIdx}`, url: String(ptr) });
      }
    }
    const text = textParts.join('\n\n').trim();
    if (!text && attachments.length === 0) continue;
    const codeBlocks = parseCodeBlocksFromMarkdown(text);
    const msg: ChatMessage = {
      role: role as ChatMessage['role'],
      text,
      // Store escaped text as html so the renderer has a body to show.
      html: text ? `<div class="chat-markdown">${escapeHtmlText(text)}</div>` : undefined,
    };
    if (typeof m.create_time === 'number') msg.createdAt = Math.round(m.create_time * 1000);
    if (codeBlocks.length) msg.codeBlocks = codeBlocks;
    if (attachments.length) msg.attachments = attachments;
    messages.push(msg);
  }
  return messages;
}

function escapeHtmlText(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Public API: connected-state ─────────────────────────────────────────────

/** Heuristic: does a persisted session with an auth-hint cookie exist? */
async function isConnected(service: ChatService): Promise<boolean> {
  const def = SERVICES[service];
  try {
    const ses = electronSession.fromPartition(partitionFor(service));
    const cookies = await ses.cookies.get({});
    const wanted = new Set(def.authCookies);
    for (const c of cookies) {
      if (wanted.has(c.name)) return true;
    }
    return false;
  } catch (err) {
    log.warn('isConnected() failed', { service, err: String(err) });
    return false;
  }
}

export async function listServices(): Promise<ChatServiceInfo[]> {
  const out: ChatServiceInfo[] = [];
  for (const def of Object.values(SERVICES)) {
    out.push({
      id: def.id,
      name: def.name,
      host: def.host,
      connected: await isConnected(def.id),
    });
  }
  return out;
}

// ── Public API: login ────────────────────────────────────────────────────────

/**
 * Open a visible login window on the service's own partition. The USER logs in
 * themselves. Resolves when the window is closed OR a logged-in signal (an
 * auth-hint cookie appearing) is detected — whichever comes first. We NEVER
 * type credentials.
 */
export async function openLogin(service: ChatService): Promise<boolean> {
  const def = SERVICES[service];
  if (!isAllowedUrl(service, def.loginUrl)) {
    log.error('openLogin blocked: disallowed url', { service });
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const win = new BrowserWindow({
      width: 600,
      height: 800,
      title: `Sign in — ${def.name}`,
      autoHideMenuBar: true,
      webPreferences: {
        partition: partitionFor(service),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
      },
    });

    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (!win.isDestroyed()) {
        // Give cookies a beat to flush to the persistent partition.
        setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 400);
      }
    };

    // Poll for a logged-in signal so we can auto-complete without forcing the
    // user to close the window manually.
    const poll = setInterval(() => {
      isConnected(service)
        .then((ok) => { if (ok) finish(); })
        .catch(() => { /* ignore */ });
    }, 1500);

    win.on('closed', () => {
      settled = true;
      clearInterval(poll);
      // Resolve with the final connected state.
      isConnected(service)
        .then((ok) => resolve(ok))
        .catch(() => resolve(false));
    });

    win.loadURL(def.loginUrl).catch((err) => {
      log.warn('login window load failed', { service, err: String(err) });
    });
  });
}

// ── Public API: list remote conversations ────────────────────────────────────

export async function listRemote(service: ChatService): Promise<RemoteChatSummary[]> {
  try {
    if (service === 'chatgpt') return await listRemoteChatGpt();
    return await listRemoteViaDom(service);
  } catch (err) {
    log.error('listRemote() failed', { service, err: String(err) });
    return [];
  }
}

async function listRemoteChatGpt(): Promise<RemoteChatSummary[]> {
  const win = createHiddenWindow('chatgpt');
  try {
    await loadUrl(win, SERVICES.chatgpt.loginUrl);
    await delay(SCRAPE_SETTLE_MS);
    const res = await runInPage<GptConversationsResponse>(
      win,
      gptFetchScript('/backend-api/conversations?offset=0&limit=100&order=updated'),
    );
    if (!res || res.__err || res.error || !Array.isArray(res.items)) {
      log.warn('chatgpt conversations replay returned no items', {
        err: res?.__err || res?.error,
      });
      return [];
    }
    return res.items.map((it) => ({
      id: it.id,
      title: it.title?.trim() || 'Untitled conversation',
      updatedAt: it.update_time ? Math.round(it.update_time * 1000) : undefined,
    }));
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * Best-effort DOM listing for services without a clean list API: scrape the
 * sidebar for conversation links; if none are found, return the currently open
 * conversation as a single item (import-current-conversation-only).
 */
async function listRemoteViaDom(service: ChatService): Promise<RemoteChatSummary[]> {
  const def = SERVICES[service];
  const win = createHiddenWindow(service);
  try {
    await loadUrl(win, def.loginUrl);
    await delay(SCRAPE_SETTLE_MS);

    if (!def.importsCurrentOnly) {
      const items = await runInPage<{ id: string; title: string }[]>(
        win,
        buildSidebarListScript(service),
      );
      if (Array.isArray(items) && items.length > 0) {
        return items
          .filter((it) => isAllowedUrl(service, it.id))
          .map((it) => ({ id: it.id, title: it.title || 'Untitled conversation' }));
      }
    }

    // Fallback / current-only services: describe the open conversation.
    const current = await runInPage<{ id: string; title: string } | null>(
      win,
      buildCurrentConversationScript(),
    );
    if (current && isAllowedUrl(service, current.id)) {
      return [{ id: current.id, title: current.title || 'Current conversation' }];
    }
    return [];
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// ── Public API: import ───────────────────────────────────────────────────────

export type ProgressFn = (p: ChatCaptureProgress) => void;

export async function importChats(
  service: ChatService,
  ids: string[],
  onProgress: ProgressFn,
): Promise<ArchivedChat[]> {
  const results: ArchivedChat[] = [];
  const total = ids.length;

  const emit = (p: ChatCaptureProgress) => {
    try { onProgress(p); } catch { /* never let progress reporting throw */ }
  };

  if (!Array.isArray(ids) || ids.length === 0) {
    emit({ service, phase: 'done', current: 0, total: 0, message: 'Nothing to import' });
    return results;
  }

  emit({ service, phase: 'listing', current: 0, total, message: 'Preparing import' });

  try {
    if (service === 'chatgpt') {
      await importChatGpt(service, ids, results, emit);
    } else {
      await importViaDom(service, ids, results, emit);
    }
    emit({ service, phase: 'done', current: results.length, total, message: `Imported ${results.length}/${total}` });
  } catch (err) {
    log.error('importChats() failed', { service, err: String(err) });
    emit({ service, phase: 'error', current: results.length, total, message: String(err instanceof Error ? err.message : err) });
  }

  return results;
}

async function importChatGpt(
  service: ChatService,
  ids: string[],
  results: ArchivedChat[],
  emit: ProgressFn,
): Promise<void> {
  const win = createHiddenWindow(service);
  try {
    await loadUrl(win, SERVICES.chatgpt.loginUrl);
    await delay(SCRAPE_SETTLE_MS);

    let i = 0;
    for (const id of ids) {
      i++;
      emit({ service, phase: 'importing', current: i, total: ids.length, message: `Fetching conversation ${i}/${ids.length}` });
      try {
        const detail = await runInPage<GptConversationDetail>(
          win,
          gptFetchScript(`/backend-api/conversation/${encodeURIComponent(id)}`),
        );
        if (!detail || detail.__err || detail.error) {
          log.warn('chatgpt conversation replay error', { id, err: detail?.__err || detail?.error });
          continue;
        }
        const messages = linearizeGptMapping(detail);
        if (messages.length === 0) continue;
        const chat: ArchivedChat = {
          id: `chatgpt:${id}`,
          service,
          title: detail.title?.trim() || 'Untitled conversation',
          model: null,
          sourceUrl: `https://chatgpt.com/c/${id}`,
          messages,
          createdAt: typeof detail.create_time === 'number' ? Math.round(detail.create_time * 1000) : null,
          importedAt: Date.now(),
        };
        await getEditorStore().archiveChat(chat);
        results.push(chat);
      } catch (err) {
        log.warn('chatgpt import of one conversation failed', { id, err: String(err) });
      }
    }
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function importViaDom(
  service: ChatService,
  ids: string[],
  results: ArchivedChat[],
  emit: ProgressFn,
): Promise<void> {
  const win = createHiddenWindow(service);
  try {
    let i = 0;
    for (const id of ids) {
      i++;
      // `id` is the full conversation URL for DOM-scraped services.
      if (!isAllowedUrl(service, id)) {
        log.warn('importViaDom skipped disallowed url', { service, id });
        continue;
      }
      emit({ service, phase: 'importing', current: i, total: ids.length, message: `Opening conversation ${i}/${ids.length}` });
      try {
        await loadUrl(win, id);
        await delay(SCRAPE_SETTLE_MS);
        const scraped = await runInPage<ScrapeResult & { error?: string }>(
          win,
          buildScrapeScript(service),
        );
        const rawMessages = scraped?.messages ?? [];
        const messages: ChatMessage[] = rawMessages
          .map((m) => normalizeScrapedMessage(m.role, m.htmlContent))
          .filter((m) => (m.text && m.text.length > 0) || (m.attachments && m.attachments.length > 0));
        if (messages.length === 0) {
          log.warn('DOM scrape produced no messages', { service, id, err: scraped?.error });
          continue;
        }
        const chat: ArchivedChat = {
          id: `${service}:${hashUrl(id)}`,
          service,
          title: scraped?.title?.trim() || 'Imported conversation',
          model: null,
          sourceUrl: id,
          messages,
          createdAt: null,
          importedAt: Date.now(),
        };
        await getEditorStore().archiveChat(chat);
        results.push(chat);
      } catch (err) {
        log.warn('DOM import of one conversation failed', { service, id, err: String(err) });
      }
    }
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Stable short id from a conversation URL (path-based when possible). */
function hashUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    const last = path.split('/').filter(Boolean).pop();
    if (last && /[0-9a-f-]{6,}/i.test(last)) return last;
  } catch { /* fall through */ }
  // Fallback: djb2 hash of the whole URL.
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) & 0xffffffff;
  return 'u' + (h >>> 0).toString(36);
}
