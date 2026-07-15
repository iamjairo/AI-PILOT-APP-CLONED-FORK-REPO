/**
 * @file Bridges the scraper output to the render pipeline.
 *
 * `runScrape()` returns `{ title, messages: [{role:'user'|'model', htmlContent}] }`,
 * but the reused `chat-export.ts` expects an `ArchivedChat` whose messages use
 * role `'user'|'assistant'` with an `html` field. This adapter:
 *   - maps `'model'` → `'assistant'`, `htmlContent` → `html`,
 *   - detects the `service` from the hostname,
 *   - derives `codeBlocks` from each message's `<pre><code>` (lang from a
 *     `language-*` class) so the ZIP `scripts/` folder is populated.
 */
import type { ArchivedChat, ChatMessage, ChatService, ScrapeResult } from './types';

/** Map a hostname to a supported service, or null when unsupported. */
export function detectService(hostname: string): ChatService | null {
  const h = hostname.toLowerCase();
  if (h === 'chatgpt.com' || h === 'chat.openai.com') return 'chatgpt';
  if (h === 'claude.ai') return 'claude';
  if (h === 'gemini.google.com') return 'gemini';
  if (h === 'chat.deepseek.com') return 'deepseek';
  if (h === 'chat.mistral.ai') return 'lechat';
  if (h === 'chat.qwen.ai') return 'qwen';
  return null;
}

/** Human-facing service label for the popup. */
export const SERVICE_LABEL: Record<ChatService, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  lechat: 'Le Chat (Mistral)',
  qwen: 'Qwen',
};

/**
 * Filename pattern — a basename plus a known code/file extension. Kept broad
 * but anchored so prose like "see file.ts below" doesn't match a whole phrase
 * (each whitespace-split token is tested individually).
 */
const FILENAME_RE =
  /^[\w.\-/]+\.(sh|bash|zsh|py|js|jsx|ts|tsx|mjs|cjs|json|ya?ml|zip|tar|gz|md|txt|conf|cfg|ini|env|toml|pl|rb|go|rs|sql|c|h|cpp|hpp|cc|cs|java|kt|swift|php|html?|css|scss|xml|sh|dockerfile|makefile|csv|tsv)$/i;

/** Pull the first filename-looking token out of a blob of header text. */
function firstFilenameToken(text: string): string | undefined {
  if (!text) return undefined;
  for (const token of text.split(/[\s|·•,]+/)) {
    const t = token.trim();
    if (t.length >= 3 && t.length <= 120 && FILENAME_RE.test(t)) return t;
  }
  return undefined;
}

/**
 * Best-effort: find the real filename a code block was labelled with. In
 * ChatGPT's DOM the `<pre>` sits in a rounded container whose header row shows
 * the language and, for named/canvas code, a filename. After sanitizing (copy
 * buttons removed) that header text survives, so we scan the `<pre>`'s own
 * leading text and the preceding sibling of it and its nearest ancestors.
 * Defensive — never throws, returns undefined when nothing matches.
 */
function findCodeBlockFilename(pre: Element): string | undefined {
  try {
    const seen: string[] = [];
    // The pre's own first child (some layouts put the header inside the pre).
    if (pre.firstElementChild) seen.push(pre.firstElementChild.textContent || '');
    // Walk up a few ancestors, checking each level's previous sibling (header).
    let node: Element | null = pre;
    for (let depth = 0; depth < 3 && node; depth += 1) {
      const prev = node.previousElementSibling;
      if (prev) seen.push(prev.textContent || '');
      node = node.parentElement;
    }
    for (const text of seen) {
      const name = firstFilenameToken(text);
      if (name) return name;
    }
  } catch {
    /* defensive: ignore and fall back to generated names */
  }
  return undefined;
}

/**
 * Parse `<pre><code>` blocks out of a sanitized HTML fragment into
 * `{ lang, code, name? }`, mirroring how the desktop app stored `codeBlocks`
 * but additionally capturing the real filename from the code-block header.
 * Uses the live DOMParser (available in the content script / popup document).
 */
export function deriveCodeBlocks(html: string): { lang?: string; code: string; name?: string }[] {
  const blocks: { lang?: string; code: string; name?: string }[] = [];
  if (typeof DOMParser === 'undefined') return blocks;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return blocks;
  }
  doc.querySelectorAll('pre').forEach((pre) => {
    const codeEl = pre.querySelector('code') || pre;
    const code = (codeEl.textContent || '').replace(/\n+$/, '');
    if (!code.trim()) return;
    let lang: string | undefined;
    // lang from a `language-xxx` / `lang-xxx` class on <code> or <pre>.
    const classSource = `${codeEl.className} ${pre.className}`;
    const m = classSource.match(/(?:language|lang)-([a-z0-9+#]+)/i);
    if (m) lang = m[1].toLowerCase();
    const name = findCodeBlockFilename(pre);
    blocks.push({ lang, code, name });
  });
  return blocks;
}

/**
 * Convert a `ScrapeResult` into an `ArchivedChat` the render pipeline consumes.
 */
export function toArchivedChat(result: ScrapeResult, service: ChatService, sourceUrl: string): ArchivedChat {
  const messages: ChatMessage[] = result.messages.map((m) => {
    const html = m.htmlContent;
    const role: ChatMessage['role'] = m.role === 'model' ? 'assistant' : 'user';
    const msg: ChatMessage = { role, html };
    // Only assistant messages contribute downloadable files: code blocks are
    // derived and generated-file cards are carried through. A user's own
    // message body must never be emitted as a separate file.
    if (role === 'assistant') {
      msg.codeBlocks = deriveCodeBlocks(html);
      if (m.attachments && m.attachments.length > 0) {
        msg.attachments = m.attachments.map((a) => ({ name: a.name, url: a.url }));
      }
    }
    return msg;
  });
  return {
    id: sourceUrl,
    service,
    title: result.title,
    model: null,
    sourceUrl,
    messages,
    createdAt: null,
    importedAt: Date.now(),
  };
}
