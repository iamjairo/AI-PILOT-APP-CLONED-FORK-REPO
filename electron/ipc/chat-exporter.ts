/**
 * @file Chat Exporter IPC handlers.
 *
 * Wires the renderer's Chat Exporter module to the main-process capture engine
 * (chat-capture.ts) and the Postgres archive (editor-store.ts). Every handler
 * degrades gracefully — the capture engine never throws out to IPC, and import
 * progress is streamed to the renderer via `broadcastToRenderer`.
 *
 * The caller wires `registerChatExporterIpc(() => mainWindow)` from the main
 * bootstrap; this file does NOT touch `electron/main/index.ts`.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc';
import type {
  ChatService,
  ChatServiceInfo,
  RemoteChatSummary,
  ArchivedChat,
  ArchivedChatSummary,
  ChatCaptureProgress,
} from '../../shared/types';
import { getEditorStore } from '../services/editor-store';
import { broadcastToRenderer } from '../utils/broadcast';
import { getLogger } from '../services/logger';
import {
  listServices,
  openLogin,
  listRemote,
  importChats,
} from '../services/chat-capture';

const log = getLogger('chat-exporter-ipc');

const VALID_SERVICES = new Set<ChatService>([
  'chatgpt', 'claude', 'gemini', 'deepseek', 'lechat', 'qwen',
]);

function asService(value: unknown): ChatService | null {
  return typeof value === 'string' && VALID_SERVICES.has(value as ChatService)
    ? (value as ChatService)
    : null;
}

/**
 * Register all Chat Exporter IPC channels.
 *
 * @param _getWindow accessor for the focused main window. Reserved for future
 *   window-targeted messaging; progress is broadcast to all renderers.
 */
export function registerChatExporterIpc(_getWindow: () => BrowserWindow | null): void {
  // Ensure the archive store is initialized (idempotent; never throws).
  try {
    void getEditorStore().init();
  } catch (err) {
    log.warn('editor-store init failed', { err: String(err) });
  }

  // List services + connected state.
  ipcMain.handle(IPC.CHAT_SERVICES, async (): Promise<ChatServiceInfo[]> => {
    try {
      return await listServices();
    } catch (err) {
      log.error('CHAT_SERVICES failed', { err: String(err) });
      return [];
    }
  });

  // Open a login webview for a service, then return updated connected state.
  ipcMain.handle(IPC.CHAT_LOGIN, async (_e, serviceArg: unknown): Promise<ChatServiceInfo[]> => {
    const service = asService(serviceArg);
    if (!service) {
      log.warn('CHAT_LOGIN invalid service', { serviceArg });
      return listServices().catch(() => []);
    }
    try {
      await openLogin(service);
    } catch (err) {
      log.error('CHAT_LOGIN failed', { service, err: String(err) });
    }
    // Return the refreshed service list so the renderer sees new connected dots.
    return listServices().catch(() => []);
  });

  // List the user's conversations on a service.
  ipcMain.handle(IPC.CHAT_LIST_REMOTE, async (_e, serviceArg: unknown): Promise<RemoteChatSummary[]> => {
    const service = asService(serviceArg);
    if (!service) return [];
    try {
      return await listRemote(service);
    } catch (err) {
      log.error('CHAT_LIST_REMOTE failed', { service, err: String(err) });
      return [];
    }
  });

  // Import selected conversations → Postgres archive, streaming progress.
  ipcMain.handle(IPC.CHAT_IMPORT, async (_e, payload: unknown): Promise<ArchivedChat[]> => {
    const p = (payload ?? {}) as { service?: unknown; ids?: unknown };
    const service = asService(p.service);
    const ids = Array.isArray(p.ids) ? p.ids.filter((x): x is string => typeof x === 'string') : [];
    if (!service) {
      log.warn('CHAT_IMPORT invalid service', { payload });
      return [];
    }
    try {
      return await importChats(service, ids, (progress: ChatCaptureProgress) => {
        broadcastToRenderer(IPC.CHAT_CAPTURE_PROGRESS, progress);
      });
    } catch (err) {
      log.error('CHAT_IMPORT failed', { service, err: String(err) });
      broadcastToRenderer(IPC.CHAT_CAPTURE_PROGRESS, {
        service,
        phase: 'error',
        message: String(err instanceof Error ? err.message : err),
      } satisfies ChatCaptureProgress);
      return [];
    }
  });

  // ── Archive (read/delete from Postgres) ────────────────────────────────
  ipcMain.handle(IPC.CHAT_ARCHIVE_LIST, async (_e, serviceArg?: unknown): Promise<ArchivedChatSummary[]> => {
    const service = asService(serviceArg);
    try {
      return await getEditorStore().listChats(service ?? undefined);
    } catch (err) {
      log.error('CHAT_ARCHIVE_LIST failed', { err: String(err) });
      return [];
    }
  });

  ipcMain.handle(IPC.CHAT_ARCHIVE_GET, async (_e, idArg: unknown): Promise<ArchivedChat | null> => {
    if (typeof idArg !== 'string') return null;
    try {
      return await getEditorStore().getChat(idArg);
    } catch (err) {
      log.error('CHAT_ARCHIVE_GET failed', { err: String(err) });
      return null;
    }
  });

  ipcMain.handle(IPC.CHAT_ARCHIVE_DELETE, async (_e, idArg: unknown): Promise<boolean> => {
    if (typeof idArg !== 'string') return false;
    try {
      await getEditorStore().deleteChat(idArg);
      return true;
    } catch (err) {
      log.error('CHAT_ARCHIVE_DELETE failed', { err: String(err) });
      return false;
    }
  });
}
