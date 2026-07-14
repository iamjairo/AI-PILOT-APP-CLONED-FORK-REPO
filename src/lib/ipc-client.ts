import { IPC } from '../../shared/ipc';
import { deriveExternalBackendStatus, type ExternalBackendStatus } from './external-backend-status';
import { shouldUseLocalElectronTransport } from './ipc-routing';
import { resolveRemoteBackendConfig } from './remote-backend';

/** Delay before attempting WebSocket reconnection after disconnect */
const WS_RECONNECT_DELAY_MS = 2000;
/** Maximum time to wait for an IPC invoke response before timing out */
const WS_INVOKE_TIMEOUT_MS = 30_000;
const AUTH_TOKEN_STORAGE_KEY = 'companion-auth-token';
const WS_URL_STORAGE_KEY = 'companion-ws-url';

// ─── Universal IPC Transport ───────────────────────────────────────────────
// Provides the same API whether running in Electron (preload bridge) or
// in a browser / WKWebView via companion WebSocket.

/** Set once during init — survives window.api being polyfilled */
let _companionMode = false;
let _externalBackendMode = false;
let _remoteBackendHttpUrl: string | null = null;
let _externalBackendStorageScope = 'default';
const externalBackendStatusListeners = new Set<(status: ExternalBackendStatus) => void>();

/**
 * Detect whether we're running in companion (browser) mode.
 * In Electron, the preload script exposes `window.api` before any JS runs.
 * In companion mode (browser / WKWebView), `window.api` doesn't exist at load time.
 */
export function isCompanionMode(): boolean {
  return _companionMode;
}

/** True when IPC should go through a remote WebSocket backend instead of local Electron IPC */
export function isExternalBackendMode(): boolean {
  return _externalBackendMode;
}

/** Whether the companion WebSocket client has a valid auth token */
export function isExternalBackendConnected(): boolean {
  return getExternalBackendStatus().state === 'connected';
}

export function getRemoteBackendHttpUrl(): string | null {
  return _remoteBackendHttpUrl;
}

export function getExternalBackendStatus(): ExternalBackendStatus {
  return deriveExternalBackendStatus({
    enabled: _externalBackendMode,
    isCompanion: _companionMode,
    hasToken: Boolean(getStoredAuthToken()),
    httpUrl: _remoteBackendHttpUrl,
    authenticated: companionClient?.isAuthenticated() ?? false,
  });
}

export function subscribeExternalBackendStatus(listener: (status: ExternalBackendStatus) => void): () => void {
  externalBackendStatusListeners.add(listener);
  listener(getExternalBackendStatus());
  return () => {
    externalBackendStatusListeners.delete(listener);
  };
}

export function resetExternalBackendSession(): void {
  clearStoredExternalBackendAuth();
  companionClient?.dispose();
  companionClient = null;
  notifyExternalBackendStatus();
}

export function setExternalBackendTarget(remoteBackendUrl: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  const nextUrl = new URL(window.location.href);
  if (remoteBackendUrl) {
    nextUrl.searchParams.set('remoteBackendUrl', remoteBackendUrl);
  } else {
    nextUrl.searchParams.delete('remoteBackendUrl');
  }
  nextUrl.searchParams.delete('remoteBackendWsUrl');
  window.history.replaceState({}, '', nextUrl);
  initCompanionPolyfill();
}

export function storeExternalBackendAuthToken(token: string): void {
  setStoredExternalBackendValue(AUTH_TOKEN_STORAGE_KEY, token);
  notifyExternalBackendStatus();
}

function notifyExternalBackendStatus(): void {
  const status = getExternalBackendStatus();
  for (const listener of externalBackendStatusListeners) {
    listener(status);
  }
}

// ─── WebSocket IPC Client ──────────────────────────────────────────────────

interface PendingInvoke {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * WebSocketIPCClient provides window.api-compatible invoke/on/send methods
 * over a WebSocket connection to the Pilot Companion server.
 */
class WebSocketIPCClient {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private authToken: string;
  private pending = new Map<string, PendingInvoke>();
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  private authenticated = false;
  private authPromise: Promise<void> | null = null;
  private authResolve: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private onStateChange: () => void;
  private onInvalidToken: () => void;

  constructor(wsUrl: string, authToken: string, onStateChange: () => void, onInvalidToken: () => void) {
    this.wsUrl = wsUrl;
    this.authToken = authToken;
    this.onStateChange = onStateChange;
    this.onInvalidToken = onInvalidToken;
    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;

    this.authenticated = false;
    this.authPromise = new Promise<void>((resolve) => {
      this.authResolve = resolve;
    });

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch { /* Expected: WebSocket connection may fail during reconnect */
      this.onStateChange();
      this.scheduleReconnect();
      return;
    }
    this.onStateChange();

    this.ws.onopen = () => {
      // Send auth message immediately on connect
      this.ws!.send(JSON.stringify({ type: 'auth', token: this.authToken }));
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        this.handleMessage(msg);
      } catch { /* Expected: malformed WebSocket message */
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.authenticated = false;
      // Reject all pending invocations
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('WebSocket disconnected'));
      }
      this.pending.clear();
      this.onStateChange();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'auth_ok':
        this.authenticated = true;
        // Ensure token is persisted for future sessions (covers migration
        // from sessionStorage and any edge cases where localStorage was cleared).
        setStoredExternalBackendValue(AUTH_TOKEN_STORAGE_KEY, this.authToken);
        this.authResolve?.();
        this.onStateChange();
        break;

      case 'auth_error':
        console.error('[CompanionIPC] Auth failed:', msg.reason);
        if (msg.reason === 'Invalid token') {
          // Token was revoked server-side — clear stored credential and stop
          // reconnecting. User will see the pairing screen on next load.
          clearStoredExternalBackendAuth();
          this.authResolve?.();
          this.onInvalidToken();
          break;
        }
        // For transient errors (timeout, malformed message), don't clear the
        // token — the reconnect loop will retry with the same credential.
        this.authResolve?.(); // unblock but leave authenticated=false
        this.onStateChange();
        break;

      case 'ipc-response': {
        const pending = this.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }
        break;
      }

      case 'event': {
        const callbacks = this.listeners.get(msg.channel);
        if (callbacks) {
          for (const cb of callbacks) {
            try {
              cb(msg.payload);
            } catch (e) {
              console.error('[CompanionIPC] Event listener error:', e);
            }
          }
        }
        break;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, WS_RECONNECT_DELAY_MS);
  }

  private generateId(): string {
    return crypto.randomUUID();
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    // Wait for authentication to complete
    if (!this.authenticated && this.authPromise) {
      await this.authPromise;
    }
    if (!this.authenticated) {
      throw new Error('Not authenticated to companion server');
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const id = this.generateId();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC invoke timeout: ${channel}`));
      }, WS_INVOKE_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      this.ws!.send(JSON.stringify({
        type: 'ipc',
        id,
        channel,
        args,
      }));
    });
  }

  on(channel: string, listener: (...args: any[]) => void): () => void {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
    }
    this.listeners.get(channel)!.add(listener);

    // Return unsubscribe function
    return () => {
      const set = this.listeners.get(channel);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(channel);
      }
    };
  }

  send(channel: string, ...args: unknown[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = this.generateId();
    this.ws.send(JSON.stringify({
      type: 'ipc',
      id,
      channel,
      args,
    }));
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Client disposed'));
    }
    this.pending.clear();
    this.listeners.clear();
    this.ws?.close();
    this.ws = null;
    this.authenticated = false;
    this.onStateChange();
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }
}

// ─── Companion Mode Polyfill ───────────────────────────────────────────────

let companionClient: WebSocketIPCClient | null = null;

/**
 * Initialize the companion mode polyfill.
 * Call this BEFORE the React app mounts if running in companion mode.
 * It creates a window.api-compatible shim backed by WebSocket.
 *
 * Always creates window.api in companion mode (even without auth token)
 * so that all React components can render. IPC calls will fail gracefully
 * until the user pairs and a valid token is stored.
 */
export function initCompanionPolyfill(): void {
  const remoteBackendConfig = resolveRemoteBackendConfig(
    typeof window !== 'undefined' ? window.location.search : ''
  );

  // On first call, detect companion mode before window.api gets polyfilled.
  // On subsequent calls (after pairing), _companionMode is already true.
  if (!_companionMode) {
    _companionMode = typeof window !== 'undefined' && !window.api;
  }
  _externalBackendMode = _companionMode || remoteBackendConfig.enabled;
  _remoteBackendHttpUrl = remoteBackendConfig.httpUrl;
  _externalBackendStorageScope = getExternalBackendStorageScope(remoteBackendConfig.httpUrl, _companionMode);
  if (!_externalBackendMode) {
    notifyExternalBackendStatus();
    return;
  }

  // Derive WebSocket URL from current page location (same host:port, wss)
  const wsUrl = remoteBackendConfig.wsUrl
    || getStoredExternalBackendValue(WS_URL_STORAGE_KEY)
    || `wss://${location.hostname}:${location.port}/`;
  // Check localStorage first (persistent), fall back to sessionStorage (legacy/migration).
  // If found only in sessionStorage, migrate to localStorage so it survives tab close.
  const authToken = getStoredAuthToken();

  // Connect WebSocket if we have a non-empty auth token
  if (authToken) {
    companionClient?.dispose();
    companionClient = new WebSocketIPCClient(
      wsUrl,
      authToken,
      notifyExternalBackendStatus,
      () => {
        companionClient?.dispose();
        companionClient = null;
        notifyExternalBackendStatus();
      }
    );
  } else {
    companionClient?.dispose();
    companionClient = null;
    console.warn('[CompanionIPC] No auth token — showing pairing screen');
  }
  notifyExternalBackendStatus();

  const notConnected = () => Promise.reject(new Error('Not connected — pair this device first'));

  if (_companionMode) {
    // Polyfill window.api so all existing code works unchanged in browser companion mode.
    // If no WS client, invoke/send reject gracefully instead of crashing.
    (window as any).api = {
      platform: detectPlatform(),
      invoke: companionClient
        ? (channel: string, ...args: unknown[]) => companionClient!.invoke(channel, ...args)
        : (_channel: string, ..._args: unknown[]) => notConnected(),
      on: companionClient
        ? (channel: string, listener: (...args: any[]) => void) => companionClient!.on(channel, listener)
        : (_channel: string, _listener: (...args: any[]) => void) => () => {},
      send: companionClient
        ? (channel: string, ...args: unknown[]) => companionClient!.send(channel, ...args)
        : () => {},
      // Window controls are no-ops in companion mode
      windowMinimize: async () => {},
      windowMaximize: async () => {},
      windowClose: async () => {},
      windowIsMaximized: async () => false,
      onWindowMaximizedChanged: () => () => {},
      openExternal: async (url: string) => { window.open(url, '_blank'); },
    };
  }
}

function getStoredAuthToken(): string | null {
  return getStoredExternalBackendValue(AUTH_TOKEN_STORAGE_KEY);
}

function clearStoredExternalBackendAuth(): void {
  clearStoredExternalBackendValue(AUTH_TOKEN_STORAGE_KEY);
  clearStoredExternalBackendValue(WS_URL_STORAGE_KEY);
}

function getExternalBackendStorageScope(httpUrl: string | null, companionMode: boolean): string {
  const scopeSource = httpUrl || (companionMode && typeof window !== 'undefined' ? window.location.origin : 'default');
  return encodeURIComponent(scopeSource.replace(/\/+$/, ''));
}

function getScopedStorageKey(baseKey: string): string {
  return `${baseKey}:${_externalBackendStorageScope}`;
}

function getStoredExternalBackendValue(baseKey: string): string | null {
  const scopedKey = getScopedStorageKey(baseKey);
  let value = localStorage.getItem(scopedKey);
  if (!value) {
    value = sessionStorage.getItem(scopedKey);
    if (value) {
      try { localStorage.setItem(scopedKey, value); } catch { /* quota */ }
      sessionStorage.removeItem(scopedKey);
    }
  }
  if (value) return value;

  const legacyLocalValue = localStorage.getItem(baseKey);
  if (legacyLocalValue) {
    setStoredExternalBackendValue(baseKey, legacyLocalValue);
    localStorage.removeItem(baseKey);
    return legacyLocalValue;
  }

  const legacySessionValue = sessionStorage.getItem(baseKey);
  if (legacySessionValue) {
    setStoredExternalBackendValue(baseKey, legacySessionValue);
    sessionStorage.removeItem(baseKey);
    return legacySessionValue;
  }

  return null;
}

function setStoredExternalBackendValue(baseKey: string, value: string): void {
  try {
    localStorage.setItem(getScopedStorageKey(baseKey), value);
  } catch { /* quota */ }
}

function clearStoredExternalBackendValue(baseKey: string): void {
  localStorage.removeItem(getScopedStorageKey(baseKey));
  sessionStorage.removeItem(getScopedStorageKey(baseKey));
  localStorage.removeItem(baseKey);
  sessionStorage.removeItem(baseKey);
}

function detectPlatform(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Mac/.test(ua)) return 'darwin';
  if (/Win/.test(ua)) return 'win32';
  // Default to linux for non-Mac/Win platforms (BSD, ChromeOS, etc.)
  // This is the closest match for path handling and shell behavior
  return 'linux';
}

// ─── Canonical IPC entry points ────────────────────────────────────────────
// All renderer code should use these instead of window.api directly.
// They route through window.api, which is either the Electron preload bridge
// or the companion WebSocket polyfill — so they work in both modes.

/**
 * Request/response IPC call. Equivalent to ipcRenderer.invoke().
 * Use IPC constants from shared/ipc.ts for channel names.
 */
export function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  if (_externalBackendMode && !shouldUseLocalElectronTransport(channel, 'invoke')) {
    if (!companionClient) {
      return Promise.reject(new Error('Not connected — pair this device first'));
    }
    return companionClient.invoke(channel, ...args);
  }
  return window.api.invoke(channel, ...args);
}

/**
 * Listen for events from the main process.
 * Returns an unsubscribe function.
 *
 * The listener is generic over its argument tuple so that typed handlers
 * such as `(payload: MyPayload) => void` or `(a: string, b: string) => void`
 * are assignable without widening to `unknown[]` at every call site.
 */
export function on<Args extends unknown[] = unknown[]>(
  channel: string,
  listener: (...args: Args) => void,
): () => void;
export function on(channel: string, listener: (...args: unknown[]) => void): () => void {
  if (_externalBackendMode && !shouldUseLocalElectronTransport(channel, 'on')) {
    if (!companionClient) return () => {};
    return companionClient.on(channel, listener);
  }
  return window.api.on(channel, listener);
}

/**
 * Fire-and-forget IPC send. Equivalent to ipcRenderer.send().
 */
export function send(channel: string, ...args: unknown[]): void {
  if (_externalBackendMode && !shouldUseLocalElectronTransport(channel, 'send')) {
    companionClient?.send(channel, ...args);
    return;
  }
  window.api.send(channel, ...args);
}
