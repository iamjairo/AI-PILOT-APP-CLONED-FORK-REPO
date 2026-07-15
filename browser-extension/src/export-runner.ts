/**
 * @file Thin wrapper around the reused `chat-export.ts` orchestrator.
 *
 * `exportChat()` handles markdown / html / pdf (and auto-zips when scripts or
 * attachments are requested). The extension adds two formats on top without
 * touching the copied pipeline:
 *   - `json` → download the raw `ArchivedChat` as `<slug>.json`.
 *   - `zip`  → force a JSZip bundle (doc + scripts/ + attachments/).
 */
import type { ArchivedChat, ChatExportOptions, ExtensionExportOptions } from './types';
import { downloadZip, exportChat, slugify } from './chat-export';

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

/**
 * Run an export for the given options. Returns after the download/print has
 * been initiated.
 */
export async function runExport(chat: ArchivedChat, opts: ExtensionExportOptions): Promise<void> {
  if (opts.format === 'json') {
    const json = JSON.stringify(chat, null, 2);
    triggerDownload(new Blob([json], { type: 'application/json' }), `${slugify(chat.title)}.json`);
    return;
  }

  if (opts.format === 'zip') {
    // ZIP is the only format that bundles extra folders. The two checkboxes
    // (scripts / attachments) apply *here only*; if both are off the ZIP is
    // just the document.
    const zipOpts: ChatExportOptions = {
      format: 'markdown',
      includeCode: opts.includeCode,
      syntaxColors: opts.syntaxColors,
      theme: opts.theme,
      downloadScripts: opts.downloadScripts,
      downloadAttachments: opts.downloadAttachments,
    };
    await downloadZip(chat, zipOpts);
    return;
  }

  // markdown / html / pdf each produce exactly ONE artifact. The scripts /
  // attachments checkboxes are ZIP-only, so they are forced off here — picking
  // PDF must never also drop a loose .md or stray attachment files.
  const baseOpts: ChatExportOptions = {
    format: opts.format,
    includeCode: opts.includeCode,
    syntaxColors: opts.syntaxColors,
    theme: opts.theme,
    downloadScripts: false,
    downloadAttachments: false,
  };
  await exportChat(chat, baseOpts);
}
