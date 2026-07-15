import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc';
import { getEditorStore } from '../services/editor-store';

/**
 * Wire up the e-Editor persistent store IPC handlers.
 *
 * Initializes the singleton service (connects to Postgres if configured,
 * otherwise stays in local-only mode) and registers the five renderer→main
 * invoke channels. The service never throws, so handlers degrade gracefully.
 *
 * The caller is responsible for invoking this from the main process bootstrap;
 * it does NOT touch `electron/main/index.ts`.
 */
export function registerEditorStoreIpc(): void {
  const store = getEditorStore();

  // Kick off connection + schema setup. Fire-and-forget: init() never throws
  // and broadcasts its own status when ready.
  void store.init();

  ipcMain.handle(IPC.EDITOR_STORE_GET, async (_event, key: string) => {
    return store.get(key);
  });

  ipcMain.handle(IPC.EDITOR_STORE_SET, async (_event, key: string, value: unknown) => {
    await store.set(key, value);
  });

  ipcMain.handle(IPC.EDITOR_STORE_LIST, async (_event, prefix?: string) => {
    return store.list(prefix);
  });

  ipcMain.handle(IPC.EDITOR_STORE_DELETE, async (_event, key: string) => {
    await store.delete(key);
  });

  ipcMain.handle(IPC.EDITOR_STORE_GET_STATUS, async () => {
    return store.getStatus();
  });
}
