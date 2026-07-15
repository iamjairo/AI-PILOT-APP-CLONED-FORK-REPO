/**
 * @file Options controller (bundled to dist/options.js).
 *
 * Manages the optional "Sync to NAS" settings in chrome.storage.sync. Both the
 * toggle and endpoint default OFF / empty.
 */
import { DEFAULT_NAS, loadNasSettings, saveNasSettings } from './storage';

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const enabledEl = $<HTMLInputElement>('nasSyncEnabled');
const endpointEl = $<HTMLInputElement>('nasEndpoint');
const saveBtn = $<HTMLButtonElement>('save-btn');
const savedMsg = $('saved-msg');

function syncDisabledState(): void {
  endpointEl.disabled = !enabledEl.checked;
}

async function init(): Promise<void> {
  const settings = await loadNasSettings().catch(() => DEFAULT_NAS);
  enabledEl.checked = settings.nasSyncEnabled;
  endpointEl.value = settings.nasEndpoint;
  syncDisabledState();

  enabledEl.addEventListener('change', syncDisabledState);

  saveBtn.addEventListener('click', async () => {
    await saveNasSettings({
      nasSyncEnabled: enabledEl.checked,
      nasEndpoint: endpointEl.value.trim(),
    });
    savedMsg.classList.add('show');
    setTimeout(() => savedMsg.classList.remove('show'), 1500);
  });
}

void init();
