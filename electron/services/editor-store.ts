import os from 'os';
import { Pool, Client } from 'pg';
import { IPC } from '../../shared/ipc';
import type {
  EditorStoreRecord,
  EditorStoreStatus,
  ArchivedChat,
  ArchivedChatSummary,
  ChatMessage,
} from '../../shared/types';
import { broadcastToRenderer } from '../utils/broadcast';
import { getLogger } from './logger';
import { loadAppSettings } from './app-settings';

const log = getLogger('editor-store');

const NOTIFY_CHANNEL = 'editor_store_changed';

/** Stable identifier for this device, stored alongside each row for provenance. */
const DEVICE_ID = os.hostname() || 'unknown-device';

/**
 * Resolve the Postgres connection string.
 *
 * Priority:
 *   1. `process.env.PILOT_EDITOR_PG_URL`
 *   2. An optional `editorStore.url` field on app settings — read defensively
 *      (the field is NOT part of the settings schema / shared types, so we do
 *      not rely on it existing).
 *
 * Returns `undefined` when nothing is configured (→ local-only mode).
 */
function resolveConnectionString(): string | undefined {
  const fromEnv = process.env.PILOT_EDITOR_PG_URL?.trim();
  if (fromEnv) return fromEnv;

  try {
    const settings = loadAppSettings() as unknown as Record<string, unknown>;
    const editorStore = settings.editorStore as
      | { url?: unknown; connectionString?: unknown }
      | undefined;
    const candidate =
      (typeof editorStore?.url === 'string' && editorStore.url) ||
      (typeof editorStore?.connectionString === 'string' &&
        editorStore.connectionString) ||
      undefined;
    if (candidate && candidate.trim()) return candidate.trim();
  } catch (err) {
    log.warn('Failed reading app settings for editorStore config', { err: String(err) });
  }

  return undefined;
}

interface StoreRow {
  key: string;
  value: unknown;
  updated_at: string | number;
}

interface ChatRow {
  id: string;
  service: string;
  title: string;
  model: string | null;
  source_url?: string | null;
  message_count: number;
  messages?: ChatMessage[];
  created_at: number | null;
  imported_at: number;
}

function rowToRecord(row: StoreRow): EditorStoreRecord {
  return {
    key: row.key,
    value: row.value,
    updatedAt: typeof row.updated_at === 'string' ? Number(row.updated_at) : row.updated_at,
  };
}

/**
 * Singleton Postgres-backed store for the e-Editor with cross-device sync.
 *
 * Design goals:
 *  - NEVER throw to callers. Every public method catches, logs, and degrades.
 *  - When unconfigured or when Postgres is unreachable, report a `local`
 *    status so the renderer can fall back to `localStorage`.
 */
class EditorStoreService {
  private pool: Pool | null = null;
  private listenClient: Client | null = null;
  private status: EditorStoreStatus = {
    connected: false,
    backend: 'local',
    reason: 'not initialized',
  };
  private initialized = false;
  private connectionString: string | undefined;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  /**
   * Connect (if configured) and ensure the schema. Safe to call once at
   * startup; never throws.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.connectionString = resolveConnectionString();
    if (!this.connectionString) {
      this.setStatus({ connected: false, backend: 'local', reason: 'not configured' });
      log.info('No Postgres connection configured — running in local-only mode');
      return;
    }

    try {
      this.pool = new Pool({ connectionString: this.connectionString });
      // Surface pool-level errors without crashing the process.
      this.pool.on('error', (err) => {
        log.error('Postgres pool error', { err: String(err) });
        this.setStatus({
          connected: false,
          backend: 'local',
          reason: 'connection error',
        });
      });

      await this.pool.query(
        `CREATE TABLE IF NOT EXISTS editor_store (
           key text PRIMARY KEY,
           value jsonb NOT NULL,
           updated_at bigint NOT NULL,
           device text
         )`,
      );

      // Chat archive — imported AI conversations live in Postgres (never in app
      // session state), read/edited from the e-Editor. `messages` is the full
      // normalized conversation; light columns are indexed for the list view.
      await this.pool.query(
        `CREATE TABLE IF NOT EXISTS chat_archive (
           id text PRIMARY KEY,
           service text NOT NULL,
           title text NOT NULL,
           model text,
           source_url text,
           message_count int NOT NULL DEFAULT 0,
           messages jsonb NOT NULL,
           created_at bigint,
           imported_at bigint NOT NULL
         )`,
      );
      await this.pool.query(
        `CREATE INDEX IF NOT EXISTS chat_archive_service_idx ON chat_archive (service, imported_at DESC)`,
      );

      this.setStatus({ connected: true, backend: 'postgres' });
      log.info('Connected to Postgres editor store');

      // Start the LISTEN client for cross-device change notifications.
      await this.startListener();
    } catch (err) {
      log.error('Failed to initialize Postgres editor store', { err: String(err) });
      this.pool = null;
      this.setStatus({
        connected: false,
        backend: 'local',
        reason: 'connection failed',
      });
    }
  }

  getStatus(): EditorStoreStatus {
    return this.status;
  }

  async get(key: string): Promise<EditorStoreRecord | null> {
    if (!this.pool) return null;
    try {
      const res = await this.pool.query<StoreRow>(
        'SELECT key, value, updated_at FROM editor_store WHERE key = $1',
        [key],
      );
      if (res.rows.length === 0) return null;
      return rowToRecord(res.rows[0]);
    } catch (err) {
      log.error('get() failed', { key, err: String(err) });
      return null;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    if (!this.pool) return;
    const updatedAt = Date.now();
    try {
      await this.pool.query(
        `INSERT INTO editor_store (key, value, updated_at, device)
         VALUES ($1, $2::jsonb, $3, $4)
         ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value,
                       updated_at = EXCLUDED.updated_at,
                       device = EXCLUDED.device`,
        [key, JSON.stringify(value ?? null), updatedAt, DEVICE_ID],
      );
      // Notify other devices. The payload (key) can't be a bind param in a
      // NOTIFY statement, so use pg_notify() with the key as a bind param.
      await this.pool.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, key]);
    } catch (err) {
      log.error('set() failed', { key, err: String(err) });
    }
  }

  async list(prefix?: string): Promise<EditorStoreRecord[]> {
    if (!this.pool) return [];
    try {
      if (prefix) {
        // Escape LIKE metacharacters in the prefix so it's treated literally.
        const escaped = prefix.replace(/([\\%_])/g, '\\$1');
        const res = await this.pool.query<StoreRow>(
          `SELECT key, value, updated_at FROM editor_store
           WHERE key LIKE $1 ESCAPE '\\' ORDER BY key`,
          [`${escaped}%`],
        );
        return res.rows.map(rowToRecord);
      }
      const res = await this.pool.query<StoreRow>(
        'SELECT key, value, updated_at FROM editor_store ORDER BY key',
      );
      return res.rows.map(rowToRecord);
    } catch (err) {
      log.error('list() failed', { prefix, err: String(err) });
      return [];
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query('DELETE FROM editor_store WHERE key = $1', [key]);
      await this.pool.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, key]);
    } catch (err) {
      log.error('delete() failed', { key, err: String(err) });
    }
  }

  // ── Chat archive ────────────────────────────────────────────────────
  // Imported conversations. Returns false/[] gracefully when Postgres is
  // unconfigured (the capture layer can then hold them locally / warn).

  async archiveChat(rec: ArchivedChat): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.query(
        `INSERT INTO chat_archive (id, service, title, model, source_url, message_count, messages, created_at, imported_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title, model = EXCLUDED.model, source_url = EXCLUDED.source_url,
           message_count = EXCLUDED.message_count, messages = EXCLUDED.messages,
           created_at = EXCLUDED.created_at, imported_at = EXCLUDED.imported_at`,
        [rec.id, rec.service, rec.title, rec.model ?? null, rec.sourceUrl ?? null,
         rec.messages.length, JSON.stringify(rec.messages), rec.createdAt ?? null, rec.importedAt],
      );
      await this.pool.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, 'chat_archive']);
      return true;
    } catch (err) {
      log.error('archiveChat() failed', { id: rec.id, err: String(err) });
      return false;
    }
  }

  /** Lightweight list (no message bodies) for the library view. */
  async listChats(service?: string): Promise<ArchivedChatSummary[]> {
    if (!this.pool) return [];
    try {
      const res = service
        ? await this.pool.query<ChatRow>(
            `SELECT id, service, title, model, message_count, created_at, imported_at
             FROM chat_archive WHERE service = $1 ORDER BY imported_at DESC`, [service])
        : await this.pool.query<ChatRow>(
            `SELECT id, service, title, model, message_count, created_at, imported_at
             FROM chat_archive ORDER BY imported_at DESC`);
      return res.rows.map((r) => ({
        id: r.id, service: r.service, title: r.title, model: r.model,
        messageCount: r.message_count, createdAt: r.created_at, importedAt: r.imported_at,
      }));
    } catch (err) {
      log.error('listChats() failed', { err: String(err) });
      return [];
    }
  }

  /** Full conversation including message bodies. */
  async getChat(id: string): Promise<ArchivedChat | null> {
    if (!this.pool) return null;
    try {
      const res = await this.pool.query<ChatRow>(
        `SELECT id, service, title, model, source_url, message_count, messages, created_at, imported_at
         FROM chat_archive WHERE id = $1`, [id]);
      const r = res.rows[0];
      if (!r) return null;
      return {
        id: r.id, service: r.service as ArchivedChat['service'], title: r.title, model: r.model, sourceUrl: r.source_url,
        messages: r.messages ?? [], createdAt: r.created_at, importedAt: r.imported_at,
      };
    } catch (err) {
      log.error('getChat() failed', { id, err: String(err) });
      return null;
    }
  }

  async deleteChat(id: string): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query('DELETE FROM chat_archive WHERE id = $1', [id]);
      await this.pool.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, 'chat_archive']);
    } catch (err) {
      log.error('deleteChat() failed', { id, err: String(err) });
    }
  }

  /** Dispose pool + listener (best-effort). Not required by callers. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await this.listenClient?.end();
    } catch { /* ignore */ }
    this.listenClient = null;
    try {
      await this.pool?.end();
    } catch { /* ignore */ }
    this.pool = null;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private setStatus(status: EditorStoreStatus): void {
    this.status = status;
    try {
      broadcastToRenderer(IPC.EDITOR_STORE_STATUS, status);
    } catch (err) {
      log.warn('Failed to broadcast status', { err: String(err) });
    }
  }

  /**
   * Open a dedicated long-lived client that LISTENs for change notifications
   * and rebroadcasts them to the renderer. Reconnects with a simple backoff.
   */
  private async startListener(): Promise<void> {
    if (this.disposed || !this.connectionString) return;
    try {
      const client = new Client({ connectionString: this.connectionString });
      client.on('error', (err) => {
        log.warn('LISTEN client error', { err: String(err) });
        this.scheduleListenerReconnect();
      });
      client.on('end', () => {
        if (!this.disposed) this.scheduleListenerReconnect();
      });
      client.on('notification', (msg) => {
        if (msg.channel !== NOTIFY_CHANNEL) return;
        const key = msg.payload ?? '';
        try {
          broadcastToRenderer(IPC.EDITOR_STORE_CHANGED, {
            key,
            updatedAt: Date.now(),
          });
        } catch (err) {
          log.warn('Failed to broadcast change', { err: String(err) });
        }
      });

      await client.connect();
      await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
      this.listenClient = client;
      log.info('Listening for editor_store_changed notifications');
    } catch (err) {
      log.warn('Failed to start LISTEN client', { err: String(err) });
      this.scheduleListenerReconnect();
    }
  }

  private scheduleListenerReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    // Tear down the old client before retrying.
    const stale = this.listenClient;
    this.listenClient = null;
    if (stale) {
      stale.removeAllListeners();
      stale.end().catch(() => { /* ignore */ });
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.startListener();
    }, 3000);
  }
}

let instance: EditorStoreService | null = null;

/** Get the singleton editor-store service. */
export function getEditorStore(): EditorStoreService {
  if (!instance) instance = new EditorStoreService();
  return instance;
}

export type { EditorStoreService };
