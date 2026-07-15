/**
 * @file Chat Exporter tab — connect AI chat services, import their conversations
 * into the Postgres-backed archive (via the main process), preview them, and
 * export to Markdown / PDF (A4) / HTML with optional code, scripts and attachments.
 *
 * Ports the Chrome extension's options + preview + export behaviour
 * (src/views/PopupPanel.jsx, src/views/geminiPreview.jsx, src/index.css) into the
 * AI-Pilot desktop shell, matching the e-Editor's dark inline-styled house look.
 *
 * The backend (login windows, remote listing, capture, Postgres archive) lives in
 * the main process behind the IPC channels below; this file is renderer-only UI.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Download, LogIn, ListChecks, RefreshCw, Trash2, Eye, FileDown, Settings2,
  CheckCircle2, Circle, Loader2, Database, X, MessageSquare,
} from 'lucide-react';
import { invoke, on } from '../../lib/ipc-client';
import { IPC } from '../../../shared/ipc';
import type {
  ChatService, ChatServiceInfo, RemoteChatSummary, ArchivedChat,
  ArchivedChatSummary, ChatExportOptions, ChatCaptureProgress,
} from '../../../shared/types';
import { exportChat, downloadSelectedZip } from './chat-export';

// ─── House palette (matches EEditor's dark skin) ──────────────────────────
const SK = {
  bg: '#0f1117',
  panel: '#12151e',
  tab: '#0d0f16',
  card: '#161a24',
  text: '#e7e9ee',
  muted: '#9aa0ac',
  brd: '#262a35',
  accent: '#4a9eff',
};

// Per-service accent dots for the library badges.
const SERVICE_COLOR: Record<string, string> = {
  chatgpt: '#10a37f',
  claude: '#d97757',
  gemini: '#4a9eff',
  deepseek: '#7c6cff',
  lechat: '#fc923c',
  qwen: '#a855f7',
};

const DEFAULT_OPTIONS: ChatExportOptions = {
  format: 'markdown',
  includeCode: true,
  syntaxColors: true,
  downloadScripts: false,
  downloadAttachments: false,
  theme: 'dark',
};

// Dropdown ordering — ChatGPT and Claude first (primary services with real web
// chat history), then the rest. Unknown ids fall to the end, keeping list order.
const PROVIDER_ORDER: ChatService[] = ['chatgpt', 'claude', 'gemini', 'deepseek', 'lechat', 'qwen'];

function providerRank(id: ChatService): number {
  const i = PROVIDER_ORDER.indexOf(id);
  return i === -1 ? PROVIDER_ORDER.length : i;
}

function serviceColor(service: string): string {
  return SERVICE_COLOR[service] ?? SK.accent;
}

// ─── Reusable inline-styled primitives ────────────────────────────────────
function Toggle({ on: isOn, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <label
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12, color: SK.text, cursor: 'pointer', padding: '5px 0' }}
    >
      <span>{label}</span>
      <span style={{ width: 34, height: 18, borderRadius: 10, background: isOn ? SK.accent : SK.brd, position: 'relative', flexShrink: 0, transition: 'background .15s' }}>
        <span style={{ position: 'absolute', top: 2, left: isOn ? 18 : 2, width: 14, height: 14, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
      </span>
    </label>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4, background: SK.tab, border: `0.5px solid ${SK.brd}`, borderRadius: 8, padding: 3 }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{ flex: 1, fontSize: 11, padding: '5px 8px', borderRadius: 6, border: 'none', cursor: 'pointer', background: value === o.value ? SK.accent : 'transparent', color: value === o.value ? '#08121f' : SK.muted, fontWeight: value === o.value ? 600 : 400 }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ChatExporter() {
  const [services, setServices] = useState<ChatServiceInfo[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);

  const [chosenProvider, setChosenProvider] = useState<ChatService | ''>('');
  const [activeService, setActiveService] = useState<ChatService | null>(null);
  const [remoteChats, setRemoteChats] = useState<RemoteChatSummary[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loginBusy, setLoginBusy] = useState<ChatService | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ChatCaptureProgress | null>(null);

  const [archives, setArchives] = useState<ArchivedChatSummary[]>([]);
  const [archivesLoading, setArchivesLoading] = useState(true);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const [preview, setPreview] = useState<ArchivedChat | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [centerView, setCenterView] = useState<'import' | 'preview'>('import');

  const [showOptions, setShowOptions] = useState(false);
  const [opts, setOpts] = useState<ChatExportOptions>(DEFAULT_OPTIONS);
  const [exportBusy, setExportBusy] = useState(false);

  // ─── Data loads ─────────────────────────────────────────────────────────
  const loadServices = useCallback(async () => {
    setServicesLoading(true);
    try {
      const list = (await invoke(IPC.CHAT_SERVICES)) as ChatServiceInfo[];
      setServices(list);
    } catch {
      setServices([]);
    } finally {
      setServicesLoading(false);
    }
  }, []);

  const loadArchives = useCallback(async () => {
    setArchivesLoading(true);
    setArchiveError(null);
    try {
      const list = (await invoke(IPC.CHAT_ARCHIVE_LIST)) as ArchivedChatSummary[];
      setArchives(list);
    } catch (err) {
      setArchives([]);
      setArchiveError(err instanceof Error ? err.message : 'Could not reach the archive backend.');
    } finally {
      setArchivesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadServices();
    void loadArchives();
  }, [loadServices, loadArchives]);

  // Live import progress pushed from the main process.
  useEffect(() => {
    const off = on<[ChatCaptureProgress]>(IPC.CHAT_CAPTURE_PROGRESS, (payload) => {
      setProgress(payload);
      if (payload.phase === 'done') {
        setImporting(false);
        void loadArchives();
        setTimeout(() => setProgress(null), 1500);
      } else if (payload.phase === 'error') {
        setImporting(false);
      }
    });
    return off;
  }, [loadArchives]);

  // ─── Service actions ──────────────────────────────────────────────────────
  const handleLogin = useCallback(async (id: ChatService) => {
    setLoginBusy(id);
    try {
      await invoke(IPC.CHAT_LOGIN, id);
    } catch {
      /* login window closed / failed — surfaced via refreshed connected state */
    } finally {
      setLoginBusy(null);
      void loadServices();
    }
  }, [loadServices]);

  const handleListRemote = useCallback(async (id: ChatService) => {
    setActiveService(id);
    setCenterView('import');
    setRemoteLoading(true);
    setRemoteChats([]);
    setSelectedIds(new Set());
    try {
      const list = (await invoke(IPC.CHAT_LIST_REMOTE, id)) as RemoteChatSummary[];
      setRemoteChats(list);
    } catch {
      setRemoteChats([]);
    } finally {
      setRemoteLoading(false);
    }
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => (prev.size === remoteChats.length ? new Set() : new Set(remoteChats.map((c) => c.id))));
  }, [remoteChats]);

  const handleImport = useCallback(async () => {
    if (!activeService || selectedIds.size === 0) return;
    setImporting(true);
    setProgress({ service: activeService, phase: 'importing', current: 0, total: selectedIds.size });
    try {
      await invoke(IPC.CHAT_IMPORT, { service: activeService, ids: Array.from(selectedIds) });
    } catch {
      setImporting(false);
    } finally {
      void loadArchives();
    }
  }, [activeService, selectedIds, loadArchives]);

  // ─── Archive actions ──────────────────────────────────────────────────────
  const handleOpen = useCallback(async (id: string) => {
    setPreviewLoading(true);
    setCenterView('preview');
    try {
      const chat = (await invoke(IPC.CHAT_ARCHIVE_GET, id)) as ArchivedChat | null;
      setPreview(chat);
    } catch {
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await invoke(IPC.CHAT_ARCHIVE_DELETE, id);
      setPreview((p) => (p?.id === id ? null : p));
    } finally {
      void loadArchives();
    }
  }, [loadArchives]);

  const handleExportArchive = useCallback(async (id: string) => {
    setExportBusy(true);
    try {
      const chat = (await invoke(IPC.CHAT_ARCHIVE_GET, id)) as ArchivedChat | null;
      if (chat) await exportChat(chat, opts);
    } catch {
      /* export failed — nothing persisted, safe to ignore */
    } finally {
      setExportBusy(false);
    }
  }, [opts]);

  const handleExportPreview = useCallback(async () => {
    if (!preview) return;
    setExportBusy(true);
    try {
      await exportChat(preview, opts);
    } finally {
      setExportBusy(false);
    }
  }, [preview, opts]);

  const setOpt = useCallback(<K extends keyof ChatExportOptions>(k: K, v: ChatExportOptions[K]) => {
    setOpts((o) => ({ ...o, [k]: v }));
  }, []);

  const connectedServices = useMemo(() => services.filter((s) => s.connected), [services]);
  const orderedServices = useMemo(
    () => [...services].sort((a, b) => providerRank(a.id) - providerRank(b.id)),
    [services],
  );
  const chosen = useMemo(
    () => services.find((s) => s.id === chosenProvider) ?? null,
    [services, chosenProvider],
  );
  const allSelected = remoteChats.length > 0 && selectedIds.size === remoteChats.length;

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', background: SK.bg, color: SK.text, fontFamily: 'var(--font-sans, system-ui)' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: SK.tab, borderBottom: `0.5px solid ${SK.brd}`, padding: '8px 12px', flexShrink: 0 }}>
        <Download size={16} style={{ color: SK.accent }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Chat Exporter</span>
        <span style={{ fontSize: 11, color: SK.muted, marginLeft: 4 }}>connect · import · export</span>
        <button
          onClick={() => setShowOptions((s) => !s)}
          title="Export options"
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '5px 10px', borderRadius: 6, border: `0.5px solid ${showOptions ? SK.accent : SK.brd}`, background: 'transparent', color: showOptions ? SK.text : SK.muted, cursor: 'pointer' }}
        >
          <Settings2 size={12} /> Export Options
        </button>
      </div>

      {/* Progress bar */}
      {progress && progress.phase !== 'done' && (
        <div style={{ padding: '8px 14px', background: SK.panel, borderBottom: `0.5px solid ${SK.brd}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: SK.muted, marginBottom: 6 }}>
            <Loader2 size={12} className="animate-spin" style={{ color: SK.accent }} />
            <span style={{ textTransform: 'capitalize', color: SK.text }}>{progress.phase}</span>
            {progress.message && <span>· {progress.message}</span>}
            {progress.total != null && (
              <span style={{ marginLeft: 'auto' }}>{progress.current ?? 0}/{progress.total}</span>
            )}
          </div>
          <div style={{ height: 4, borderRadius: 2, background: SK.tab, overflow: 'hidden' }}>
            <div style={{ height: '100%', background: SK.accent, width: progress.total ? `${Math.round(((progress.current ?? 0) / progress.total) * 100)}%` : '40%', transition: 'width .3s' }} />
          </div>
        </div>
      )}

      {/* Body: services | center (import/preview) | archive library */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '248px 1fr 316px', minHeight: 0 }}>

        {/* LEFT — provider picker */}
        <div style={{ borderRight: `0.5px solid ${SK.brd}`, overflowY: 'auto', padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <span style={{ fontSize: 11, letterSpacing: '.06em', color: SK.muted, textTransform: 'uppercase' }}>Provider</span>
            <button onClick={() => void loadServices()} title="Refresh" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: SK.muted, cursor: 'pointer', display: 'flex' }}>
              <RefreshCw size={12} />
            </button>
          </div>

          {servicesLoading && <div style={{ fontSize: 11, color: SK.muted }}>Loading providers…</div>}

          {!servicesLoading && (
            <select
              value={chosenProvider}
              onChange={(e) => setChosenProvider(e.target.value as ChatService | '')}
              style={{ width: '100%', marginBottom: 12, fontSize: 12, background: SK.tab, color: SK.text, border: `0.5px solid ${SK.brd}`, borderRadius: 6, padding: '6px 8px', cursor: 'pointer' }}
            >
              <option value="">Choose provider…</option>
              {orderedServices.map((svc) => (
                <option key={svc.id} value={svc.id}>
                  {svc.name}{svc.connected ? ' ✓' : ''}
                </option>
              ))}
            </select>
          )}

          {/* Inline connect / list state for the chosen provider */}
          {chosen && (
            <div style={{ background: SK.card, border: `0.5px solid ${SK.brd}`, borderRadius: 8, padding: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: serviceColor(chosen.id), flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 500 }}>{chosen.name}</span>
                <span title={chosen.connected ? 'Connected' : 'Not connected'} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: chosen.connected ? '#10b981' : SK.muted }}>
                  {chosen.connected ? <CheckCircle2 size={13} /> : <Circle size={13} />}
                  {chosen.connected ? 'Connected' : 'Not connected'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => void handleLogin(chosen.id)}
                  disabled={loginBusy === chosen.id}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, fontSize: 11, padding: '6px', borderRadius: 6, border: `0.5px solid ${SK.brd}`, background: 'transparent', color: SK.text, cursor: loginBusy === chosen.id ? 'default' : 'pointer', opacity: loginBusy === chosen.id ? 0.6 : 1 }}
                >
                  {loginBusy === chosen.id ? <Loader2 size={12} className="animate-spin" /> : <LogIn size={12} />}
                  {chosen.connected ? 'Re-login' : 'Login'}
                </button>
                <button
                  onClick={() => void handleListRemote(chosen.id)}
                  disabled={!chosen.connected}
                  title={chosen.connected ? 'List conversations' : 'Login first to list conversations'}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, fontSize: 11, padding: '6px', borderRadius: 6, border: 'none', background: !chosen.connected ? SK.brd : activeService === chosen.id ? SK.accent : SK.brd, color: !chosen.connected ? SK.muted : activeService === chosen.id ? '#08121f' : SK.text, cursor: chosen.connected ? 'pointer' : 'default' }}
                >
                  <ListChecks size={12} /> List
                </button>
              </div>
              {!chosen.connected && (
                <div style={{ fontSize: 10, color: SK.muted, marginTop: 8, lineHeight: 1.5 }}>
                  Log in to capture this provider's session, then list and import its conversations.
                </div>
              )}
            </div>
          )}

          {!servicesLoading && !chosen && (
            <div style={{ fontSize: 11, color: SK.muted, lineHeight: 1.5 }}>
              Choose a provider above to connect and import your conversations. ChatGPT and Claude are listed first.
            </div>
          )}
        </div>

        {/* CENTER — import list OR preview */}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, borderRight: `0.5px solid ${SK.brd}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `0.5px solid ${SK.brd}`, flexShrink: 0 }}>
            <Segmented
              value={centerView}
              onChange={setCenterView}
              options={[{ value: 'import', label: 'Import' }, { value: 'preview', label: 'Preview' }]}
            />
          </div>

          {centerView === 'import' ? (
            <div style={{ flex: 1, overflowY: 'auto', padding: 12, minHeight: 0 }}>
              {!activeService && (
                <div style={{ fontSize: 12, color: SK.muted, marginTop: 20, textAlign: 'center' }}>
                  Pick a connected service and press <strong style={{ color: SK.text }}>List</strong> to see its conversations.
                </div>
              )}

              {activeService && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <button onClick={toggleSelectAll} disabled={remoteChats.length === 0} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, background: 'none', border: 'none', color: SK.muted, cursor: remoteChats.length ? 'pointer' : 'default' }}>
                      {allSelected ? <CheckCircle2 size={13} /> : <Circle size={13} />} Select all
                    </button>
                    <span style={{ fontSize: 11, color: SK.muted }}>{selectedIds.size} selected</span>
                    <button
                      onClick={() => void handleImport()}
                      disabled={selectedIds.size === 0 || importing}
                      style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '6px 12px', borderRadius: 6, border: 'none', background: selectedIds.size === 0 || importing ? SK.brd : SK.accent, color: selectedIds.size === 0 || importing ? SK.muted : '#08121f', cursor: selectedIds.size === 0 || importing ? 'default' : 'pointer', fontWeight: 600 }}
                    >
                      {importing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Import selected
                    </button>
                  </div>

                  {remoteLoading && <div style={{ fontSize: 11, color: SK.muted }}>Loading conversations…</div>}
                  {!remoteLoading && remoteChats.length === 0 && (
                    <div style={{ fontSize: 11, color: SK.muted }}>No conversations found for this service.</div>
                  )}

                  {remoteChats.map((c) => {
                    const sel = selectedIds.has(c.id);
                    return (
                      <div
                        key={c.id}
                        onClick={() => toggleSelect(c.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', borderRadius: 7, marginBottom: 5, cursor: 'pointer', background: sel ? 'rgba(74,158,255,0.10)' : SK.card, border: `0.5px solid ${sel ? SK.accent : SK.brd}` }}
                      >
                        <span style={{ display: 'flex', color: sel ? SK.accent : SK.muted, flexShrink: 0 }}>
                          {sel ? <CheckCircle2 size={15} /> : <Circle size={15} />}
                        </span>
                        <span style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title || 'Untitled conversation'}</span>
                        {c.updatedAt && (
                          <span style={{ marginLeft: 'auto', fontSize: 10, color: SK.muted, flexShrink: 0 }}>{new Date(c.updatedAt).toLocaleDateString()}</span>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          ) : (
            <PreviewPane
              chat={preview}
              loading={previewLoading}
              opts={opts}
              exportBusy={exportBusy}
              onExport={() => void handleExportPreview()}
            />
          )}
        </div>

        {/* RIGHT — archive library */}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderBottom: `0.5px solid ${SK.brd}`, flexShrink: 0 }}>
            <Database size={13} style={{ color: SK.accent }} />
            <span style={{ fontSize: 11, letterSpacing: '.06em', color: SK.muted, textTransform: 'uppercase' }}>Archive Library</span>
            <span style={{ fontSize: 10, color: SK.muted }}>({archives.length})</span>
            <button onClick={() => void loadArchives()} title="Refresh" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: SK.muted, cursor: 'pointer', display: 'flex' }}>
              <RefreshCw size={12} />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 12, minHeight: 0 }}>
            {archivesLoading && <div style={{ fontSize: 11, color: SK.muted }}>Loading archive…</div>}

            {!archivesLoading && archiveError && (
              <div style={{ fontSize: 11, color: SK.muted, lineHeight: 1.5, background: SK.card, border: `0.5px solid ${SK.brd}`, borderRadius: 8, padding: 10 }}>
                <Database size={16} style={{ color: SK.muted, marginBottom: 6 }} />
                <div style={{ color: SK.text, marginBottom: 4 }}>Archive backend unavailable</div>
                Imported chats are stored in the backend (Postgres). Once it is configured, your imported conversations appear here.
              </div>
            )}

            {!archivesLoading && !archiveError && archives.length === 0 && (
              <div style={{ fontSize: 11, color: SK.muted, lineHeight: 1.5, background: SK.card, border: `0.5px solid ${SK.brd}`, borderRadius: 8, padding: 10 }}>
                <MessageSquare size={16} style={{ color: SK.muted, marginBottom: 6 }} />
                <div style={{ color: SK.text, marginBottom: 4 }}>No archived chats yet</div>
                Import conversations from a connected service — they live in the backend archive and show up here.
              </div>
            )}

            {archives.map((a) => (
              <div key={a.id} style={{ background: SK.card, border: `0.5px solid ${a.id === preview?.id ? SK.accent : SK.brd}`, borderRadius: 8, padding: 10, marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: serviceColor(a.service), flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: SK.muted, textTransform: 'capitalize' }}>{a.service}</span>
                  {a.model && <span style={{ fontSize: 10, color: SK.muted }}>· {a.model}</span>}
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: SK.muted }}>{a.messageCount} msgs</span>
                </div>
                <div style={{ fontSize: 12, marginBottom: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.title || 'Untitled conversation'}</div>
                <div style={{ display: 'flex', gap: 5 }}>
                  <button onClick={() => void handleOpen(a.id)} title="Open preview" style={iconBtn}>
                    <Eye size={12} /> Open
                  </button>
                  <button onClick={() => void handleExportArchive(a.id)} disabled={exportBusy} title="Export" style={{ ...iconBtn, opacity: exportBusy ? 0.6 : 1 }}>
                    <FileDown size={12} /> Export
                  </button>
                  <button onClick={() => void handleDelete(a.id)} title="Delete" style={{ ...iconBtn, marginLeft: 'auto', color: '#e06c75', flex: '0 0 auto' }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Status strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: SK.accent, color: '#08121f', fontSize: 11, padding: '3px 12px', fontWeight: 500, flexShrink: 0 }}>
        <span>Chat Exporter</span>
        <span>{connectedServices.length} connected</span>
        <span style={{ marginLeft: 'auto' }}>Format: {opts.format.toUpperCase()} · {opts.theme}</span>
      </div>

      {/* Export options dropdown */}
      {showOptions && (
        <div style={{ position: 'absolute', top: 40, right: 12, width: 268, background: SK.panel, border: `0.5px solid ${SK.brd}`, borderRadius: 10, padding: 14, zIndex: 30, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Export Options</span>
            <button onClick={() => setShowOptions(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: SK.muted, cursor: 'pointer', display: 'flex' }}>
              <X size={14} />
            </button>
          </div>

          <div style={{ fontSize: 10, letterSpacing: '.06em', color: SK.muted, textTransform: 'uppercase', marginBottom: 6 }}>Format</div>
          <div style={{ marginBottom: 12 }}>
            <Segmented
              value={opts.format}
              onChange={(v) => setOpt('format', v)}
              options={[{ value: 'markdown', label: 'Markdown' }, { value: 'pdf', label: 'PDF A4' }, { value: 'html', label: 'HTML' }]}
            />
          </div>

          <div style={{ fontSize: 10, letterSpacing: '.06em', color: SK.muted, textTransform: 'uppercase', marginBottom: 6 }}>Theme</div>
          <div style={{ marginBottom: 12 }}>
            <Segmented
              value={opts.theme}
              onChange={(v) => setOpt('theme', v)}
              options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
            />
          </div>

          <div style={{ fontSize: 10, letterSpacing: '.06em', color: SK.muted, textTransform: 'uppercase', marginBottom: 2 }}>Content</div>
          <Toggle on={opts.includeCode} onClick={() => setOpt('includeCode', !opts.includeCode)} label="Include code blocks" />
          <Toggle on={opts.syntaxColors} onClick={() => setOpt('syntaxColors', !opts.syntaxColors)} label="Syntax colors (One-Dark)" />
          <Toggle on={opts.downloadScripts} onClick={() => setOpt('downloadScripts', !opts.downloadScripts)} label="Download scripts (.zip)" />
          <Toggle on={opts.downloadAttachments} onClick={() => setOpt('downloadAttachments', !opts.downloadAttachments)} label="Download attachments (.zip)" />
        </div>
      )}
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '5px 9px',
  borderRadius: 6, border: `0.5px solid ${SK.brd}`, background: 'transparent',
  color: SK.text, cursor: 'pointer',
};

// ─── Preview pane ─────────────────────────────────────────────────────────
/**
 * Renders a selected archived chat as role-labelled bubbles. The message body is
 * injected via dangerouslySetInnerHTML — `ChatMessage.html` was sanitized in the
 * main process (see shared/types.ts) before crossing IPC, so it is trusted here.
 * Code blocks are styled with the One-Dark palette ported from the extension CSS.
 */
function PreviewPane({ chat, loading, opts, exportBusy, onExport }: {
  chat: ArchivedChat | null;
  loading: boolean;
  opts: ChatExportOptions;
  exportBusy: boolean;
  onExport: () => void;
}) {
  const dark = opts.theme === 'dark';

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: SK.muted, fontSize: 12, gap: 8 }}>
        <Loader2 size={14} className="animate-spin" /> Loading conversation…
      </div>
    );
  }

  if (!chat) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: SK.muted, fontSize: 12, textAlign: 'center', padding: 24 }}>
        Open an archived chat from the library to preview it here.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <style>{PREVIEW_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: `0.5px solid ${SK.brd}`, flexShrink: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: serviceColor(chat.service), flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{chat.title || 'Untitled conversation'}</span>
        <button
          onClick={onExport}
          disabled={exportBusy}
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '5px 11px', borderRadius: 6, border: 'none', background: SK.accent, color: '#08121f', cursor: exportBusy ? 'default' : 'pointer', fontWeight: 600, opacity: exportBusy ? 0.6 : 1 }}
        >
          {exportBusy ? <Loader2 size={12} className="animate-spin" /> : <FileDown size={12} />} Export
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px', background: dark ? '#131314' : '#ffffff', color: dark ? '#e3e3e3' : '#1a1d2e' }}>
        {chat.messages.map((msg, i) => {
          const isUser = msg.role === 'user';
          return (
            <div key={i} className="chat-preview-msg" style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: dark ? '#9aa0ac' : '#6b7280', marginBottom: 6 }}>
                {msg.role}
              </div>
              <div
                style={{
                  borderRadius: 14,
                  borderTopRightRadius: isUser ? 4 : 14,
                  padding: isUser ? '12px 16px' : '2px 0',
                  background: isUser ? (dark ? '#1e1f20' : '#f1f5f9') : 'transparent',
                }}
              >
                {msg.html ? (
                  // SECURITY: html was sanitized in the main process before IPC — trusted display HTML.
                  <div
                    className={`chat-content ${opts.syntaxColors ? 'syntax-on' : ''}`}
                    dangerouslySetInnerHTML={{ __html: opts.includeCode ? msg.html : msg.html.replace(/<pre[\s\S]*?<\/pre>/gi, '') }}
                  />
                ) : (
                  <div className="chat-content" style={{ whiteSpace: 'pre-wrap' }}>{msg.text ?? ''}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// One-Dark code colors ported from the extension's index.css, scoped to the preview.
const PREVIEW_CSS = `
.chat-content p{margin:0 0 1rem;line-height:1.6}
.chat-content p:last-child{margin-bottom:0}
.chat-content ul{list-style:disc;margin:0 0 1rem;padding-left:1.5rem}
.chat-content ol{list-style:decimal;margin:0 0 1rem;padding-left:1.5rem}
.chat-content li{margin-bottom:.5rem;line-height:1.6}
.chat-content h1,.chat-content h2,.chat-content h3{font-weight:600;margin:1.5rem 0 .75rem}
.chat-content h2{font-size:1.25rem}
.chat-content table{border-collapse:collapse;width:100%;margin:1rem 0}
.chat-content th,.chat-content td{padding:.5rem 1rem;text-align:left;border:1px solid #444746}
.chat-content pre{background:#1e1f20 !important;border:1px solid #303236 !important;color:#e6e6e6;padding:1rem;border-radius:.5rem;margin:1.25rem 0;overflow-x:auto}
.chat-content pre code{color:#e6e6e6;background:transparent;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:.9em}
.chat-content :not(pre)>code{background:rgba(127,127,127,.16);padding:.1em .35em;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
.chat-content img{max-width:100%;height:auto}
.chat-content.syntax-on .hljs-comment,.chat-content.syntax-on .hljs-quote{color:#7f848e;font-style:italic}
.chat-content.syntax-on .hljs-keyword,.chat-content.syntax-on .hljs-selector-tag,.chat-content.syntax-on .hljs-built_in,.chat-content.syntax-on .hljs-section,.chat-content.syntax-on .hljs-doctag{color:#c678dd}
.chat-content.syntax-on .hljs-string,.chat-content.syntax-on .hljs-attr,.chat-content.syntax-on .hljs-regexp,.chat-content.syntax-on .hljs-addition{color:#98c379}
.chat-content.syntax-on .hljs-number,.chat-content.syntax-on .hljs-literal,.chat-content.syntax-on .hljs-type,.chat-content.syntax-on .hljs-selector-class{color:#d19a66}
.chat-content.syntax-on .hljs-title,.chat-content.syntax-on .hljs-title.function_,.chat-content.syntax-on .hljs-selector-id{color:#61afef}
.chat-content.syntax-on .hljs-variable,.chat-content.syntax-on .hljs-name,.chat-content.syntax-on .hljs-attribute,.chat-content.syntax-on .hljs-tag,.chat-content.syntax-on .hljs-deletion{color:#e06c75}
.chat-content.syntax-on .hljs-symbol,.chat-content.syntax-on .hljs-bullet,.chat-content.syntax-on .hljs-link,.chat-content.syntax-on .hljs-meta{color:#56b6c2}
`;

export default ChatExporter;
