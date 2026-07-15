/**
 * @file External Language-Server scaffold (Phase-1 SEAM — inert by default).
 *
 * Phase 1 of the editor's "LSP-class" intelligence uses Monaco's BUILT-IN
 * language services (TS/JS/JSON/CSS/HTML) which run entirely in-process via the
 * bundled web-workers — no external process, no network. That covers the app's
 * own TypeScript/React codebase with completion, hover, signature help,
 * diagnostics, go-to-definition, rename, format and document symbols.
 *
 * Phase 2 (NOT wired here) adds real external language servers for languages
 * Monaco can't type on its own — python (pyright / pylsp), rust (rust-analyzer),
 * go (gopls), etc. This module is the clean seam where that plugs in. It ships
 * ONLY types + inert stubs: no runtime dependency, no npm install, and it is
 * gated OFF behind an env flag so nothing changes at runtime today.
 *
 * ── How Phase 2 will wire up (design notes, not yet implemented) ─────────────
 *
 *   renderer (this process)                         main / electron process
 *   ─────────────────────────                       ───────────────────────────
 *   monaco-languageclient  ◀── JSON-RPC over ──▶    child_process.spawn(server)
 *     + vscode-languageserver-protocol                (e.g. `pyright-langserver
 *     + a MessageTransport bridged                     --stdio`, `rust-analyzer`,
 *       across an IPC channel                          `gopls`)
 *
 *   1. Add an IPC pair (e.g. IPC.LSP_START / IPC.LSP_STDIN / IPC.LSP_STDOUT) so
 *      the main process owns the child process lifecycle and streams its stdio.
 *      The renderer never spawns processes directly (keeps the CSP/attack
 *      surface unchanged).
 *   2. In the renderer, install `monaco-languageclient` + `vscode-ws-jsonrpc`
 *      (or a custom `MessageTransports`) and point its reader/writer at the IPC
 *      channel from step 1. `MonacoLanguageClient` then registers all LSP
 *      feature providers (completion, hover, definition, rename, diagnostics,
 *      document symbols, …) for the server's `documentSelector`.
 *   3. `initializeExternalLsp()` reads `EXTERNAL_LSP_SERVERS` (or project
 *      settings), and for each ENABLED, INSTALLED server calls
 *      `startExternalLspClient(config)`.
 *
 * Everything below is typed so the Phase-2 increment can implement the bodies
 * without reshaping call sites, and the Outline panel / breadcrumbs / palette
 * actions built in Phase 1 will light up automatically for those languages
 * (they read from whatever providers are registered — built-in or external).
 */

/** Transport used to reach a spawned language server. Phase 2 uses `ipc`. */
export type ExternalLspTransport = 'ipc' | 'stdio' | 'socket';

/** Declarative description of one external language server. */
export interface ExternalLspServerConfig {
  /** Stable id, e.g. `'pyright'`, `'rust-analyzer'`, `'gopls'`. */
  readonly id: string;
  /** Monaco language ids this server serves, e.g. `['python']`. */
  readonly languageIds: readonly string[];
  /** Executable to spawn in the MAIN process (never the renderer). */
  readonly command: string;
  /** Arguments passed to the executable, e.g. `['--stdio']`. */
  readonly args?: readonly string[];
  /** How the renderer reaches the server. Phase 2 default: `'ipc'`. */
  readonly transport?: ExternalLspTransport;
  /** Off by default — a server only starts when explicitly enabled. */
  readonly enabled?: boolean;
}

/** Handle returned by a started client so callers can tear it down. */
export interface ExternalLspClient {
  readonly config: ExternalLspServerConfig;
  readonly languageIds: readonly string[];
  dispose(): void;
}

/**
 * Master gate. Off unless `VITE_ENABLE_EXTERNAL_LSP=true` (or, later, a project
 * setting) is present at build/runtime. Read defensively so this stays typed
 * without depending on `vite/client` ambient types.
 */
export function isExternalLspEnabled(): boolean {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_ENABLE_EXTERNAL_LSP === 'true';
}

/**
 * Default server catalogue for Phase 2. Present as data so the UI/settings can
 * surface them, but every entry is `enabled: false` — nothing runs today.
 */
export const EXTERNAL_LSP_SERVERS: readonly ExternalLspServerConfig[] = [
  { id: 'pyright', languageIds: ['python'], command: 'pyright-langserver', args: ['--stdio'], transport: 'ipc', enabled: false },
  { id: 'rust-analyzer', languageIds: ['rust'], command: 'rust-analyzer', transport: 'ipc', enabled: false },
  { id: 'gopls', languageIds: ['go'], command: 'gopls', args: ['serve'], transport: 'ipc', enabled: false },
];

/**
 * Phase-2 hook: start one language client. Inert stub for now.
 * @throws never in Phase 1 — returns `null` because the gate is off.
 */
export function startExternalLspClient(_config: ExternalLspServerConfig): ExternalLspClient | null {
  // Phase 2: construct a MonacoLanguageClient bound to an IPC MessageTransport
  // that bridges to the main-process child_process. See the file header.
  return null;
}

/**
 * Phase-1 entry point, called from monaco-setup after the built-in language
 * defaults are configured. No-op unless the gate is enabled AND a Phase-2
 * implementation of {@link startExternalLspClient} exists.
 */
export function initializeExternalLsp(): ExternalLspClient[] {
  if (!isExternalLspEnabled()) return [];
  const clients: ExternalLspClient[] = [];
  for (const config of EXTERNAL_LSP_SERVERS) {
    if (!config.enabled) continue;
    const client = startExternalLspClient(config);
    if (client) clients.push(client);
  }
  return clients;
}
