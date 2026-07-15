/**
 * @file Minimal type surface for the browser extension.
 *
 * Copied (verbatim shapes) from the AI-Pilot Electron app's `shared/types.ts`
 * so the reused `chat-export.ts` render pipeline compiles unchanged. Keeping a
 * local copy keeps the extension self-contained (no imports outside
 * `browser-extension/`).
 */

/** The six supported chat services. */
export type ChatService = 'chatgpt' | 'claude' | 'gemini' | 'deepseek' | 'lechat' | 'qwen';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** Sanitized HTML body (code blocks, math markers preserved). */
  html?: string;
  /** Plain-text / markdown-ish fallback. */
  text?: string;
  /** Extracted fenced code blocks, for "download scripts". `name` is the
   *  real filename captured from the code-block header when available. */
  codeBlocks?: { lang?: string; code: string; name?: string }[];
  /** Attachment references (name + data URL or remote URL). */
  attachments?: { name: string; url: string; mime?: string }[];
  createdAt?: number;
}

/** Full imported conversation. */
export interface ArchivedChat {
  id: string;
  service: ChatService;
  title: string;
  model?: string | null;
  sourceUrl?: string | null;
  messages: ChatMessage[];
  createdAt?: number | null;
  importedAt: number;
}

/** Export options (ported from the extension's export settings). */
export interface ChatExportOptions {
  format: 'markdown' | 'pdf' | 'html';
  includeCode: boolean;
  syntaxColors: boolean;
  downloadScripts: boolean;
  downloadAttachments: boolean;
  theme: 'dark' | 'light';
}

/** Extension-only export formats layered on top of {@link ChatExportOptions}. */
export type ExtensionFormat = 'markdown' | 'html' | 'pdf' | 'json' | 'zip';

export interface ExtensionExportOptions {
  format: ExtensionFormat;
  includeCode: boolean;
  syntaxColors: boolean;
  downloadScripts: boolean;
  downloadAttachments: boolean;
  theme: 'dark' | 'light';
}

/** A file/download card captured from an assistant message's DOM. */
export interface ScrapedAttachment {
  name: string;
  /** Resolved URL — a base64 data URL when the bytes were fetched, else the
   *  original href (kept so the filename is still recorded). */
  url: string;
  /** true when the underlying bytes were successfully fetched. */
  fetched: boolean;
}

/** Shape every injected `scrape()` resolves to (from chat-scrapers.ts). */
export interface ScrapeResult {
  title: string;
  messages: {
    role: 'user' | 'model';
    htmlContent: string;
    /** Inline generated-file download cards (assistant messages only). */
    attachments?: ScrapedAttachment[];
  }[];
  platform: string;
  error?: string;
}
