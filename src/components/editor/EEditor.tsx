/**
 * @file e-Editor — a CodePen-style live playground tab: Monaco panes for
 * HTML/CSS/JS with a sandboxed live-preview iframe, plus a settings panel
 * (skin / accent / font / size). Content and settings persist to localStorage;
 * a Postgres-backed cross-device sync layer replaces that in a later increment.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { Play, Settings2, Code2, Hash, Braces, Sparkles, Wand2, Loader2, X } from 'lucide-react';
import { registerEEditorThemes } from '../../lib/monaco-setup';
import { EEditorIcon } from './EEditorIcon';
import { invoke } from '../../lib/ipc-client';
import * as editorStore from '../../lib/editor-store-client';
import { IPC } from '../../../shared/ipc';
import type { EditorAiIssue, EditorAiAnalyzeResult, EditorStoreStatus } from '../../../shared/types';

type FileKey = 'html' | 'css' | 'js';
type Skin = 'dark' | 'grey' | 'light';

interface EEditorFiles {
  html: string;
  css: string;
  js: string;
}
interface EEditorSettings {
  skin: Skin;
  accent: string;
  font: string;
  size: number;
  autoRun: boolean;
}

const STORE_KEY = 'e-editor:v1';

const DEFAULT_FILES: EEditorFiles = {
  html: '<h1>Hello from the e-Editor</h1>\n<p>Edit HTML, CSS &amp; JS — preview updates live.</p>\n<button id="go">Click me</button>',
  css: 'body{font-family:system-ui;margin:2rem;color:#e7e9ee;background:#0d0f16}\nh1{color:#b5d94a}\nbutton{padding:.5rem 1rem;border:0;border-radius:6px;background:#b5d94a;cursor:pointer}',
  js: "document.getElementById('go').addEventListener('click', () => {\n  document.querySelector('h1').textContent = 'It works \\u2728';\n});",
};

const DEFAULT_SETTINGS: EEditorSettings = {
  skin: 'dark',
  accent: '#b5d94a',
  font: "'JetBrains Mono', ui-monospace, monospace",
  size: 13,
  autoRun: true,
};

const SKINS: Record<Skin, Record<string, string>> = {
  dark: { bg: '#0f1117', panel: '#12151e', tab: '#0d0f16', text: '#e7e9ee', muted: '#9aa0ac', brd: '#262a35', monaco: 'eeditor-dark' },
  grey: { bg: '#2a2a30', panel: '#2e2e35', tab: '#26262c', text: '#d6d7dc', muted: '#9a9ba4', brd: '#3a3a42', monaco: 'eeditor-grey' },
  light: { bg: '#eeeee9', panel: '#f6f6f3', tab: '#ffffff', text: '#26262c', muted: '#6b6b73', brd: '#dcdcd6', monaco: 'eeditor-light' },
};

const ACCENTS = ['#b5d94a', '#388eff', '#a87cff', '#fc923c', '#f472b6', '#3cc8dc'];
const FONTS = [
  { label: 'JetBrains Mono', value: "'JetBrains Mono', ui-monospace, monospace" },
  { label: 'Fira Code', value: "'Fira Code', ui-monospace, monospace" },
  { label: 'SF Mono', value: "'SF Mono', ui-monospace, monospace" },
  { label: 'Menlo', value: 'Menlo, ui-monospace, monospace' },
];

const FILE_META: Record<FileKey, { label: string; lang: string; icon: typeof Code2; color: string }> = {
  html: { label: 'index.html', lang: 'html', icon: Code2, color: '#e2703a' },
  css: { label: 'styles.css', lang: 'css', icon: Hash, color: '#4b8bbe' },
  js: { label: 'script.js', lang: 'javascript', icon: Braces, color: '#e8d44d' },
};

function loadPersisted(): { files: EEditorFiles; settings: EEditorSettings } {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        files: { ...DEFAULT_FILES, ...(parsed.files ?? {}) },
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      };
    }
  } catch {
    /* corrupt storage — fall back to defaults */
  }
  return { files: DEFAULT_FILES, settings: DEFAULT_SETTINGS };
}

function composeDoc(files: EEditorFiles): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${files.css}</style></head><body>${files.html}<script>${files.js}<\/script></body></html>`;
}

export function EEditor() {
  const initial = useMemo(loadPersisted, []);
  const [files, setFiles] = useState<EEditorFiles>(initial.files);
  const [settings, setSettings] = useState<EEditorSettings>(initial.settings);
  const [active, setActive] = useState<FileKey>('html');
  const [showSettings, setShowSettings] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const lastUrl = useRef<string>('');

  const [aiOpen, setAiOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [issues, setIssues] = useState<EditorAiIssue[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const [syncStatus, setSyncStatus] = useState<EditorStoreStatus | null>(null);

  useEffect(() => {
    registerEEditorThemes();
  }, []);

  // Persist (debounced) whenever content or settings change. The store client
  // mirrors to localStorage synchronously and forwards to Postgres when connected.
  const lastSaved = useRef<string>('');
  useEffect(() => {
    const t = setTimeout(() => {
      const snapshot = JSON.stringify({ files, settings });
      lastSaved.current = snapshot;
      void editorStore.setItem(STORE_KEY, { files, settings });
    }, 400);
    return () => clearTimeout(t);
  }, [files, settings]);

  // On mount: pull the authoritative value (Postgres when connected, else the
  // localStorage cache), track connection status, and live-apply cross-device edits.
  useEffect(() => {
    let cancelled = false;
    const applyRemote = (v: unknown) => {
      if (cancelled || !v || typeof v !== 'object') return;
      const rec = v as { files?: Partial<EEditorFiles>; settings?: Partial<EEditorSettings> };
      const snapshot = JSON.stringify({ files: { ...DEFAULT_FILES, ...rec.files }, settings: { ...DEFAULT_SETTINGS, ...rec.settings } });
      // Skip our own echoed write (avoids clobbering while typing).
      if (snapshot === lastSaved.current) return;
      if (rec.files) setFiles((f) => ({ ...f, ...rec.files }));
      if (rec.settings) setSettings((s) => ({ ...s, ...rec.settings }));
    };

    void editorStore.getStatus().then((s) => { if (!cancelled) setSyncStatus(s); });
    void editorStore.getItem<{ files?: Partial<EEditorFiles>; settings?: Partial<EEditorSettings> }>(STORE_KEY).then(applyRemote);

    const offStatus = editorStore.onStatus((s) => { if (!cancelled) setSyncStatus(s); });
    const offChange = editorStore.subscribe((change) => {
      if (change.key !== STORE_KEY) return;
      void editorStore.getItem(STORE_KEY).then(applyRemote);
    });
    return () => {
      cancelled = true;
      offStatus();
      offChange();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild the sandboxed preview (debounced) when files change and auto-run is on.
  const rebuild = useCallback(() => {
    const blob = new Blob([composeDoc(files)], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    lastUrl.current = url;
    setPreviewUrl(url);
  }, [files]);

  useEffect(() => {
    if (!settings.autoRun) return;
    const t = setTimeout(rebuild, 400);
    return () => clearTimeout(t);
  }, [rebuild, settings.autoRun]);

  // First render / revoke on unmount.
  useEffect(() => {
    rebuild();
    return () => {
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const revealIssue = useCallback((issue: EditorAiIssue) => {
    setActive(issue.file);
    // Reveal after the editor swaps to the target file's model.
    setTimeout(() => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.revealLineInCenter(issue.line);
      ed.setPosition({ lineNumber: issue.line, column: 1 });
      ed.focus();
    }, 60);
  }, []);

  const applyFix = useCallback((issue: EditorAiIssue) => {
    if (typeof issue.fix !== 'string') return;
    const fix = issue.fix;
    setFiles((f) => {
      const lines = f[issue.file].split('\n');
      const idx = Math.min(Math.max(issue.line - 1, 0), lines.length - 1);
      lines[idx] = fix;
      return { ...f, [issue.file]: lines.join('\n') };
    });
    setIssues((list) => list.filter((i) => i !== issue));
  }, []);

  const applyAllFixes = useCallback(() => {
    setFiles((f) => {
      const next = { ...f };
      // Apply per file in descending line order so earlier edits don't shift later ones.
      (['html', 'css', 'js'] as FileKey[]).forEach((fk) => {
        const fixes = issues
          .filter((i) => i.file === fk && typeof i.fix === 'string')
          .sort((a, b) => b.line - a.line);
        if (!fixes.length) return;
        const lines = next[fk].split('\n');
        for (const fx of fixes) {
          const idx = Math.min(Math.max(fx.line - 1, 0), lines.length - 1);
          lines[idx] = fx.fix as string;
        }
        next[fk] = lines.join('\n');
      });
      return next;
    });
    setIssues((list) => list.filter((i) => typeof i.fix !== 'string'));
  }, [issues]);

  const runAnalyze = useCallback(async () => {
    setAnalyzing(true);
    setAiError(null);
    try {
      const res = (await invoke(IPC.EDITOR_AI_ANALYZE, {
        html: files.html,
        css: files.css,
        js: files.js,
        activeFile: active,
      })) as EditorAiAnalyzeResult;
      if (!res.ok) {
        setAiError(res.error ?? 'Analysis failed');
        setIssues([]);
        setAiSummary(null);
      } else {
        setIssues(res.issues);
        setAiSummary(res.summary ?? null);
      }
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  }, [files, active]);

  const skin = SKINS[settings.skin];
  const fixableCount = issues.filter((i) => typeof i.fix === 'string').length;
  const setSetting = <K extends keyof EEditorSettings>(k: K, v: EEditorSettings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }));

  const chip = (label: string, on: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        fontSize: 11, padding: '4px 9px', borderRadius: 6, cursor: 'pointer',
        border: `0.5px solid ${on ? settings.accent : skin.brd}`,
        color: on ? skin.text : skin.muted, background: 'transparent',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', background: skin.bg, color: skin.text, fontFamily: 'var(--font-sans, system-ui)' }}>
      {/* Top bar: brand + file tabs + actions */}
      <div style={{ display: 'flex', alignItems: 'center', background: skin.tab, borderBottom: `0.5px solid ${skin.brd}`, flexShrink: 0 }}>
        <span title="e-Editor" style={{ display: 'flex', alignItems: 'center', padding: '0 10px' }}>
          <EEditorIcon size={18} />
        </span>
        {(Object.keys(FILE_META) as FileKey[]).map((k) => {
          const m = FILE_META[k];
          const Icon = m.icon;
          const on = active === k;
          return (
            <button
              key={k}
              onClick={() => setActive(k)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', cursor: 'pointer',
                background: on ? skin.bg : 'transparent', border: 'none',
                borderRight: `0.5px solid ${skin.brd}`,
                color: on ? skin.text : skin.muted, fontSize: 12,
                boxShadow: on ? `inset 0 -2px 0 ${settings.accent}` : 'none',
              }}
            >
              <Icon size={13} style={{ color: m.color }} />
              {m.label}
            </button>
          );
        })}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, padding: '0 10px' }}>
          <button
            onClick={rebuild}
            title="Run"
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '4px 9px', borderRadius: 6, border: `0.5px solid ${skin.brd}`, background: settings.accent, color: '#1c260a', cursor: 'pointer' }}
          >
            <Play size={12} /> Run
          </button>
          <button
            onClick={() => setAiOpen((o) => !o)}
            title="AI review"
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '4px 9px', borderRadius: 6, border: `0.5px solid ${aiOpen ? settings.accent : skin.brd}`, background: 'transparent', color: aiOpen ? skin.text : skin.muted, cursor: 'pointer' }}
          >
            <Sparkles size={12} /> AI
          </button>
          <button
            onClick={() => setShowSettings((s) => !s)}
            title="Settings"
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '4px 9px', borderRadius: 6, border: `0.5px solid ${skin.brd}`, background: 'transparent', color: skin.muted, cursor: 'pointer' }}
          >
            <Settings2 size={12} /> Settings
          </button>
        </div>
      </div>

      {/* Body: editor | preview | (AI) */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: aiOpen ? '1fr 1fr 264px' : '1fr 1fr', minHeight: 0 }}>
        <div style={{ minWidth: 0, borderRight: `0.5px solid ${skin.brd}` }}>
          <Editor
            language={FILE_META[active].lang}
            theme={skin.monaco}
            value={files[active]}
            onMount={(ed) => { editorRef.current = ed; }}
            onChange={(v) => setFiles((f) => ({ ...f, [active]: v ?? '' }))}
            options={{
              fontFamily: settings.font,
              fontSize: settings.size,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbers: 'on',
              automaticLayout: true,
              tabSize: 2,
              padding: { top: 10 },
            }}
          />
        </div>
        <div style={{ minWidth: 0, background: '#fff' }}>
          <iframe
            title="preview"
            src={previewUrl}
            sandbox="allow-scripts allow-modals allow-popups"
            style={{ width: '100%', height: '100%', border: 'none' }}
          />
        </div>

        {aiOpen && (
          <aside style={{ minWidth: 0, background: skin.panel, borderLeft: `0.5px solid ${skin.brd}`, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: `0.5px solid ${skin.brd}` }}>
              <Sparkles size={13} style={{ color: settings.accent }} />
              <span style={{ fontSize: 12, fontWeight: 500 }}>AI Review</span>
              <button onClick={() => setAiOpen(false)} title="Close" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: skin.muted, cursor: 'pointer', display: 'flex' }}>
                <X size={14} />
              </button>
            </div>
            <div style={{ padding: '8px 10px' }}>
              <button
                onClick={runAnalyze}
                disabled={analyzing}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, padding: '7px', borderRadius: 6, border: 'none', background: settings.accent, color: '#1c260a', cursor: analyzing ? 'default' : 'pointer', opacity: analyzing ? 0.7 : 1 }}
              >
                {analyzing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                {analyzing ? 'Analyzing…' : 'Analyze code'}
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px 10px' }}>
              {aiError && (
                <div style={{ fontSize: 11, color: '#ff8a80', background: 'rgba(255,80,80,0.08)', border: '0.5px solid rgba(255,80,80,0.3)', borderRadius: 6, padding: 8 }}>{aiError}</div>
              )}
              {!aiError && aiSummary && <div style={{ fontSize: 11, color: skin.muted, marginBottom: 8 }}>{aiSummary}</div>}
              {!aiError && !analyzing && issues.length === 0 && aiSummary === null && (
                <div style={{ fontSize: 11, color: skin.muted }}>Run a review to find bugs and get one-click fixes.</div>
              )}
              {!aiError && issues.length === 0 && aiSummary !== null && (
                <div style={{ fontSize: 11, color: '#98c379' }}>No issues found ✓</div>
              )}
              {issues.map((issue, idx) => {
                const sevColor = issue.severity === 'error' ? '#e24b4a' : issue.severity === 'warning' ? '#e0b64b' : '#61afef';
                return (
                  <div key={idx} style={{ background: skin.tab, border: `0.5px solid ${skin.brd}`, borderRadius: 6, padding: 8, marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: sevColor, flexShrink: 0 }} />
                      <button onClick={() => revealIssue(issue)} style={{ fontSize: 11, color: skin.muted, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        {FILE_META[issue.file].label}:{issue.line}
                      </button>
                      {typeof issue.fix === 'string' && (
                        <button onClick={() => applyFix(issue)} title="Apply fix" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, padding: '2px 7px', borderRadius: 5, border: `0.5px solid ${skin.brd}`, background: 'transparent', color: skin.text, cursor: 'pointer' }}>
                          <Wand2 size={11} /> Fix
                        </button>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: skin.text, lineHeight: 1.4 }}>{issue.message}</div>
                  </div>
                );
              })}
            </div>
            {fixableCount > 1 && (
              <div style={{ padding: '8px 10px', borderTop: `0.5px solid ${skin.brd}` }}>
                <button onClick={applyAllFixes} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, padding: '7px', borderRadius: 6, border: 'none', background: settings.accent, color: '#1c260a', cursor: 'pointer' }}>
                  <Wand2 size={13} /> Fix all ({fixableCount})
                </button>
              </div>
            )}
          </aside>
        )}
      </div>

      {/* Status strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: settings.accent, color: '#1c260a', fontSize: 11, padding: '3px 12px', fontWeight: 500, flexShrink: 0 }}>
        <span>e-Editor</span>
        <span style={{ marginLeft: 'auto' }}>{settings.autoRun ? 'Auto-run' : 'Manual'}</span>
        <span>{syncStatus?.connected ? 'Postgres · synced' : 'Local only'}</span>
      </div>

      {/* Settings dropdown */}
      {showSettings && (
        <div style={{ position: 'absolute', top: 36, right: 10, width: 224, background: skin.panel, border: `0.5px solid ${skin.brd}`, borderRadius: 10, padding: 12, zIndex: 20, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
          <div style={{ fontSize: 11, color: skin.muted, letterSpacing: '.06em', marginBottom: 6 }}>SKIN</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {(['dark', 'grey', 'light'] as Skin[]).map((s) => chip(s[0].toUpperCase() + s.slice(1), settings.skin === s, () => setSetting('skin', s)))}
          </div>
          <div style={{ fontSize: 11, color: skin.muted, letterSpacing: '.06em', marginBottom: 6 }}>ACCENT</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {ACCENTS.map((c) => (
              <button
                key={c}
                onClick={() => setSetting('accent', c)}
                style={{ width: 22, height: 22, borderRadius: '50%', background: c, cursor: 'pointer', border: settings.accent === c ? '2px solid #fff' : '2px solid transparent' }}
              />
            ))}
          </div>
          <div style={{ fontSize: 11, color: skin.muted, letterSpacing: '.06em', marginBottom: 6 }}>FONT</div>
          <select
            value={settings.font}
            onChange={(e) => setSetting('font', e.target.value)}
            style={{ width: '100%', marginBottom: 12, fontSize: 12, background: skin.tab, color: skin.text, border: `0.5px solid ${skin.brd}`, borderRadius: 6, padding: '4px 6px' }}
          >
            {FONTS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <div style={{ fontSize: 11, color: skin.muted, letterSpacing: '.06em', marginBottom: 6 }}>
            SIZE <span style={{ color: skin.text }}>{settings.size}px</span>
          </div>
          <input type="range" min={11} max={20} step={1} value={settings.size} onChange={(e) => setSetting('size', Number(e.target.value))} style={{ width: '100%', marginBottom: 12 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: skin.text, cursor: 'pointer' }}>
            <input type="checkbox" checked={settings.autoRun} onChange={(e) => setSetting('autoRun', e.target.checked)} />
            Auto-run on edit
          </label>
        </div>
      )}
    </div>
  );
}

export default EEditor;
