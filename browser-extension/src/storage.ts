/**
 * @file chrome.storage.sync helpers + defaults shared by popup, options and
 * the content script.
 */
import type { ExtensionExportOptions } from './types';

export const DEFAULT_OPTIONS: ExtensionExportOptions = {
  format: 'markdown',
  theme: 'dark',
  includeCode: true,
  syntaxColors: true,
  downloadScripts: false,
  downloadAttachments: false,
};

export interface NasSyncSettings {
  nasSyncEnabled: boolean;
  nasEndpoint: string;
}

export const DEFAULT_NAS: NasSyncSettings = {
  nasSyncEnabled: false,
  nasEndpoint: '',
};

const OPTIONS_KEY = 'exportOptions';

/** Read the saved export options (merged over defaults). */
export async function loadOptions(): Promise<ExtensionExportOptions> {
  const stored = await chrome.storage.sync.get(OPTIONS_KEY);
  return { ...DEFAULT_OPTIONS, ...(stored[OPTIONS_KEY] || {}) };
}

/** Persist export options. */
export async function saveOptions(opts: ExtensionExportOptions): Promise<void> {
  await chrome.storage.sync.set({ [OPTIONS_KEY]: opts });
}

/** Read the optional NAS-sync settings (merged over defaults). */
export async function loadNasSettings(): Promise<NasSyncSettings> {
  const stored = await chrome.storage.sync.get(['nasSyncEnabled', 'nasEndpoint']);
  return {
    nasSyncEnabled: Boolean(stored.nasSyncEnabled),
    nasEndpoint: typeof stored.nasEndpoint === 'string' ? stored.nasEndpoint : '',
  };
}

/** Persist NAS-sync settings. */
export async function saveNasSettings(settings: NasSyncSettings): Promise<void> {
  await chrome.storage.sync.set(settings);
}
