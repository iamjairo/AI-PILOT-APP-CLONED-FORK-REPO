/**
 * @file Chat export pipeline for the Chat Exporter tab.
 *
 * Ports the Chrome extension's export behaviour (PopupPanel options +
 * geminiPreview print + index.css One-Dark code colors) to the desktop app:
 *
 *   - toMarkdown  — Turndown the sanitized message HTML into `## User` / `## Assistant`
 *                   sections with fenced code blocks preserved.
 *   - toHtml      — a standalone, self-styled HTML document (dark/light + One-Dark
 *                   code), reused for both HTML export and the PDF print path.
 *   - printPdf    — render toHtml into a hidden iframe and window.print() it with an
 *                   A4 print stylesheet (mirrors the e-Editor Docs reader print flow).
 *   - downloadZip — JSZip bundle: the md/html file + scripts/ (code blocks) +
 *                   attachments/ (fetched URLs / decoded data URLs).
 *
 * SECURITY BOUNDARY: `ChatMessage.html` was sanitized in the main process before it
 * ever reached the renderer (see shared/types.ts — "Sanitized HTML body"). Both the
 * preview pane and these exporters treat it as trusted display HTML. We only strip
 * code blocks here for the `includeCode: false` option, never for safety.
 */
import JSZip from 'jszip';
import TurndownService from 'turndown';
import type { ArchivedChat, ChatExportOptions, ChatMessage } from '../../../shared/types';

// ─── Role labelling ───────────────────────────────────────────────────────
const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  tool: 'Tool',
};

function roleLabel(role: ChatMessage['role']): string {
  return ROLE_LABEL[role] ?? role;
}

// ─── Small string helpers ─────────────────────────────────────────────────
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Turn a title into a filesystem-safe slug for download filenames. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'conversation';
}

/** Map a code-block language hint to a sensible file extension for scripts/. */
function extForLang(lang?: string): string {
  const l = (lang ?? '').toLowerCase();
  const map: Record<string, string> = {
    js: 'js', javascript: 'js', jsx: 'jsx',
    ts: 'ts', typescript: 'ts', tsx: 'tsx',
    py: 'py', python: 'py',
    rb: 'rb', ruby: 'rb',
    go: 'go', rust: 'rs', rs: 'rs',
    java: 'java', kotlin: 'kt', swift: 'swift',
    c: 'c', cpp: 'cpp', 'c++': 'cpp', cs: 'cs', csharp: 'cs',
    php: 'php', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh',
    sql: 'sql', json: 'json', yaml: 'yaml', yml: 'yaml',
    html: 'html', css: 'css', scss: 'scss',
    md: 'md', markdown: 'md', xml: 'xml',
  };
  return map[l] ?? 'txt';
}

// ─── Code-block stripping (for includeCode: false) ────────────────────────
/**
 * Remove <pre> code blocks from a sanitized HTML fragment. Uses DOMParser when
 * available (renderer), falling back to a permissive regex otherwise.
 */
function stripCodeHtml(html: string): string {
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('pre').forEach((el) => el.remove());
      return doc.body.innerHTML;
    } catch {
      /* fall through to regex */
    }
  }
  return html.replace(/<pre[\s\S]*?<\/pre>/gi, '');
}

/** Remove fenced code blocks from a Markdown string. */
function stripCodeMarkdown(md: string): string {
  return md.replace(/```[\s\S]*?```/g, '_[code block omitted]_');
}

// ─── Markdown ─────────────────────────────────────────────────────────────
function newTurndown(): TurndownService {
  return new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
}

/**
 * Convert a conversation to Markdown. Roles become `## User` / `## Assistant`
 * headings; message HTML is run through Turndown so fenced code survives.
 */
export function toMarkdown(chat: ArchivedChat, opts: ChatExportOptions): string {
  const td = newTurndown();
  const out: string[] = [];

  out.push(`# ${chat.title || 'Conversation'}`, '');
  const meta: string[] = [`Service: ${chat.service}`];
  if (chat.model) meta.push(`Model: ${chat.model}`);
  if (chat.sourceUrl) meta.push(`Source: ${chat.sourceUrl}`);
  out.push(`> ${meta.join(' · ')}`, '');

  for (const msg of chat.messages) {
    out.push(`## ${roleLabel(msg.role)}`, '');
    let body = '';
    if (msg.html) {
      const html = opts.includeCode ? msg.html : stripCodeHtml(msg.html);
      body = td.turndown(html).trim();
    } else if (msg.text) {
      body = msg.text.trim();
    }
    if (!opts.includeCode) body = stripCodeMarkdown(body);
    out.push(body, '');
  }

  return out.join('\n');
}

// ─── Standalone HTML document (reused for HTML export + PDF) ───────────────
/** One-Dark syntax token colors, ported from the extension's index.css. */
function syntaxCss(): string {
  return `
  .chat-doc .hljs-comment,.chat-doc .hljs-quote{color:#7f848e;font-style:italic}
  .chat-doc .hljs-keyword,.chat-doc .hljs-selector-tag,.chat-doc .hljs-built_in,
  .chat-doc .hljs-section,.chat-doc .hljs-doctag{color:#c678dd}
  .chat-doc .hljs-string,.chat-doc .hljs-attr,.chat-doc .hljs-regexp,
  .chat-doc .hljs-addition,.chat-doc .hljs-meta-string{color:#98c379}
  .chat-doc .hljs-number,.chat-doc .hljs-literal,.chat-doc .hljs-type,
  .chat-doc .hljs-selector-class{color:#d19a66}
  .chat-doc .hljs-title,.chat-doc .hljs-title.function_,
  .chat-doc .hljs-function .hljs-title,.chat-doc .hljs-selector-id{color:#61afef}
  .chat-doc .hljs-variable,.chat-doc .hljs-name,.chat-doc .hljs-attribute,
  .chat-doc .hljs-tag,.chat-doc .hljs-deletion{color:#e06c75}
  .chat-doc .hljs-symbol,.chat-doc .hljs-bullet,.chat-doc .hljs-link,
  .chat-doc .hljs-meta{color:#56b6c2}
  .chat-doc .hljs-emphasis{font-style:italic}
  .chat-doc .hljs-strong{font-weight:600}`;
}

/** Full stylesheet for a standalone exported document. */
function documentCss(opts: ChatExportOptions): string {
  const dark = opts.theme === 'dark';
  const pageBg = dark ? '#131314' : '#ffffff';
  const text = dark ? '#e3e3e3' : '#1a1d2e';
  const muted = dark ? '#9aa0ac' : '#6b7280';
  const border = dark ? '#282a2c' : '#e5e7eb';
  const userBubble = dark ? '#1e1f20' : '#f1f5f9';
  const tableBorder = dark ? '#444746' : '#cbd5e1';

  // Code always renders on a dark One-Dark surface so tokens stay legible and
  // print consistently (matches the extension's index.css behaviour).
  const codeColor = opts.syntaxColors ? '#e6e6e6' : (dark ? '#e6e6e6' : '#e6e6e6');

  return `
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0}
  body{background:${pageBg};color:${text};
    font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
    -webkit-font-smoothing:antialiased;line-height:1.6}
  .chat-doc{max-width:820px;margin:0 auto;padding:40px 32px 64px}
  .chat-doc header{border-bottom:1px solid ${border};padding-bottom:16px;margin-bottom:28px}
  .chat-doc h1.doc-title{font-size:24px;font-weight:600;letter-spacing:-.01em;margin:0}
  .chat-doc .doc-meta{color:${muted};font-size:13px;margin-top:8px}
  .chat-msg{margin-bottom:28px}
  .chat-role{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
    color:${muted};margin-bottom:8px}
  .chat-msg.role-user .chat-bubble{background:${userBubble};border-radius:14px;
    border-top-right-radius:4px;padding:14px 18px}
  .chat-msg.role-assistant .chat-bubble{background:transparent;padding:2px 0}
  .chat-content p{margin:0 0 1rem}
  .chat-content p:last-child{margin-bottom:0}
  .chat-content ul{list-style:disc;margin:0 0 1rem;padding-left:1.5rem}
  .chat-content ol{list-style:decimal;margin:0 0 1rem;padding-left:1.5rem}
  .chat-content li{margin-bottom:.5rem}
  .chat-content h1,.chat-content h2,.chat-content h3{font-weight:600;margin:1.5rem 0 .75rem}
  .chat-content h2{font-size:1.25rem}
  .chat-content table{border-collapse:collapse;width:100%;margin:1rem 0}
  .chat-content th,.chat-content td{padding:.5rem 1rem;text-align:left;border:1px solid ${tableBorder}}
  .chat-content pre{background:#1e1f20;border:1px solid #303236;color:${codeColor};
    padding:1rem;border-radius:.5rem;margin:1.25rem 0;overflow-x:auto}
  .chat-content pre code{color:${codeColor};background:transparent;
    font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:.9em}
  .chat-content :not(pre)>code{background:rgba(127,127,127,.16);padding:.1em .35em;
    border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
  .chat-content img{max-width:100%;height:auto}
  .chat-attachments{margin-top:10px;font-size:12px;color:${muted}}
  .chat-attachments a{color:#61afef;text-decoration:underline}
  ${opts.syntaxColors ? syntaxCss() : ''}
  @media print{
    *{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important}
    @page{size:A4;margin:18mm}
    body{background:${pageBg} !important}
    .chat-content pre{white-space:pre-wrap !important;overflow-wrap:anywhere !important;
      overflow-x:visible !important}
    .chat-content img,.chat-content tr{page-break-inside:avoid;break-inside:avoid}
    .chat-content h1,.chat-content h2,.chat-content h3{page-break-after:avoid;break-after:avoid}
  }`;
}

/** Render one message's inner content (respecting includeCode). */
function renderMessageContent(msg: ChatMessage, opts: ChatExportOptions): string {
  let inner = '';
  if (msg.html) {
    inner = opts.includeCode ? msg.html : stripCodeHtml(msg.html);
  } else if (msg.text) {
    inner = `<p>${escapeHtml(msg.text).replace(/\n/g, '<br>')}</p>`;
  }

  let attachments = '';
  if (opts.downloadAttachments && msg.attachments && msg.attachments.length > 0) {
    const items = msg.attachments
      .map((a) => `<a href="${escapeHtml(a.url)}">${escapeHtml(a.name)}</a>`)
      .join(', ');
    attachments = `<div class="chat-attachments">Attachments: ${items}</div>`;
  }

  return `<div class="chat-content">${inner}</div>${attachments}`;
}

/**
 * Build a standalone, self-styled HTML document for the conversation.
 * Reused verbatim by both the HTML export and the PDF print path.
 */
export function toHtml(chat: ArchivedChat, opts: ChatExportOptions): string {
  const rows = chat.messages
    .map((msg) => {
      const role = msg.role === 'user' ? 'user' : 'assistant';
      return `<section class="chat-msg role-${role}">
        <div class="chat-role">${roleLabel(msg.role)}</div>
        <div class="chat-bubble">${renderMessageContent(msg, opts)}</div>
      </section>`;
    })
    .join('\n');

  const metaParts: string[] = [`${chat.service}`];
  if (chat.model) metaParts.push(chat.model);
  metaParts.push(`Exported ${new Date().toLocaleDateString()}`);

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(chat.title || 'Conversation')}</title>
<style>${documentCss(opts)}</style>
</head><body class="theme-${opts.theme}">
<main class="chat-doc">
  <header>
    <h1 class="doc-title">${escapeHtml(chat.title || 'Conversation')}</h1>
    <div class="doc-meta">${escapeHtml(metaParts.join(' · '))}</div>
  </header>
  ${rows}
</main>
</body></html>`;
}

// ─── PDF (print a hidden iframe) ───────────────────────────────────────────
/**
 * Render the conversation into a hidden iframe and invoke the browser print
 * dialog with an A4 print stylesheet. Mirrors the e-Editor Docs reader's
 * approach but isolates the print target inside its own document so nothing
 * from the app chrome bleeds into the PDF.
 */
export function printPdf(chat: ArchivedChat, opts: ChatExportOptions): Promise<void> {
  return new Promise((resolve) => {
    const html = toHtml(chat, { ...opts, format: 'pdf' });
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(iframe);

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      // Delay removal so the print job can capture the document first.
      setTimeout(() => {
        iframe.remove();
        resolve();
      }, 500);
    };

    iframe.onload = () => {
      const win = iframe.contentWindow;
      if (!win) {
        cleanup();
        return;
      }
      win.addEventListener('afterprint', cleanup);
      // Fallback in case afterprint never fires (some Electron builds).
      setTimeout(cleanup, 60_000);
      try {
        win.focus();
        win.print();
      } catch {
        cleanup();
      }
    };

    iframe.srcdoc = html;
  });
}

// ─── ZIP bundle ────────────────────────────────────────────────────────────
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Collect every code block across the conversation for the scripts/ folder. */
function collectCodeBlocks(chat: ArchivedChat): { name: string; code: string }[] {
  const files: { name: string; code: string }[] = [];
  chat.messages.forEach((msg, mi) => {
    (msg.codeBlocks ?? []).forEach((block, bi) => {
      const ext = extForLang(block.lang);
      files.push({ name: `message-${mi + 1}-block-${bi + 1}.${ext}`, code: block.code });
    });
  });
  return files;
}

/**
 * Add a single conversation's files into a JSZip folder (or the root when
 * `folder` is empty): the md/html document + optional scripts/ + attachments/.
 */
async function addChatToZip(
  root: JSZip,
  chat: ArchivedChat,
  opts: ChatExportOptions,
  folder: string,
): Promise<void> {
  const dir = folder ? root.folder(folder) : root;
  if (!dir) return;

  // Main document — markdown when requested, HTML for html/pdf formats.
  if (opts.format === 'markdown') {
    dir.file(`${slugify(chat.title)}.md`, toMarkdown(chat, opts));
  } else {
    dir.file(`${slugify(chat.title)}.html`, toHtml(chat, opts));
  }

  // scripts/ — one file per fenced code block.
  if (opts.downloadScripts) {
    const scripts = collectCodeBlocks(chat);
    if (scripts.length > 0) {
      const scriptsDir = dir.folder('scripts');
      if (scriptsDir) {
        for (const s of scripts) scriptsDir.file(s.name, s.code);
      }
    }
  }

  // attachments/ — fetch remote URLs / decode data: URLs into binary files.
  if (opts.downloadAttachments) {
    const attachmentsDir = dir.folder('attachments');
    if (attachmentsDir) {
      let counter = 0;
      for (const msg of chat.messages) {
        for (const att of msg.attachments ?? []) {
          counter += 1;
          try {
            const res = await fetch(att.url);
            const buf = await res.arrayBuffer();
            const safeName = att.name?.replace(/[^\w.\-]+/g, '_') || `attachment-${counter}`;
            attachmentsDir.file(safeName, buf);
          } catch {
            // Skip attachments that fail to fetch (revoked URL, CORS, etc.)
          }
        }
      }
    }
  }
}

/** Export a single conversation as a downloaded ZIP bundle. */
export async function downloadZip(chat: ArchivedChat, opts: ChatExportOptions): Promise<void> {
  const zip = new JSZip();
  await addChatToZip(zip, chat, opts, '');
  const blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(blob, `${slugify(chat.title)}.zip`);
}

/** Export several conversations as one ZIP, each in its own folder. */
export async function downloadSelectedZip(
  chats: ArchivedChat[],
  opts: ChatExportOptions,
): Promise<void> {
  const zip = new JSZip();
  for (let i = 0; i < chats.length; i += 1) {
    const chat = chats[i];
    await addChatToZip(zip, chat, opts, `${String(i + 1).padStart(2, '0')}-${slugify(chat.title)}`);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(blob, `chat-export-${Date.now()}.zip`);
}

/**
 * High-level single-chat export orchestrator used by the UI's "Export" button.
 *   - pdf  → print dialog (A4)
 *   - md / html with scripts or attachments → ZIP bundle
 *   - md / html otherwise → single-file download
 */
export async function exportChat(chat: ArchivedChat, opts: ChatExportOptions): Promise<void> {
  if (opts.format === 'pdf') {
    await printPdf(chat, opts);
    return;
  }
  if (opts.downloadScripts || opts.downloadAttachments) {
    await downloadZip(chat, opts);
    return;
  }
  if (opts.format === 'markdown') {
    triggerDownload(new Blob([toMarkdown(chat, opts)], { type: 'text/markdown' }), `${slugify(chat.title)}.md`);
  } else {
    triggerDownload(new Blob([toHtml(chat, opts)], { type: 'text/html' }), `${slugify(chat.title)}.html`);
  }
}
