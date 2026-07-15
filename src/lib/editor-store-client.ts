import { IPC } from '../../shared/ipc';
import type {
  EditorStoreRecord,
  EditorStoreStatus,
  EditorStoreChange,
} from '../../shared/types';
import { invoke, on } from './ipc-client';

/**
 * Renderer-side client for the e-Editor persistent store.
 *
 * This is the stable API the editor calls. It is resilient by design:
 *  - Works even if the main-process handlers aren't registered yet (every
 *    IPC call is wrapped in try/catch).
 *  - Always keeps a synchronous `localStorage` cache so reads are instant and
 *    the editor keeps working offline / when Postgres is unavailable.
 */

const LOCAL_STATUS: EditorStoreStatus = {
  connected: false,
  backend: 'local',
  reason: 'unavailable',
};

function readLocal<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / serialization error — ignore, cache is best-effort */
  }
}

/** Current backend connection status. Falls back to `local` on any error. */
export async function getStatus(): Promise<EditorStoreStatus> {
  try {
    const status = (await invoke(IPC.EDITOR_STORE_GET_STATUS)) as EditorStoreStatus | undefined;
    return status ?? LOCAL_STATUS;
  } catch {
    return LOCAL_STATUS;
  }
}

/**
 * Read a value by key.
 *
 * Returns the Postgres-backed record's value when available; otherwise falls
 * back to the `localStorage` cache (JSON-parsed). Never throws.
 */
export async function getItem<T>(key: string): Promise<T | null> {
  try {
    const record = (await invoke(IPC.EDITOR_STORE_GET, key)) as EditorStoreRecord | null;
    if (record && record.value !== undefined && record.value !== null) {
      return record.value as T;
    }
  } catch {
    /* fall through to local cache */
  }
  return readLocal<T>(key);
}

/**
 * Write a value by key.
 *
 * ALWAYS writes the `localStorage` cache synchronously first (instant + offline
 * durable), then fires the IPC write to persist to Postgres when connected.
 * IPC errors are swallowed.
 */
export async function setItem(key: string, value: unknown): Promise<void> {
  writeLocal(key, value);
  try {
    await invoke(IPC.EDITOR_STORE_SET, key, value);
  } catch {
    /* offline / handlers not registered — local cache already has it */
  }
}

/**
 * Delete a value by key. Removes the local cache entry and asks the backend to
 * delete it too. Never throws.
 */
export async function removeItem(key: string): Promise<void> {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  try {
    await invoke(IPC.EDITOR_STORE_DELETE, key);
  } catch {
    /* ignore */
  }
}

/**
 * List records, optionally filtered by key prefix. Backend-only (the local
 * cache is not enumerated). Returns an empty array on any error.
 */
export async function list(prefix?: string): Promise<EditorStoreRecord[]> {
  try {
    const records = (await invoke(IPC.EDITOR_STORE_LIST, prefix)) as EditorStoreRecord[] | undefined;
    return records ?? [];
  } catch {
    return [];
  }
}

/**
 * Subscribe to cross-device change notifications (another device wrote a key).
 * Returns an unsubscribe function.
 */
export function subscribe(cb: (change: EditorStoreChange) => void): () => void {
  return on<[EditorStoreChange]>(IPC.EDITOR_STORE_CHANGED, (change) => {
    cb(change);
  });
}

/**
 * Subscribe to backend connection-status changes (postgres ↔ local).
 * Returns an unsubscribe function.
 */
export function onStatus(cb: (status: EditorStoreStatus) => void): () => void {
  return on<[EditorStoreStatus]>(IPC.EDITOR_STORE_STATUS, (status) => {
    cb(status);
  });
}
