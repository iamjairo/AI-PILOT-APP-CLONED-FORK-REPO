/**
 * @file Popup controller (bundled to dist/popup.js).
 *
 * Loads/saves options to chrome.storage.sync, shows the detected service for
 * the active tab, and sends `{action:'EXPORT'}` to the content script. Live
 * status is relayed from the content script via `{action:'STATUS'}`.
 */
import { SERVICE_LABEL } from './adapter';
import { DEFAULT_OPTIONS, loadOptions, saveOptions } from './storage';
import type { ChatService, ExtensionExportOptions, ExtensionFormat } from './types';

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const els = {
  serviceValue: $('service-value'),
  format: $<HTMLSelectElement>('format'),
  theme: $<HTMLSelectElement>('theme'),
  includeCode: $<HTMLInputElement>('includeCode'),
  syntaxColors: $<HTMLInputElement>('syntaxColors'),
  downloadScripts: $<HTMLInputElement>('downloadScripts'),
  downloadAttachments: $<HTMLInputElement>('downloadAttachments'),
  zipOnly: $('zip-only'),
  exportBtn: $<HTMLButtonElement>('export-btn'),
  status: $('status'),
  hint: $('hint'),
  optionsLink: $('options-link'),
};

let activeTabId: number | null = null;
let detectedService: ChatService | null = null;

function readForm(): ExtensionExportOptions {
  return {
    format: els.format.value as ExtensionFormat,
    theme: els.theme.value as 'dark' | 'light',
    includeCode: els.includeCode.checked,
    syntaxColors: els.syntaxColors.checked,
    downloadScripts: els.downloadScripts.checked,
    downloadAttachments: els.downloadAttachments.checked,
  };
}

function writeForm(opts: ExtensionExportOptions): void {
  els.format.value = opts.format;
  els.theme.value = opts.theme;
  els.includeCode.checked = opts.includeCode;
  els.syntaxColors.checked = opts.syntaxColors;
  els.downloadScripts.checked = opts.downloadScripts;
  els.downloadAttachments.checked = opts.downloadAttachments;
}

function setStatus(text: string, kind: '' | 'error' | 'done' = ''): void {
  els.status.textContent = text;
  els.status.className = `status${kind ? ' ' + kind : ''}`;
}

async function persist(): Promise<void> {
  await saveOptions(readForm());
}

function bindPersist(): void {
  [
    els.format,
    els.theme,
    els.includeCode,
    els.syntaxColors,
    els.downloadScripts,
    els.downloadAttachments,
  ].forEach((el) => el.addEventListener('change', () => void persist()));
}

async function detectActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  if (activeTabId == null) {
    showUnsupported();
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(activeTabId, { action: 'DETECT' });
    detectedService = (res && res.service) || null;
  } catch {
    detectedService = null; // no content script on this tab
  }
  if (detectedService) {
    els.serviceValue.textContent = SERVICE_LABEL[detectedService];
    els.serviceValue.className = 'value';
    els.exportBtn.disabled = false;
    els.hint.hidden = true;
  } else {
    showUnsupported();
  }
}

function showUnsupported(): void {
  els.serviceValue.textContent = 'Unsupported tab';
  els.serviceValue.className = 'value unsupported';
  els.exportBtn.disabled = true;
  els.hint.hidden = false;
  setStatus('');
}

async function onExport(): Promise<void> {
  if (activeTabId == null || !detectedService) return;
  await persist();
  els.exportBtn.disabled = true;
  setStatus('Starting export…');
  try {
    const res = await chrome.tabs.sendMessage(activeTabId, { action: 'EXPORT', options: readForm() });
    if (res && res.ok) {
      setStatus('Export complete.', 'done');
    } else {
      setStatus(`Export failed: ${(res && res.error) || 'unknown error'}`, 'error');
    }
  } catch (e) {
    setStatus(`Could not reach the page: ${String((e as Error).message || e)}`, 'error');
  } finally {
    els.exportBtn.disabled = false;
  }
}

// Live status relayed from the content script during a long scrape.
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.action === 'STATUS' && message.status) {
    const s = message.status;
    const kind = s.phase === 'error' ? 'error' : s.phase === 'done' ? 'done' : '';
    setStatus(s.message, kind);
  }
});

async function init(): Promise<void> {
  writeForm(await loadOptions().catch(() => DEFAULT_OPTIONS));
  bindPersist();
  els.exportBtn.addEventListener('click', () => void onExport());
  els.optionsLink.addEventListener('click', () => chrome.runtime.openOptionsPage());
  await detectActiveTab();
}

void init();
