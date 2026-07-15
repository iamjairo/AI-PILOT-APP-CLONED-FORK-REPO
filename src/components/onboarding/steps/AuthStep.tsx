import { useState, useEffect, useCallback } from 'react';
import { useAuthStore, type ProviderAuthInfo, type OllamaStatusInfo } from '../../../stores/auth-store';
import { IPC } from '../../../../shared/ipc';
import { invoke } from '../../../lib/ipc-client';
import {
  FEATURED_PROVIDERS, ADDITIONAL_PROVIDERS, getProviderDef, fallbackProviderDef,
  type ProviderDef,
} from '../../../lib/providers';
import { OAuthFlowPanels } from '../../shared/OAuthFlowPanels';
import {
  Key, Globe, CheckCircle, AlertCircle, Loader2, ExternalLink,
  Server, Wifi, ChevronDown, Plus,
} from 'lucide-react';

// ─── Ollama Card ─────────────────────────────────────────────────────────

function OllamaCard({
  authInfo,
  ollamaStatus,
  onEnabled,
}: {
  authInfo?: ProviderAuthInfo;
  ollamaStatus: OllamaStatusInfo | null;
  onEnabled: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; version?: string; error?: string } | null>(null);
  const isConnected = authInfo?.hasAuth ?? false;
  const status = ollamaStatus;

  // Auto-test connection when initially enabled
  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await invoke(IPC.OLLAMA_CHECK_CONNECTION) as { ok: boolean; version?: string; error?: string };
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ ok: false, error: err?.message || 'Unknown error' });
    }
    setTesting(false);
  }, []);

  const handleEnable = async () => {
    // Quick test then enable
    setTesting(true);
    try {
      const result = await invoke(IPC.OLLAMA_CHECK_CONNECTION) as { ok: boolean; version?: string; error?: string };
      setTestResult(result);
      // Enable regardless — user may start Ollama later or only use cloud models
      await invoke(IPC.OLLAMA_SAVE_SETTINGS, { enabled: true });
      onEnabled();
    } catch {
      // Still enable — maybe Ollama isn't running yet but user will start it later
      await invoke(IPC.OLLAMA_SAVE_SETTINGS, { enabled: true });
      onEnabled();
    }
    setTesting(false);
  };

  // Auto-test connection when initially enabled
  useEffect(() => {
    if (isConnected && !testResult && !testing) {
      handleTest();
    }
  }, [isConnected, testResult, testing, handleTest]);

  return (
    <div className={`border rounded-lg transition-colors ${
      isConnected ? 'border-success/30 bg-success/5' : 'border-border bg-bg-surface'
    }`}>
      <div className="flex items-center gap-3 p-3">
        <div className={`w-7 h-7 rounded-md flex items-center justify-center ${
          isConnected ? 'bg-success/20' : 'bg-bg-elevated'
        }`}>
          {isConnected ? (
            status?.available ? (
              <Wifi className="w-3.5 h-3.5 text-success" />
            ) : (
              <CheckCircle className="w-3.5 h-3.5 text-success" />
            )
          ) : (
            <Server className="w-3.5 h-3.5 text-text-secondary" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">Ollama</span>
            {isConnected && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/20 text-success font-medium">
                {status?.available ? `${status.modelCount} models` : 'Enabled'}
              </span>
            )}
            {status?.version && (
              <span className="text-[10px] text-text-secondary">v{status.version}</span>
            )}
          </div>
          <p className="text-xs text-text-secondary">
            {isConnected
              ? status?.available
                ? `Running at ${status.endpoint}`
                : status?.error || 'Not reachable'
              : 'Local models — no API key needed'}
          </p>
        </div>
        {!isConnected && (
          <button
            onClick={handleEnable}
            disabled={testing}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-accent hover:bg-accent/90 rounded transition-colors disabled:opacity-50"
          >
            {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Server className="w-3 h-3" />}
            Enable
          </button>
        )}
        {isConnected && (
          <button
            onClick={handleTest}
            disabled={testing}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-text-primary bg-bg-elevated border border-border hover:border-accent/50 rounded transition-colors"
          >
            {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wifi className="w-3 h-3" />}
            Test
          </button>
        )}
      </div>
      {/* Test result feedback */}
      {testResult && (
        <div className={`mx-3 mb-3 px-2.5 py-1.5 rounded text-xs ${
          testResult.ok ? 'bg-success/10 text-success' : 'bg-error/10 text-error'
        }`}>
          {testResult.ok
            ? `Connected — Ollama v${testResult.version}`
            : testResult.error || 'Connection failed'}
        </div>
      )}
    </div>
  );
}

// ─── Provider Card ───────────────────────────────────────────────────────

function ProviderCard({
  provider,
  authInfo,
  onSetApiKey,
  onLoginOAuth,
  oauthInProgress,
  startExpanded,
}: {
  provider: ProviderDef;
  authInfo?: ProviderAuthInfo;
  onSetApiKey: (key: string) => Promise<boolean>;
  onLoginOAuth: () => void;
  oauthInProgress: boolean;
  startExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(startExpanded ?? false);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const isConnected = authInfo?.hasAuth ?? false;

  const handleSaveKey = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    const ok = await onSetApiKey(apiKey.trim());
    setSaving(false);
    if (ok) { setApiKey(''); setExpanded(false); }
  };

  return (
    <div className={`border rounded-lg transition-colors ${
      isConnected ? 'border-success/30 bg-success/5' : 'border-border bg-bg-surface'
    }`}>
      <div className="flex items-center gap-3 p-3">
        <div className={`w-7 h-7 rounded-md flex items-center justify-center ${
          isConnected ? 'bg-success/20' : 'bg-bg-elevated'
        }`}>
          {isConnected
            ? <CheckCircle className="w-3.5 h-3.5 text-success" />
            : <Globe className="w-3.5 h-3.5 text-text-secondary" />
          }
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-text-primary">{provider.name}</span>
          {isConnected && (
            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-success/20 text-success font-medium">
              Connected
            </span>
          )}
          <p className="text-xs text-text-secondary">{provider.description}</p>
        </div>
        {!isConnected && !expanded && (
          <div className="flex items-center gap-1.5">
            {provider.supportsOAuth && (
              <button
                onClick={onLoginOAuth}
                disabled={oauthInProgress}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-accent hover:bg-accent/90 rounded transition-colors disabled:opacity-50"
              >
                <ExternalLink className="w-3 h-3" />
                Login
              </button>
            )}
            {provider.envVar !== '' && (
              <button
                onClick={() => setExpanded(true)}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-text-primary bg-bg-elevated border border-border hover:border-accent/50 rounded transition-colors"
              >
                <Key className="w-3 h-3" />
                API Key
              </button>
            )}
          </div>
        )}
      </div>
      {expanded && !isConnected && (
        <div className="px-3 pb-3 pt-0">
          <div className="flex gap-1.5">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveKey(); }}
              placeholder={provider.envVar || 'API key'}
              autoFocus
              className="flex-1 text-xs bg-bg-base border border-border rounded px-2.5 py-1.5 text-text-primary placeholder:text-text-secondary/40 focus:outline-none focus:border-accent"
            />
            <button
              onClick={handleSaveKey}
              disabled={!apiKey.trim() || saving}
              className="px-2.5 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent/90 rounded transition-colors disabled:opacity-50"
            >
              {saving ? '…' : 'Save'}
            </button>
            <button
              onClick={() => { setExpanded(false); setApiKey(''); }}
              className="px-1.5 py-1.5 text-xs text-text-secondary hover:text-text-primary"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── AuthStep Component ──────────────────────────────────────────────────

export default function AuthStep() {
  const { providers, ollamaStatus, setApiKey, loginOAuth, oauthInProgress, error, clearError, loadStatus } = useAuthStore();

  // Non-featured providers the user picked from the "add another" dropdown
  // in this session (rendered as cards even before a key is saved).
  const [addedProviderIds, setAddedProviderIds] = useState<string[]>([]);

  const refreshAll = async () => {
    await loadStatus();
  };

  const featuredIds = new Set(FEATURED_PROVIDERS.map(p => p.id));

  // Connected providers outside the featured list (e.g. google, openrouter)
  // — AUTH_GET_STATUS returns every stored provider, so surface them all.
  const connectedExtras: ProviderDef[] = providers
    .filter(p => p.hasAuth && !featuredIds.has(p.provider))
    .map(p => getProviderDef(p.provider) ?? fallbackProviderDef(p.provider));

  // Session-added providers that aren't connected yet (connected ones are
  // already covered by connectedExtras).
  const addedExtras: ProviderDef[] = addedProviderIds
    .filter(id => !connectedExtras.some(d => d.id === id))
    .map(id => getProviderDef(id) ?? fallbackProviderDef(id));

  const visibleExtraIds = new Set([...connectedExtras, ...addedExtras].map(d => d.id));

  // Dropdown options: everything not featured and not already shown.
  const dropdownOptions = ADDITIONAL_PROVIDERS.filter(d => !visibleExtraIds.has(d.id));

  const renderProviderCard = (def: ProviderDef, startExpanded = false) => {
    const authInfo = providers.find(p => p.provider === def.id);
    return (
      <ProviderCard
        key={def.id}
        provider={def}
        authInfo={authInfo}
        onSetApiKey={(key) => setApiKey(def.id, key)}
        onLoginOAuth={() => loginOAuth(def.id)}
        oauthInProgress={oauthInProgress === def.id}
        startExpanded={startExpanded}
      />
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-text-secondary">
        Connect at least one AI provider. You can add more later in Settings.
      </p>

      {error && (
        <div className="flex items-start gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
          <AlertCircle className="w-4 h-4 text-error mt-0.5 flex-shrink-0" />
          <p className="text-xs text-error break-words flex-1">{error}</p>
          <button onClick={clearError} className="text-xs text-error/70 hover:text-error">✕</button>
        </div>
      )}

      <OAuthFlowPanels />

      <div className="space-y-2">
        {FEATURED_PROVIDERS.map((def) => {
          if (def.isOllama) {
            const authInfo = providers.find(p => p.provider === def.id);
            return (
              <OllamaCard
                key={def.id}
                authInfo={authInfo}
                ollamaStatus={ollamaStatus}
                onEnabled={refreshAll}
              />
            );
          }
          return renderProviderCard(def);
        })}

        {/* Connected or session-added providers beyond the featured set */}
        {connectedExtras.map((def) => renderProviderCard(def))}
        {addedExtras.map((def) => renderProviderCard(def, true))}
      </div>

      {/* Add another provider */}
      {dropdownOptions.length > 0 && (
        <div className="relative">
          <Plus className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-secondary pointer-events-none" />
          <select
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (id) setAddedProviderIds(ids => ids.includes(id) ? ids : [...ids, id]);
            }}
            className="w-full text-xs bg-bg-surface border border-border rounded-lg pl-8 pr-8 py-2.5 text-text-secondary focus:outline-none focus:border-accent appearance-none cursor-pointer hover:border-accent/50 transition-colors"
          >
            <option value="">Add another provider…</option>
            {dropdownOptions.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-secondary pointer-events-none" />
        </div>
      )}

      <p className="text-[10px] text-text-secondary/40 text-center">
        Cloud keys are stored locally in ~/.config/pilot/auth.json
      </p>
    </div>
  );
}
