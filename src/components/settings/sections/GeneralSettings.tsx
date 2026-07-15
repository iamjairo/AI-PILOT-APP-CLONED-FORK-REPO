import { useAppSettingsStore } from '../../../stores/app-settings-store';
import { useMemoryStore } from '../../../stores/memory-store';
import { useEffect, useState } from 'react';
import { FolderOpen, Brain, Sparkles, ScrollText, Container, Globe } from 'lucide-react';
import { SettingRow, Toggle } from '../settings-helpers';
import { IPC } from '../../../../shared/ipc';
import { getExternalBackendStatus, invoke, resetExternalBackendSession, subscribeExternalBackendStatus } from '../../../lib/ipc-client';
import { getRemoteBackendCompatibility } from '../../../lib/remote-backend-compatibility';
import { fetchRemoteBackendHealth } from '../../../lib/remote-backend-health';
import type { RemoteBackendHealthResponse } from '../../../../shared/types';

export function GeneralSettings() {
  const { piAgentDir, remoteBackendUrl, load: loadAppSettings, setPiAgentDir, setRemoteBackendUrl, commitMsgModel, commitMsgMaxTokens, update: updateAppSettings, logging, setLogLevel, setFileLogging, setSyslogConfig, desktopEnabled, setDesktopEnabled, webSearchEnabled, webSearchApiKey, setWebSearchEnabled, setWebSearchApiKey } = useAppSettingsStore();
  const { memoryEnabled, setMemoryEnabled } = useMemoryStore();
  const [dirInput, setDirInput] = useState(piAgentDir);
  const [dirDirty, setDirDirty] = useState(false);
  const [remoteBackendInput, setRemoteBackendInput] = useState(remoteBackendUrl);
  const [remoteBackendDirty, setRemoteBackendDirty] = useState(false);
  const [backendStatus, setBackendStatus] = useState(() => getExternalBackendStatus());
  const [resettingBackendSession, setResettingBackendSession] = useState(false);
  const [remoteBackendHealth, setRemoteBackendHealth] = useState<{
    status: 'idle' | 'checking' | 'reachable' | 'unreachable';
    message: string | null;
    details: RemoteBackendHealthResponse | null;
  }>({
    status: 'idle',
    message: null,
    details: null,
  });
  const [apiKeyInput, setApiKeyInput] = useState(webSearchApiKey);
  const [availableModels, setAvailableModels] = useState<Array<{ provider: string; id: string; name: string }>>([]);

  useEffect(() => {
    loadAppSettings();
    invoke(IPC.MODEL_GET_AVAILABLE).then((models: unknown) => {
      if (Array.isArray(models)) setAvailableModels(models);
    });
  }, [loadAppSettings]);

  useEffect(() => {
    setDirInput(piAgentDir);
    setDirDirty(false);
  }, [piAgentDir]);

  useEffect(() => {
    setRemoteBackendInput(remoteBackendUrl);
    setRemoteBackendDirty(false);
  }, [remoteBackendUrl]);

  useEffect(() => {
    setApiKeyInput(webSearchApiKey);
  }, [webSearchApiKey]);

  useEffect(() => subscribeExternalBackendStatus(setBackendStatus), []);

  const handleDirChange = (value: string) => {
    setDirInput(value);
    setDirDirty(value !== piAgentDir);
  };

  const handleDirSave = () => {
    if (dirInput.trim()) {
      setPiAgentDir(dirInput.trim());
      setDirDirty(false);
    }
  };

  const handleDirKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && dirDirty) {
      handleDirSave();
    }
  };

  const handleRemoteBackendSave = () => {
    setRemoteBackendUrl(remoteBackendInput.trim());
    setRemoteBackendDirty(false);
  };

  const handleRemoteBackendKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && remoteBackendDirty) {
      handleRemoteBackendSave();
    }
  };

  const handleResetRemoteBackendSession = async () => {
    setResettingBackendSession(true);
    try {
      resetExternalBackendSession();
    } finally {
      setResettingBackendSession(false);
    }
  };

  const remoteStatusTone = backendStatus.state === 'connected'
    ? 'text-success'
    : (backendStatus.state === 'unpaired' ? 'text-warning' : 'text-text-secondary');
  const remoteStatusLabel = backendStatus.state === 'connected'
    ? 'Connected'
    : (backendStatus.state === 'unpaired'
      ? 'Pairing required'
      : (backendStatus.state === 'connecting' ? 'Connecting' : 'Inactive'));
  const normalizedSavedRemoteBackendUrl = normalizeUrl(remoteBackendUrl);
  const normalizedActiveRemoteBackendUrl = normalizeUrl(backendStatus.httpUrl);
  const healthCheckTarget = normalizedActiveRemoteBackendUrl ?? normalizedSavedRemoteBackendUrl;
  const backendCompatibility = remoteBackendHealth.details
    ? getRemoteBackendCompatibility(remoteBackendHealth.details)
    : null;

  useEffect(() => {
    if (!healthCheckTarget) {
      setRemoteBackendHealth({ status: 'idle', message: null, details: null });
      return;
    }

    const controller = new AbortController();
    setRemoteBackendHealth({ status: 'checking', message: null, details: null });

    fetchRemoteBackendHealth(healthCheckTarget, (input, init) =>
      fetch(input, { ...init, signal: controller.signal })
    )
      .then((details) => {
        setRemoteBackendHealth({
          status: 'reachable',
          message: `Reachable over ${details.protocol.toUpperCase()}`,
          details,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setRemoteBackendHealth({
          status: 'unreachable',
          message: error instanceof Error ? error.message : 'Backend health check failed',
          details: null,
        });
      });

    return () => controller.abort();
  }, [healthCheckTarget]);

  return (
    <div className="p-5 space-y-6">
      <SettingRow
        icon={<FolderOpen className="w-4 h-4 text-accent" />}
        label="Pi Config Directory"
        description="Path to the pi agent global config directory (settings.json, AGENTS.md, etc). Default: ~/.pi/agent"
      >
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={dirInput}
            onChange={(e) => handleDirChange(e.target.value)}
            onKeyDown={handleDirKeyDown}
            className="text-xs bg-bg-surface border border-border rounded px-2 py-1 text-text-primary w-48 focus:outline-none focus:border-accent"
            placeholder="~/.pi/agent"
          />
          {dirDirty && (
            <button
              onClick={handleDirSave}
              className="text-xs px-2 py-1 bg-accent text-white rounded hover:bg-accent/90 transition-colors"
            >
              Save
            </button>
          )}
        </div>
      </SettingRow>

      <SettingRow
        icon={<Brain className="w-4 h-4 text-accent" />}
        label="Memory"
        description="When enabled, memory files are injected into the agent's system prompt. Manage memory contents in the sidebar Memory pane."
      >
        <Toggle checked={memoryEnabled} onChange={setMemoryEnabled} />
      </SettingRow>

      <SettingRow
        icon={<Container className="w-4 h-4 text-accent" />}
        label="Desktop"
        description="Show the Desktop panel and allow per-project Docker containers with a virtual display the agent can control. Requires Docker. Per-project override available in Project settings."
      >
        <Toggle checked={desktopEnabled} onChange={setDesktopEnabled} />
      </SettingRow>

      <SettingRow
        icon={<Globe className="w-4 h-4 text-accent" />}
        label="Remote Backend URL"
        description="Optional external backend for thin-client mode. Example: https://nas.local:18088. Restart AI-Pilot after changing this."
      >
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={remoteBackendInput}
            onChange={(e) => {
              setRemoteBackendInput(e.target.value);
              setRemoteBackendDirty(e.target.value !== remoteBackendUrl);
            }}
            onKeyDown={handleRemoteBackendKeyDown}
            className="text-xs bg-bg-surface border border-border rounded px-2 py-1 text-text-primary w-56 focus:outline-none focus:border-accent"
            placeholder="https://nas.local:18088"
          />
          {remoteBackendDirty && (
            <button
              onClick={handleRemoteBackendSave}
              className="text-xs px-2 py-1 bg-accent text-white rounded hover:bg-accent/90 transition-colors"
            >
              Save
            </button>
          )}
        </div>
      </SettingRow>

      {(remoteBackendUrl || backendStatus.enabled) && (
        <div className="ml-7 rounded-md border border-border bg-bg-surface px-3 py-2 space-y-1">
          <p className="text-xs text-text-secondary">
            Status: <span className={remoteStatusTone}>{remoteStatusLabel}</span>
          </p>
          {backendStatus.httpUrl && (
            <p className="text-xs text-text-secondary">
              Active target: <span className="font-mono text-text-primary">{backendStatus.httpUrl}</span>
            </p>
          )}
          {remoteBackendHealth.status !== 'idle' && (
            <p className="text-xs text-text-secondary">
              Reachability:{' '}
              <span
                className={
                  remoteBackendHealth.status === 'reachable'
                    ? 'text-success'
                    : (remoteBackendHealth.status === 'unreachable' ? 'text-error' : 'text-text-secondary')
                }
              >
                {remoteBackendHealth.status === 'checking' ? 'Checking…' : remoteBackendHealth.message}
              </span>
            </p>
          )}
          {backendCompatibility && (
            <p className="text-xs text-text-secondary">
              Compatibility:{' '}
              <span className={backendCompatibility.status === 'compatible' ? 'text-success' : 'text-warning'}>
                {backendCompatibility.message}
              </span>
            </p>
          )}
          {remoteBackendUrl && normalizedActiveRemoteBackendUrl !== normalizedSavedRemoteBackendUrl && (
            <p className="text-xs text-warning">
              Saved URL will apply after restart unless a CLI flag or environment override is active.
            </p>
          )}
          {backendStatus.state === 'unpaired' && (
            <p className="text-xs text-warning">
              Pair this app with the remote backend after restart to finish connecting.
            </p>
          )}
          {backendStatus.hasToken && (
            <div className="pt-1">
              <button
                onClick={handleResetRemoteBackendSession}
                disabled={resettingBackendSession}
                className="text-xs px-2.5 py-1 bg-bg-base border border-border text-text-secondary rounded hover:bg-bg-elevated hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {resettingBackendSession ? 'Resetting…' : 'Reset pairing'}
              </button>
              <p className="text-[11px] text-text-secondary mt-1">
                Forget the stored backend token and return to the pairing screen.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Web Search ── */}
      <div className="border-t border-border pt-4 mt-2">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-4">Web Search</h3>

        <div className="space-y-4">
          <SettingRow
            icon={<Globe className="w-4 h-4 text-accent" />}
            label="Enable Web Search"
            description="Give the agent a web_search tool powered by Brave Search. Requires a free API key."
          >
            <Toggle checked={webSearchEnabled} onChange={setWebSearchEnabled} />
          </SettingRow>

          {webSearchEnabled && (
            <SettingRow
              icon={<Globe className="w-4 h-4 text-text-secondary" />}
              label="Brave Search API Key"
              description={<>Get a free key at <a href="https://api.search.brave.com/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">api.search.brave.com</a></>}
            >
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                onBlur={() => { if (apiKeyInput !== webSearchApiKey) setWebSearchApiKey(apiKeyInput); }}
                placeholder="BSA-xxxxxxxxxx"
                className="w-64 px-3 py-1.5 bg-bg-base border border-border rounded-md text-sm text-text-primary placeholder:text-text-secondary/40 focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </SettingRow>
          )}
        </div>
      </div>

      {/* ── AI Commit Messages ── */}
      <div className="border-t border-border pt-4 mt-2">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-4">AI Commit Messages</h3>

        <div className="space-y-6">
          <SettingRow
            icon={<Sparkles className="w-4 h-4 text-accent" />}
            label="Model"
            description="Model used for generating commit messages. 'Auto' picks the cheapest available."
          >
            <select
              value={commitMsgModel}
              onChange={(e) => updateAppSettings({ commitMsgModel: e.target.value || undefined })}
              className="text-xs bg-bg-surface border border-border rounded px-2 py-1 text-text-primary focus:outline-none focus:border-accent max-w-[200px]"
            >
              <option value="">Auto (cheapest)</option>
              {availableModels.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.name || m.id}
                </option>
              ))}
            </select>
          </SettingRow>

          <SettingRow
            icon={<Sparkles className="w-4 h-4 text-text-secondary" />}
            label="Max Tokens"
            description="Maximum tokens for the generated commit message. Increase for large multi-file commits."
          >
            <input
              type="number"
              value={commitMsgMaxTokens}
              onChange={(e) => updateAppSettings({ commitMsgMaxTokens: parseInt(e.target.value) || 4096 })}
              className="text-xs bg-bg-surface border border-border rounded px-2 py-1 text-text-primary w-20 focus:outline-none focus:border-accent"
              min="256"
              max="16384"
              step="256"
            />
          </SettingRow>
        </div>
      </div>

      {/* ── Logging ── */}
      <div className="border-t border-border pt-4 mt-2">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-4">Logging</h3>

        <div className="space-y-6">
          <SettingRow
            icon={<ScrollText className="w-4 h-4 text-text-secondary" />}
            label="Log Level"
            description="Minimum severity to record. Debug is most verbose."
          >
            <select
              value={logging.level}
              onChange={(e) => setLogLevel(e.target.value as 'debug' | 'info' | 'warn' | 'error')}
              className="text-xs bg-bg-surface border border-border rounded px-2 py-1 text-text-primary focus:outline-none focus:border-accent"
            >
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
            </select>
          </SettingRow>

          <SettingRow
            icon={<ScrollText className="w-4 h-4 text-text-secondary" />}
            label="File Logging"
            description="Write logs to ~/.config/pilot/logs/ with automatic rotation."
          >
            <Toggle checked={logging.file?.enabled ?? true} onChange={setFileLogging} />
          </SettingRow>

          <SettingRow
            icon={<ScrollText className="w-4 h-4 text-text-secondary" />}
            label="Syslog (UDP)"
            description="Forward logs to a remote syslog server via UDP."
          >
            <Toggle
              checked={logging.syslog?.enabled ?? false}
              onChange={(enabled) => setSyslogConfig({ enabled })}
            />
          </SettingRow>

          {logging.syslog?.enabled && (
            <div className="ml-7 space-y-4">
              <SettingRow
                icon={<div className="w-4 h-4" />}
                label="Host"
                description="Syslog server hostname or IP."
              >
                <input
                  type="text"
                  value={logging.syslog.host}
                  onChange={(e) => setSyslogConfig({ enabled: true, host: e.target.value })}
                  onBlur={(e) => setSyslogConfig({ enabled: true, host: e.target.value.trim() || 'localhost' })}
                  className="text-xs bg-bg-surface border border-border rounded px-2 py-1 text-text-primary w-36 focus:outline-none focus:border-accent"
                  placeholder="localhost"
                />
              </SettingRow>
              <SettingRow
                icon={<div className="w-4 h-4" />}
                label="Port"
                description="Syslog server UDP port."
              >
                <input
                  type="number"
                  value={logging.syslog.port}
                  onChange={(e) => setSyslogConfig({ enabled: true, port: parseInt(e.target.value) || 514 })}
                  className="text-xs bg-bg-surface border border-border rounded px-2 py-1 text-text-primary w-20 focus:outline-none focus:border-accent"
                  placeholder="514"
                  min="1"
                  max="65535"
                />
              </SettingRow>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function normalizeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).toString();
  } catch {
    return value.trim() || null;
  }
}
