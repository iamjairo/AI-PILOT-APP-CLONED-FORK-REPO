/**
 * @file e-Editor — a real, file-based code editor (VS Code / Zed / Pulsar style)
 * built on Monaco. Open a folder, browse its file tree, open files as CLOSEABLE
 * tabs, edit and save to disk. A live PREVIEW is an opt-in toggle (single-pane by
 * default — no split, no divider until Preview is on). A "Scratch" playground
 * preserves the old CodePen-style HTML/CSS/JS live experiment as one opt-in tab.
 *
 * Layout: [Explorer] | [Tab bar + Monaco] | [AI review]. Settings, status bar,
 * skins, and Postgres/localStorage persistence are carried over from the
 * previous playground implementation.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import {
  Play, Settings2, Code2, Hash, Braces, Sparkles, Wand2, Loader2, X,
  FileText, FileJson, File as FileIcon, Folder, FolderOpen, ChevronRight,
  ChevronDown, PanelLeft, Eye, FolderInput, FilePlus2,
  Command as CommandIcon, Search, CornerDownLeft,
  ListTree, Box, Package, Type,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import * as fuzzaldrin from 'fuzzaldrin-plus';
import { registerEEditorThemes, configureLanguageDefaults, monaco } from '../../lib/monaco-setup';
import { EEditorIcon } from './EEditorIcon';
import { invoke } from '../../lib/ipc-client';
import * as editorStore from '../../lib/editor-store-client';
import { IPC } from '../../../shared/ipc';
import type {
  EditorAiIssue, EditorAiAnalyzeResult, EditorStoreStatus, EEditorFileKey, FileNode,
} from '../../../shared/types';

type FileKey = EEditorFileKey; // 'html' | 'css' | 'js' (scratch sub-files)
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
  /** File-editor minimap on/off (Tier-1 toggle). */
  minimap: boolean;
  /** File-editor word-wrap on/off (Tier-1 toggle). */
  wordWrap: boolean;
}

/** Sentinel id for the single Scratch playground tab. */
const SCRATCH_ID = '::scratch::';

/** An open editor tab: either a real file on disk or the Scratch playground. */
interface OpenFileDoc {
  id: string; // absolute path
  kind: 'file';
  path: string;
  name: string;
  content: string;
  /** Content as last read/saved from disk — used to derive the dirty flag. */
  baseContent: string;
  language: string;
  loading: boolean;
  error: string | null;
  saveError: string | null;
}
interface OpenScratchDoc {
  id: typeof SCRATCH_ID;
  kind: 'scratch';
  name: string;
}
type OpenDoc = OpenFileDoc | OpenScratchDoc;

/** Persisted tab descriptor (file content is re-read from disk on restore). */
type PersistTab =
  | { kind: 'file'; path: string; name: string }
  | { kind: 'scratch' };

interface PersistedUi {
  showPreview: boolean;
  showExplorer: boolean;
  showOutline: boolean;
  splitPct: number;
}
interface PersistedState {
  files: EEditorFiles; // scratch content
  settings: EEditorSettings;
  folderPath: string | null;
  openTabs: PersistTab[];
  activeId: string | null;
  ui: PersistedUi;
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
  minimap: true,
  wordWrap: false,
};

const DEFAULT_UI: PersistedUi = { showPreview: false, showExplorer: true, showOutline: false, splitPct: 50 };

const SKINS: Record<Skin, Record<string, string>> = {
  dark: { bg: '#0f1117', panel: '#12151e', tab: '#0d0f16', text: '#e7e9ee', muted: '#9aa0ac', brd: '#262a35', monaco: 'eeditor-dark', hover: '#1a1e29' },
  grey: { bg: '#2a2a30', panel: '#2e2e35', tab: '#26262c', text: '#d6d7dc', muted: '#9a9ba4', brd: '#3a3a42', monaco: 'eeditor-grey', hover: '#33333b' },
  light: { bg: '#eeeee9', panel: '#f6f6f3', tab: '#ffffff', text: '#26262c', muted: '#6b6b73', brd: '#dcdcd6', monaco: 'eeditor-light', hover: '#e6e6e0' },
};

const ACCENTS = ['#b5d94a', '#388eff', '#a87cff', '#fc923c', '#f472b6', '#3cc8dc'];
const FONTS = [
  { label: 'JetBrains Mono', value: "'JetBrains Mono', ui-monospace, monospace" },
  { label: 'Fira Code', value: "'Fira Code', ui-monospace, monospace" },
  { label: 'SF Mono', value: "'SF Mono', ui-monospace, monospace" },
  { label: 'Menlo', value: 'Menlo, ui-monospace, monospace' },
];

const SCRATCH_META: Record<FileKey, { label: string; lang: string; icon: LucideIcon; color: string }> = {
  html: { label: 'index.html', lang: 'html', icon: Code2, color: '#e2703a' },
  css: { label: 'styles.css', lang: 'css', icon: Hash, color: '#4b8bbe' },
  js: { label: 'script.js', lang: 'javascript', icon: Braces, color: '#e8d44d' },
};

/** Map a file extension to a Monaco language id (default plaintext). */
function languageFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts': return 'typescript';
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript';
    case 'json': return 'json';
    case 'html': case 'htm': return 'html';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'less': return 'less';
    case 'md': case 'mdx': case 'markdown': return 'markdown';
    case 'py': return 'python';
    case 'rs': return 'rust';
    case 'go': return 'go';
    case 'yaml': case 'yml': return 'yaml';
    case 'toml': return 'ini';
    case 'sh': case 'bash': case 'zsh': return 'shell';
    case 'sql': return 'sql';
    case 'xml': case 'svg': return 'xml';
    case 'c': case 'h': return 'c';
    case 'cpp': case 'cc': case 'cxx': case 'hpp': return 'cpp';
    case 'java': return 'java';
    case 'rb': return 'ruby';
    case 'php': return 'php';
    default: return 'plaintext';
  }
}

/** Pick a lucide icon + tint for a file by extension. */
function iconForFile(name: string): { Icon: LucideIcon; color: string } {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts': return { Icon: Code2, color: '#4b8bbe' };
    case 'js': case 'jsx': case 'mjs': case 'cjs': return { Icon: Braces, color: '#e8d44d' };
    case 'json': return { Icon: FileJson, color: '#cb8f3a' };
    case 'html': case 'htm': return { Icon: Code2, color: '#e2703a' };
    case 'css': case 'scss': case 'less': return { Icon: Hash, color: '#4b8bbe' };
    case 'md': case 'mdx': case 'markdown': return { Icon: FileText, color: '#8aa0b6' };
    default: return { Icon: FileIcon, color: '#8a8f9a' };
  }
}

function isHtmlPath(path: string): boolean {
  const p = path.toLowerCase();
  return p.endsWith('.html') || p.endsWith('.htm');
}

function loadPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return {
        files: { ...DEFAULT_FILES, ...(parsed.files ?? {}) },
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
        folderPath: parsed.folderPath ?? null,
        openTabs: Array.isArray(parsed.openTabs) ? parsed.openTabs : [],
        activeId: parsed.activeId ?? null,
        ui: { ...DEFAULT_UI, ...(parsed.ui ?? {}) },
      };
    }
  } catch {
    /* corrupt storage — fall back to defaults */
  }
  return { files: DEFAULT_FILES, settings: DEFAULT_SETTINGS, folderPath: null, openTabs: [], activeId: null, ui: DEFAULT_UI };
}

function composeScratchDoc(files: EEditorFiles): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${files.css}</style></head><body>${files.html}<script>${files.js}<\/script></body></html>`;
}

const isDirty = (d: OpenDoc): boolean => d.kind === 'file' && d.content !== d.baseContent;

// ── Snippets ───────────────────────────────────────────────────────────────
interface SnippetDef {
  /** Trigger word shown in the completion list. */
  label: string;
  /** Snippet body with ${1:placeholder} tab-stops. */
  insertText: string;
  /** One-line description shown beside the label. */
  detail: string;
}

/** A small curated snippet set, keyed by Monaco language id. */
const SNIPPETS: Record<string, SnippetDef[]> = {
  html: [
    {
      label: 'html5',
      detail: 'HTML5 boilerplate',
      insertText:
        '<!doctype html>\n<html lang="${1:en}">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${2:Document}</title>\n</head>\n<body>\n  ${0}\n</body>\n</html>',
    },
    { label: 'div', detail: 'div with class', insertText: '<div class="${1:}">${0}</div>' },
    { label: 'a', detail: 'anchor', insertText: '<a href="${1:#}">${0:text}</a>' },
    { label: 'img', detail: 'image', insertText: '<img src="${1:src}" alt="${2:alt}">${0}' },
  ],
  css: [
    {
      label: 'flex-center',
      detail: 'flexbox centering',
      insertText: 'display: flex;\nalign-items: center;\njustify-content: center;${0}',
    },
    {
      label: 'media',
      detail: 'media query',
      insertText: '@media (max-width: ${1:768px}) {\n  ${0}\n}',
    },
  ],
  javascript: [
    { label: 'log', detail: 'console.log', insertText: "console.log(${1:'${2:value}'}, ${3:value});$0" },
    { label: 'fn', detail: 'function', insertText: 'function ${1:name}(${2:args}) {\n  ${0}\n}' },
    { label: 'arrow', detail: 'arrow function', insertText: 'const ${1:name} = (${2:args}) => {\n  ${0}\n};' },
    { label: 'for', detail: 'for loop', insertText: 'for (let ${1:i} = 0; ${1:i} < ${2:len}; ${1:i}++) {\n  ${0}\n}' },
    { label: 'ternary', detail: 'ternary expression', insertText: '${1:cond} ? ${2:a} : ${3:b}$0' },
    { label: 'import', detail: 'import statement', insertText: "import ${1:name} from '${2:module}';$0" },
  ],
  typescript: [
    { label: 'log', detail: 'console.log', insertText: "console.log(${1:'${2:value}'}, ${3:value});$0" },
    { label: 'fn', detail: 'function', insertText: 'function ${1:name}(${2:args}): ${3:void} {\n  ${0}\n}' },
    { label: 'arrow', detail: 'arrow function', insertText: 'const ${1:name} = (${2:args}): ${3:void} => {\n  ${0}\n};' },
    { label: 'for', detail: 'for loop', insertText: 'for (let ${1:i} = 0; ${1:i} < ${2:len}; ${1:i}++) {\n  ${0}\n}' },
    { label: 'ternary', detail: 'ternary expression', insertText: '${1:cond} ? ${2:a} : ${3:b}$0' },
    { label: 'import', detail: 'import statement', insertText: "import ${1:name} from '${2:module}';$0" },
  ],
  json: [
    { label: 'obj', detail: 'object', insertText: '{\n  "${1:key}": "${2:value}"$0\n}' },
    { label: 'arr', detail: 'array', insertText: '[\n  ${0}\n]' },
  ],
};

let snippetsRegistered = false;

/** Register the curated snippet set once (guarded against StrictMode remounts). */
function registerEEditorSnippets(): void {
  if (snippetsRegistered) return;
  snippetsRegistered = true;
  for (const [lang, defs] of Object.entries(SNIPPETS)) {
    monaco.languages.registerCompletionItemProvider(lang, {
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        const range: monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const suggestions: monaco.languages.CompletionItem[] = defs.map((d) => ({
          label: d.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: d.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: d.detail,
          documentation: { value: '```\n' + d.insertText.replace(/\$\{\d+:?([^}]*)\}/g, '$1').replace(/\$0/g, '') + '\n```' },
          range,
        }));
        return { suggestions };
      },
    });
  }
}

// ── File-tree flattening (for quick-open) ───────────────────────────────────
interface FlatFile {
  path: string;
  name: string;
  /** Path relative to the open folder (used as the fuzzy-match key). */
  rel: string;
}

/** Depth-first flatten of the Explorer tree into a list of files only. */
function flattenTree(nodes: FileNode[], folderPath: string | null): FlatFile[] {
  const base = folderPath ? folderPath.replace(/\/+$/, '') + '/' : '';
  const out: FlatFile[] = [];
  const walk = (list: FileNode[]) => {
    for (const n of list) {
      if (n.type === 'directory') {
        if (n.children) walk(n.children);
      } else {
        const rel = base && n.path.startsWith(base) ? n.path.slice(base.length) : n.name;
        out.push({ path: n.path, name: n.name, rel });
      }
    }
  };
  walk(nodes);
  return out;
}

// ── Document symbols (Outline panel + breadcrumbs) ──────────────────────────
type DocSymbol = monaco.languages.DocumentSymbol;

/** Minimal shape of Monaco's internal command service (used to reach the
 *  generic document-symbol provider command). */
interface CommandServiceLike {
  executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T>;
}

/** Sort a symbol tree into document order (top-down), recursively. */
function sortSymbols(symbols: DocSymbol[]): DocSymbol[] {
  const sorted = [...symbols].sort((a, b) =>
    a.range.startLineNumber - b.range.startLineNumber || a.range.startColumn - b.range.startColumn);
  for (const s of sorted) if (s.children?.length) s.children = sortSymbols(s.children);
  return sorted;
}

/**
 * Fetch document symbols for the editor's active model. Uses Monaco's internal
 * `_executeDocumentSymbolProvider` command (registered by the built-in
 * documentSymbols contribution) — the one path that returns symbols for EVERY
 * built-in language (TS/JS/JSON/CSS/HTML), not just TS/JS. Fully defensive:
 * returns [] if the command service or provider is unavailable.
 */
async function fetchDocumentSymbols(editor: monaco.editor.ICodeEditor): Promise<DocSymbol[]> {
  const model = editor.getModel();
  if (!model) return [];
  const svc = (editor as unknown as { _commandService?: CommandServiceLike })._commandService;
  if (!svc) return [];
  try {
    const symbols = await svc.executeCommand<DocSymbol[] | undefined>('_executeDocumentSymbolProvider', model.uri);
    return Array.isArray(symbols) ? sortSymbols(symbols) : [];
  } catch {
    return [];
  }
}

/** True if a 1-based (line, column) position falls inside a Monaco range. */
function rangeContains(range: monaco.IRange, line: number, col: number): boolean {
  if (line < range.startLineNumber || line > range.endLineNumber) return false;
  if (line === range.startLineNumber && col < range.startColumn) return false;
  if (line === range.endLineNumber && col > range.endColumn) return false;
  return true;
}

/** Deepest-first chain of symbols whose ranges contain the cursor (breadcrumbs). */
function findSymbolChain(symbols: DocSymbol[], pos: monaco.IPosition): DocSymbol[] {
  const chain: DocSymbol[] = [];
  let level = symbols;
  for (;;) {
    const match = level.find((s) => rangeContains(s.range, pos.lineNumber, pos.column));
    if (!match) break;
    chain.push(match);
    if (!match.children || match.children.length === 0) break;
    level = match.children;
  }
  return chain;
}

/** Map a symbol kind to a lucide icon + tint for the Outline tree. */
function symbolKindMeta(kind: monaco.languages.SymbolKind): { Icon: LucideIcon; color: string } {
  const SK = monaco.languages.SymbolKind;
  switch (kind) {
    case SK.Class: case SK.Interface: case SK.Struct: case SK.Object:
      return { Icon: Box, color: '#e0b64b' };
    case SK.Method: case SK.Function: case SK.Constructor:
      return { Icon: Braces, color: '#a87cff' };
    case SK.Module: case SK.Namespace: case SK.Package:
      return { Icon: Package, color: '#61afef' };
    case SK.Enum: case SK.EnumMember: case SK.Number: case SK.Constant:
      return { Icon: Hash, color: '#e2703a' };
    case SK.Property: case SK.Field: case SK.Variable: case SK.Key:
      return { Icon: Type, color: '#4b8bbe' };
    default:
      return { Icon: Type, color: '#8a8f9a' };
  }
}

// ── Command palette ─────────────────────────────────────────────────────────
interface PaletteCommand {
  id: string;
  title: string;
  hint?: string;
  run: () => void;
}

interface ModalTheme {
  skin: Record<string, string>;
  accent: string;
}

/** Shared overlay + panel shell for the palette / quick-open modals. */
function ModalShell({ skin, children, onClose }: ModalTheme & { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onMouseDown={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 40, display: 'flex', alignItems: 'flex-start',
        justifyContent: 'center', paddingTop: '10vh', background: 'rgba(0,0,0,0.42)',
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 'min(620px, 82%)', background: skin.panel, border: `0.5px solid ${skin.brd}`,
          borderRadius: 12, boxShadow: '0 18px 50px rgba(0,0,0,0.55)', overflow: 'hidden',
          display: 'flex', flexDirection: 'column', maxHeight: '68vh',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function CommandPalette({ skin, accent, commands, onClose }: ModalTheme & { commands: PaletteCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo<PaletteCommand[]>(() => {
    const q = query.trim();
    if (!q) return commands;
    return fuzzaldrin.filter(commands, q, { key: 'title', maxResults: 50 });
  }, [query, commands]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = results[active]; if (c) { onClose(); c.run(); } }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <ModalShell skin={skin} accent={accent} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `0.5px solid ${skin.brd}` }}>
        <CommandIcon size={15} style={{ color: accent, flexShrink: 0 }} />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Type a command…"
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: skin.text, fontSize: 14 }}
        />
      </div>
      <div ref={listRef} style={{ overflowY: 'auto' }}>
        {results.length === 0 && (
          <div style={{ padding: '14px 16px', fontSize: 12, color: skin.muted }}>No matching commands</div>
        )}
        {results.map((c, i) => (
          <div
            key={c.id}
            data-idx={i}
            onMouseMove={() => setActive(i)}
            onClick={() => { onClose(); c.run(); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', cursor: 'pointer',
              background: i === active ? skin.hover : 'transparent',
              borderLeft: `2px solid ${i === active ? accent : 'transparent'}`,
            }}
          >
            <span style={{ fontSize: 13, color: skin.text, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span>
            {c.hint && <span style={{ fontSize: 11, color: skin.muted, flexShrink: 0 }}>{c.hint}</span>}
            {i === active && <CornerDownLeft size={12} style={{ color: skin.muted, flexShrink: 0 }} />}
          </div>
        ))}
      </div>
    </ModalShell>
  );
}

function QuickOpen({
  skin, accent, files, hasFolder, onPick, onClose,
}: ModalTheme & { files: FlatFile[]; hasFolder: boolean; onPick: (path: string, name: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo<FlatFile[]>(() => {
    const q = query.trim();
    if (!q) return files.slice(0, 100);
    return fuzzaldrin.filter(files, q, { key: 'rel', maxResults: 100 });
  }, [query, files]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const f = results[active]; if (f) { onClose(); onPick(f.path, f.name); } }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <ModalShell skin={skin} accent={accent} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `0.5px solid ${skin.brd}` }}>
        <Search size={15} style={{ color: accent, flexShrink: 0 }} />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={hasFolder ? 'Go to file…' : 'Open a folder to search its files'}
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: skin.text, fontSize: 14 }}
        />
      </div>
      <div ref={listRef} style={{ overflowY: 'auto' }}>
        {!hasFolder && (
          <div style={{ padding: '14px 16px', fontSize: 12, color: skin.muted }}>No folder open. Use “Open Folder” first.</div>
        )}
        {hasFolder && results.length === 0 && (
          <div style={{ padding: '14px 16px', fontSize: 12, color: skin.muted }}>No matching files</div>
        )}
        {results.map((f, i) => {
          const dir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
          const { Icon, color } = iconForFile(f.name);
          return (
            <div
              key={f.path}
              data-idx={i}
              onMouseMove={() => setActive(i)}
              onClick={() => { onClose(); onPick(f.path, f.name); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', cursor: 'pointer',
                background: i === active ? skin.hover : 'transparent',
                borderLeft: `2px solid ${i === active ? accent : 'transparent'}`,
              }}
            >
              <Icon size={14} style={{ color, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: skin.text, flexShrink: 0 }}>{f.name}</span>
              {dir && <span style={{ fontSize: 11, color: skin.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{dir}</span>}
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}

export function EEditor() {
  const initial = useMemo(loadPersisted, []);

  // ── Core editor state ──────────────────────────────────────────────────
  const [settings, setSettings] = useState<EEditorSettings>(initial.settings);
  const [folderPath, setFolderPath] = useState<string | null>(initial.folderPath);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [openDocs, setOpenDocs] = useState<OpenDoc[]>(() =>
    initial.openTabs.map<OpenDoc>((t) =>
      t.kind === 'scratch'
        ? { id: SCRATCH_ID, kind: 'scratch', name: 'Scratch' }
        : { id: t.path, kind: 'file', path: t.path, name: t.name, content: '', baseContent: '', language: languageFromPath(t.path), loading: true, error: null, saveError: null },
    ),
  );
  const [activeId, setActiveId] = useState<string | null>(initial.activeId);

  // Scratch playground state
  const [scratchFiles, setScratchFiles] = useState<EEditorFiles>(initial.files);
  const [scratchActive, setScratchActive] = useState<FileKey>('html');

  // ── UI toggles ─────────────────────────────────────────────────────────
  const [showExplorer, setShowExplorer] = useState(initial.ui.showExplorer);
  const [showPreview, setShowPreview] = useState(initial.ui.showPreview);
  const [showOutline, setShowOutline] = useState(initial.ui.showOutline);
  const [showSettings, setShowSettings] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  // ── Outline / breadcrumbs (document symbols from Monaco's language services) ─
  const [symbols, setSymbols] = useState<DocSymbol[]>([]);
  const [crumbs, setCrumbs] = useState<DocSymbol[]>([]);
  const symbolsRef = useRef<DocSymbol[]>([]);
  const outlineDisposables = useRef<monaco.IDisposable[]>([]);
  const outlineTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Paths whose models have already been pre-loaded into the TS language service.
  const preloadedModels = useRef<Set<string>>(new Set());

  // ── Command palette / quick-open modals + reopen-closed stack ───────────
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const closedStackRef = useRef<{ path: string; name: string }[]>([]);

  // ── AI review state ────────────────────────────────────────────────────
  const [analyzing, setAnalyzing] = useState(false);
  const [issues, setIssues] = useState<EditorAiIssue[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const [syncStatus, setSyncStatus] = useState<EditorStoreStatus | null>(null);

  // ── Preview blob urls ──────────────────────────────────────────────────
  const [scratchUrl, setScratchUrl] = useState('');
  const [fileUrl, setFileUrl] = useState('');
  const scratchUrlRef = useRef('');
  const fileUrlRef = useRef('');

  // ── Draggable split (only exists while a preview pane is shown) ─────────
  const [splitPct, setSplitPct] = useState(initial.ui.splitPct);
  const [dragging, setDragging] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // The preview iframe swallows mouse events, freezing the drag once the
    // cursor moves over it. Flag a drag so the iframe is set pointer-events:none
    // (see the preview pane) — mousemove then keeps reaching the window.
    setDragging(true);
    const onMove = (ev: MouseEvent) => {
      const rect = bodyRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.max(15, Math.min(85, pct)));
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const activeDoc = openDocs.find((d) => d.id === activeId) ?? null;
  const skin = SKINS[settings.skin];

  useEffect(() => {
    registerEEditorThemes();
    registerEEditorSnippets();
    configureLanguageDefaults();
  }, []);

  // ── Outline + breadcrumbs plumbing ─────────────────────────────────────────
  // Re-read document symbols for the active model (debounced on edits).
  const refreshOutline = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) { symbolsRef.current = []; setSymbols([]); setCrumbs([]); return; }
    void fetchDocumentSymbols(ed).then((syms) => {
      if (editorRef.current !== ed) return; // editor swapped underneath us
      symbolsRef.current = syms;
      setSymbols(syms);
      const pos = ed.getPosition();
      setCrumbs(pos ? findSymbolChain(syms, pos) : []);
    });
  }, []);

  const scheduleOutline = useCallback(() => {
    if (outlineTimer.current) clearTimeout(outlineTimer.current);
    outlineTimer.current = setTimeout(refreshOutline, 250);
  }, [refreshOutline]);

  // Cheap breadcrumb update on cursor move (reuses the cached symbol tree).
  const updateCrumbs = useCallback(() => {
    const pos = editorRef.current?.getPosition();
    setCrumbs(pos ? findSymbolChain(symbolsRef.current, pos) : []);
  }, []);

  // Shared onMount for every Monaco instance (file + scratch): keeps editorRef
  // current, wires outline/breadcrumb listeners, and seeds the first read.
  const handleEditorMount = useCallback<OnMount>((ed) => {
    editorRef.current = ed;
    outlineDisposables.current.forEach((d) => d.dispose());
    outlineDisposables.current = [
      ed.onDidChangeModel(() => scheduleOutline()),
      ed.onDidChangeModelContent(() => scheduleOutline()),
      ed.onDidChangeCursorPosition(() => updateCrumbs()),
    ];
    refreshOutline();
  }, [scheduleOutline, updateCrumbs, refreshOutline]);

  // Reveal + select a symbol's range in the editor (Outline / breadcrumb click).
  const revealSymbol = useCallback((sym: DocSymbol) => {
    const ed = editorRef.current;
    if (!ed) return;
    const r = sym.selectionRange ?? sym.range;
    ed.revealRangeInCenter(r);
    ed.setSelection(sym.range);
    ed.setPosition({ lineNumber: r.startLineNumber, column: r.startColumn });
    ed.focus();
  }, []);

  // Run a built-in Monaco editor action (Go to Definition, Rename, Format, …).
  const runEditorAction = useCallback((id: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.focus();
    const action = ed.getAction(id);
    if (action) void action.run();
  }, []);

  useEffect(() => () => {
    outlineDisposables.current.forEach((d) => d.dispose());
    if (outlineTimer.current) clearTimeout(outlineTimer.current);
  }, []);

  // ── Project model pre-load (multi-file TS/JS awareness) ────────────────────
  // Best-effort: eagerly load the folder's .ts/.tsx files into Monaco models so
  // the TS language service can resolve types + go-to-definition across the
  // whole project (not just open tabs). Capped and node_modules-skipped to guard
  // cost; each file is read once (deduped) and reuses the SAME URI scheme
  // (`monaco.Uri.parse(absPath)`) that @monaco-editor/react keys tab models with,
  // so an opened tab transparently adopts the pre-loaded model.
  const preloadProjectModels = useCallback(async (nodes: FileNode[]) => {
    const targets = flattenTree(nodes, null)
      .filter((f) => {
        const p = f.path.toLowerCase();
        if (p.includes('/node_modules/') || p.includes('/.git/') || p.includes('/dist/') || p.includes('/out/')) return false;
        return /\.(ts|tsx)$/.test(p);
      })
      .slice(0, 200); // cap ~200 files
    for (const f of targets) {
      if (preloadedModels.current.has(f.path)) continue;
      preloadedModels.current.add(f.path);
      const uri = monaco.Uri.parse(f.path);
      if (monaco.editor.getModel(uri)) continue;
      try {
        const res = (await invoke(IPC.PROJECT_READ_FILE, f.path)) as { content?: string };
        if (typeof res.content === 'string' && !monaco.editor.getModel(uri)) {
          monaco.editor.createModel(res.content, languageFromPath(f.path), uri);
        }
      } catch {
        /* best-effort — a failed read just leaves that file un-preloaded */
      }
    }
  }, []);

  // ── File tree ──────────────────────────────────────────────────────────
  const refreshTree = useCallback(async (): Promise<FileNode[]> => {
    try {
      const nodes = (await invoke(IPC.PROJECT_FILE_TREE)) as FileNode[];
      const arr = Array.isArray(nodes) ? nodes : [];
      setTree(arr);
      return arr;
    } catch {
      setTree([]);
      return [];
    }
  }, []);

  const openFolder = useCallback(async () => {
    const path = (await invoke(IPC.PROJECT_OPEN_DIALOG)) as string | null;
    if (!path) return;
    setFolderPath(path);
    setExpanded(new Set());
    const nodes = await refreshTree();
    void preloadProjectModels(nodes);
  }, [refreshTree, preloadProjectModels]);

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // ── Open / close / activate tabs ───────────────────────────────────────
  const readFileInto = useCallback(async (path: string) => {
    try {
      const res = (await invoke(IPC.PROJECT_READ_FILE, path)) as { content?: string; error?: string };
      setOpenDocs((docs) => docs.map((d) =>
        d.id === path && d.kind === 'file'
          ? { ...d, loading: false, content: res.content ?? '', baseContent: res.content ?? '', error: res.error ?? null }
          : d,
      ));
    } catch (e) {
      setOpenDocs((docs) => docs.map((d) =>
        d.id === path && d.kind === 'file' ? { ...d, loading: false, error: e instanceof Error ? e.message : String(e) } : d,
      ));
    }
  }, []);

  const openFile = useCallback((path: string, name: string) => {
    let exists = false;
    setOpenDocs((docs) => {
      if (docs.some((d) => d.id === path)) { exists = true; return docs; }
      const doc: OpenFileDoc = {
        id: path, kind: 'file', path, name, content: '', baseContent: '',
        language: languageFromPath(path), loading: true, error: null, saveError: null,
      };
      return [...docs, doc];
    });
    setActiveId(path);
    if (!exists) void readFileInto(path);
  }, [readFileInto]);

  const openScratch = useCallback(() => {
    setOpenDocs((docs) => (docs.some((d) => d.kind === 'scratch') ? docs : [...docs, { id: SCRATCH_ID, kind: 'scratch', name: 'Scratch' }]));
    setActiveId(SCRATCH_ID);
  }, []);

  const closeDoc = useCallback((id: string) => {
    setOpenDocs((docs) => {
      const idx = docs.findIndex((d) => d.id === id);
      if (idx === -1) return docs;
      const closing = docs[idx];
      // Record closed real files so ⌘⇧T can reopen them (LIFO, capped at 20).
      if (closing.kind === 'file') {
        const stack = closedStackRef.current.filter((e) => e.path !== closing.path);
        stack.push({ path: closing.path, name: closing.name });
        closedStackRef.current = stack.slice(-20);
      }
      const next = docs.filter((d) => d.id !== id);
      setActiveId((cur) => {
        if (cur !== id) return cur;
        const fallback = next[idx] ?? next[idx - 1] ?? null;
        return fallback ? fallback.id : null;
      });
      return next;
    });
  }, []);

  const reopenClosed = useCallback(() => {
    const entry = closedStackRef.current.pop();
    if (entry) openFile(entry.path, entry.name);
  }, [openFile]);

  // ── Save (Cmd/Ctrl+S) ──────────────────────────────────────────────────
  const saveActive = useCallback(async () => {
    const doc = openDocs.find((d) => d.id === activeId);
    if (!doc || doc.kind !== 'file' || doc.content === doc.baseContent) return;
    const path = doc.path;
    const content = doc.content;
    try {
      const res = (await invoke(IPC.PROJECT_WRITE_FILE, path, content)) as { ok?: boolean; error?: string };
      setOpenDocs((docs) => docs.map((d) =>
        d.id === path && d.kind === 'file'
          ? (res.ok
              ? { ...d, baseContent: content, saveError: null }
              : { ...d, saveError: res.error ?? 'Save failed' })
          : d,
      ));
    } catch (e) {
      setOpenDocs((docs) => docs.map((d) =>
        d.id === path && d.kind === 'file' ? { ...d, saveError: e instanceof Error ? e.message : String(e) } : d,
      ));
    }
  }, [openDocs, activeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        // Only intercept when a real file is active (scratch persists automatically).
        const doc = openDocs.find((d) => d.id === activeId);
        if (doc && doc.kind === 'file') {
          e.preventDefault();
          void saveActive();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveActive, openDocs, activeId]);

  // ── Tier-1 shortcuts: ⌘P quick-open, ⌘⇧P palette, ⌘⇧T reopen ─────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.code === 'KeyP' && e.shiftKey) {
        e.preventDefault();
        setQuickOpenOpen(false);
        setPaletteOpen((v) => !v);
      } else if (e.code === 'KeyP') {
        e.preventDefault();
        setPaletteOpen(false);
        setQuickOpenOpen((v) => !v);
      } else if (e.code === 'KeyT' && e.shiftKey) {
        e.preventDefault();
        reopenClosed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reopenClosed]);

  // ── Persistence ────────────────────────────────────────────────────────
  const lastFilesSettings = useRef<string>('');
  useEffect(() => {
    const t = setTimeout(() => {
      const openTabs: PersistTab[] = openDocs.map((d) =>
        d.kind === 'scratch' ? { kind: 'scratch' } : { kind: 'file', path: d.path, name: d.name },
      );
      lastFilesSettings.current = JSON.stringify({ files: scratchFiles, settings });
      const snapshot: PersistedState = {
        files: scratchFiles, settings, folderPath, openTabs, activeId,
        ui: { showPreview, showExplorer, showOutline, splitPct },
      };
      void editorStore.setItem(STORE_KEY, snapshot);
    }, 400);
    return () => clearTimeout(t);
  }, [scratchFiles, settings, folderPath, openDocs, activeId, showPreview, showExplorer, showOutline, splitPct]);

  // On mount: restore folder tree + open-file contents; wire cross-device sync
  // for scratch content + settings (tabs/folder are restored on load only, to
  // avoid yanking the user's open files when another device edits).
  useEffect(() => {
    let cancelled = false;

    // Restore file tree for a previously-open folder (best-effort — depends on
    // the app's current project still being set to it).
    if (initial.folderPath) void refreshTree().then((nodes) => preloadProjectModels(nodes));
    // Re-read contents for restored file tabs.
    for (const t of initial.openTabs) {
      if (t.kind === 'file') void readFileInto(t.path);
    }

    const applyRemote = (v: unknown) => {
      if (cancelled || !v || typeof v !== 'object') return;
      const rec = v as Partial<PersistedState>;
      const snapshot = JSON.stringify({
        files: { ...DEFAULT_FILES, ...rec.files },
        settings: { ...DEFAULT_SETTINGS, ...rec.settings },
      });
      if (snapshot === lastFilesSettings.current) return; // skip our own echo
      if (rec.files) setScratchFiles((f) => ({ ...f, ...rec.files }));
      if (rec.settings) setSettings((s) => ({ ...s, ...rec.settings }));
    };

    void editorStore.getStatus().then((s) => { if (!cancelled) setSyncStatus(s); });
    void editorStore.getItem<Partial<PersistedState>>(STORE_KEY).then(applyRemote);

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

  // ── Scratch live preview (auto-run, debounced) ─────────────────────────
  const rebuildScratch = useCallback(() => {
    const blob = new Blob([composeScratchDoc(scratchFiles)], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    if (scratchUrlRef.current) URL.revokeObjectURL(scratchUrlRef.current);
    scratchUrlRef.current = url;
    setScratchUrl(url);
  }, [scratchFiles]);

  useEffect(() => {
    if (!settings.autoRun) return;
    const t = setTimeout(rebuildScratch, 400);
    return () => clearTimeout(t);
  }, [rebuildScratch, settings.autoRun]);

  useEffect(() => () => {
    if (scratchUrlRef.current) URL.revokeObjectURL(scratchUrlRef.current);
    if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current);
  }, []);

  // ── File preview (opt-in; only for .html files) ────────────────────────
  const activeFileContent = activeDoc?.kind === 'file' ? activeDoc.content : null;
  const activeFileIsHtml = activeDoc?.kind === 'file' && isHtmlPath(activeDoc.path);
  useEffect(() => {
    if (!showPreview || !activeFileIsHtml || activeFileContent == null) { setFileUrl(''); return; }
    const t = setTimeout(() => {
      const blob = new Blob([activeFileContent], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current);
      fileUrlRef.current = url;
      setFileUrl(url);
    }, 300);
    return () => clearTimeout(t);
  }, [showPreview, activeFileIsHtml, activeFileContent, activeId]);

  // ── AI review (operates on the scratch playground files) ───────────────
  const revealIssue = useCallback((issue: EditorAiIssue) => {
    openScratch();
    setScratchActive(issue.file);
    setTimeout(() => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.revealLineInCenter(issue.line);
      ed.setPosition({ lineNumber: issue.line, column: 1 });
      ed.focus();
    }, 80);
  }, [openScratch]);

  const applyFix = useCallback((issue: EditorAiIssue) => {
    if (typeof issue.fix !== 'string') return;
    const fix = issue.fix;
    setScratchFiles((f) => {
      const lines = f[issue.file].split('\n');
      const idx = Math.min(Math.max(issue.line - 1, 0), lines.length - 1);
      lines[idx] = fix;
      return { ...f, [issue.file]: lines.join('\n') };
    });
    setIssues((list) => list.filter((i) => i !== issue));
  }, []);

  const applyAllFixes = useCallback(() => {
    setScratchFiles((f) => {
      const next = { ...f };
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
        html: scratchFiles.html,
        css: scratchFiles.css,
        js: scratchFiles.js,
        activeFile: scratchActive,
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
  }, [scratchFiles, scratchActive]);

  const fixableCount = issues.filter((i) => typeof i.fix === 'string').length;
  const setSetting = <K extends keyof EEditorSettings>(k: K, v: EEditorSettings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }));

  // Flattened file list for quick-open (memoized off the Explorer tree).
  const flatFiles = useMemo(() => flattenTree(tree, folderPath), [tree, folderPath]);

  // Command-palette command set (APP + editor-tab actions + theme switches).
  const commands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [
      { id: 'open-folder', title: 'Open Folder', hint: 'Explorer', run: () => void openFolder() },
      { id: 'new-scratch', title: 'New Scratch', run: openScratch },
      { id: 'toggle-preview', title: 'Toggle Preview', run: () => setShowPreview((v) => !v) },
      { id: 'toggle-outline', title: 'Toggle Outline', run: () => setShowOutline((v) => !v) },
      { id: 'toggle-ai', title: 'Toggle AI Review', run: () => setAiOpen((v) => !v) },
      { id: 'toggle-explorer', title: 'Toggle Explorer', run: () => setShowExplorer((v) => !v) },
      { id: 'save-file', title: 'Save File', hint: '⌘S', run: () => void saveActive() },
      { id: 'close-tab', title: 'Close Tab', run: () => { if (activeId) closeDoc(activeId); } },
      { id: 'reopen-tab', title: 'Reopen Closed Tab', hint: '⌘⇧T', run: reopenClosed },
      { id: 'go-to-file', title: 'Go to File…', hint: '⌘P', run: () => setQuickOpenOpen(true) },
      // ── Language-intelligence actions (Monaco built-in editor actions) ──────
      { id: 'go-to-definition', title: 'Go to Definition', hint: 'F12', run: () => runEditorAction('editor.action.revealDefinition') },
      { id: 'rename-symbol', title: 'Rename Symbol', hint: 'F2', run: () => runEditorAction('editor.action.rename') },
      { id: 'format-document', title: 'Format Document', hint: '⇧⌥F', run: () => runEditorAction('editor.action.formatDocument') },
      { id: 'quick-fix', title: 'Quick Fix', hint: '⌘.', run: () => runEditorAction('editor.action.quickFix') },
      { id: 'go-to-symbol', title: 'Go to Symbol…', hint: '⌘⇧O', run: () => runEditorAction('editor.action.quickOutline') },
    ];
    (['dark', 'grey', 'light'] as Skin[]).forEach((s) =>
      list.push({ id: `theme-${s}`, title: `Theme: ${s[0].toUpperCase() + s.slice(1)}`, hint: 'Skin', run: () => setSetting('skin', s) }),
    );
    ACCENTS.forEach((c) =>
      list.push({ id: `accent-${c}`, title: `Accent: ${c}`, hint: 'Color', run: () => setSetting('accent', c) }),
    );
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFolder, openScratch, saveActive, closeDoc, reopenClosed, activeId, runEditorAction]);

  // ── Small render helpers ───────────────────────────────────────────────
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

  const topBtn = (label: string, Icon: LucideIcon, on: boolean, onClick: () => void, primary = false) => (
    <button
      onClick={onClick}
      title={label}
      style={{
        display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '4px 9px', borderRadius: 6,
        border: `0.5px solid ${on || primary ? settings.accent : skin.brd}`,
        background: primary ? settings.accent : 'transparent',
        color: primary ? '#1c260a' : on ? skin.text : skin.muted, cursor: 'pointer',
      }}
    >
      <Icon size={12} /> {label}
    </button>
  );

  // Recursive file-tree node renderer.
  const renderNode = (node: FileNode, depth: number): React.ReactNode => {
    const pad = 8 + depth * 12;
    if (node.type === 'directory') {
      const isOpen = expanded.has(node.path);
      return (
        <div key={node.path}>
          <button
            onClick={() => toggleDir(node.path)}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, width: '100%', textAlign: 'left',
              padding: `3px 6px 3px ${pad}px`, background: 'transparent', border: 'none',
              color: skin.text, fontSize: 12, cursor: 'pointer',
            }}
          >
            {isOpen ? <ChevronDown size={13} style={{ color: skin.muted, flexShrink: 0 }} /> : <ChevronRight size={13} style={{ color: skin.muted, flexShrink: 0 }} />}
            {isOpen ? <FolderOpen size={13} style={{ color: '#7aa2d6', flexShrink: 0 }} /> : <Folder size={13} style={{ color: '#7aa2d6', flexShrink: 0 }} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
          </button>
          {isOpen && node.children?.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    const { Icon, color } = iconForFile(node.name);
    const on = activeId === node.path;
    return (
      <button
        key={node.path}
        onClick={() => openFile(node.path, node.name)}
        title={node.path}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
          padding: `3px 6px 3px ${pad + 17}px`, background: on ? skin.hover : 'transparent', border: 'none',
          color: on ? skin.text : skin.muted, fontSize: 12, cursor: 'pointer',
        }}
      >
        <Icon size={13} style={{ color, flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
      </button>
    );
  };

  // Recursive Outline-tree node renderer.
  const renderSymbol = (sym: DocSymbol, depth: number, key: string): React.ReactNode => {
    const { Icon, color } = symbolKindMeta(sym.kind);
    const active = crumbs.length > 0 && crumbs[crumbs.length - 1] === sym;
    return (
      <div key={key}>
        <button
          onClick={() => revealSymbol(sym)}
          title={sym.name}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
            padding: `3px 8px 3px ${8 + depth * 12}px`, border: 'none',
            background: active ? skin.hover : 'transparent',
            color: active ? skin.text : skin.muted, fontSize: 12, cursor: 'pointer',
          }}
        >
          <Icon size={13} style={{ color, flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: skin.text }}>{sym.name}</span>
          {sym.detail && <span style={{ fontSize: 10, color: skin.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sym.detail}</span>}
        </button>
        {sym.children?.map((c, i) => renderSymbol(c, depth + 1, `${key}/${i}`))}
      </div>
    );
  };

  // Breadcrumb segments for the active file: folder-relative path + symbol chain.
  const crumbPathParts: string[] = (() => {
    if (activeDoc?.kind !== 'file') return [];
    const base = folderPath ? folderPath.replace(/\/+$/, '') : '';
    const rel = base && activeDoc.path.startsWith(base) ? activeDoc.path.slice(base.length + 1) : activeDoc.path;
    return rel.split('/').filter(Boolean);
  })();

  // Scratch playground keeps the compact, minimal option set.
  const monacoOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
    fontFamily: settings.font,
    fontSize: settings.size,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    lineNumbers: 'on',
    automaticLayout: true,
    tabSize: 2,
    padding: { top: 10 },
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9, useShadows: false },
  };

  // The REAL file editor: all Tier-1 Monaco features on; minimap + word-wrap
  // are driven by the persisted Settings toggles.
  const fileEditorOptions: monaco.editor.IStandaloneEditorConstructionOptions = useMemo(() => ({
    fontFamily: settings.font,
    fontSize: settings.size,
    minimap: { enabled: settings.minimap },
    wordWrap: settings.wordWrap ? 'on' : 'off',
    folding: true,
    foldingHighlight: true,
    stickyScroll: { enabled: true },
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    renderWhitespace: 'selection',
    cursorBlinking: 'smooth',
    smoothScrolling: true,
    multiCursorModifier: 'ctrlCmd',
    linkedEditing: true,
    renderLineHighlight: 'all',
    scrollBeyondLastLine: false,
    lineNumbers: 'on',
    automaticLayout: true,
    tabSize: 2,
    padding: { top: 10 },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
  }), [settings.font, settings.size, settings.minimap, settings.wordWrap]);

  const statusPath = activeDoc
    ? (activeDoc.kind === 'scratch' ? 'Scratch playground' : activeDoc.path)
    : 'No file open';

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', background: skin.bg, color: skin.text, fontFamily: 'var(--font-sans, system-ui)' }}>
      {/* Top bar: brand + explorer toggle + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: skin.tab, borderBottom: `0.5px solid ${skin.brd}`, flexShrink: 0, padding: '0 10px', height: 36 }}>
        <span title="e-Editor" style={{ display: 'flex', alignItems: 'center' }}>
          <EEditorIcon size={18} />
        </span>
        <button
          onClick={() => setShowExplorer((v) => !v)}
          title={showExplorer ? 'Hide Explorer' : 'Show Explorer'}
          style={{ display: 'flex', alignItems: 'center', padding: 4, borderRadius: 6, border: `0.5px solid ${showExplorer ? settings.accent : skin.brd}`, background: 'transparent', color: showExplorer ? skin.text : skin.muted, cursor: 'pointer' }}
        >
          <PanelLeft size={14} />
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {topBtn('⌘P', Search, quickOpenOpen, () => { setPaletteOpen(false); setQuickOpenOpen((v) => !v); })}
          {topBtn('⌘⇧P', CommandIcon, paletteOpen, () => { setQuickOpenOpen(false); setPaletteOpen((v) => !v); })}
          {activeDoc?.kind === 'scratch' && topBtn('Run', Play, false, rebuildScratch, true)}
          {topBtn('Preview', Eye, showPreview, () => setShowPreview((v) => !v))}
          {topBtn('Outline', ListTree, showOutline, () => setShowOutline((v) => !v))}
          {topBtn('AI', Sparkles, aiOpen, () => setAiOpen((v) => !v))}
          {topBtn('Settings', Settings2, showSettings, () => setShowSettings((v) => !v))}
        </div>
      </div>

      {/* Main: explorer | (tabbar + editor) | AI */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* LEFT — Explorer */}
        {showExplorer && (
          <aside style={{ width: 230, flexShrink: 0, display: 'flex', flexDirection: 'column', background: skin.panel, borderRight: `0.5px solid ${skin.brd}`, minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: `0.5px solid ${skin.brd}` }}>
              <span style={{ fontSize: 11, letterSpacing: '.08em', color: skin.muted, fontWeight: 600 }}>EXPLORER</span>
              <button
                onClick={openFolder}
                title="Open Folder"
                style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, padding: '3px 7px', borderRadius: 5, border: `0.5px solid ${skin.brd}`, background: 'transparent', color: skin.text, cursor: 'pointer' }}
              >
                <FolderInput size={12} /> Open
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', paddingTop: 4 }}>
              {folderPath && tree.length > 0 ? (
                <>
                  <div style={{ fontSize: 10, color: skin.muted, padding: '2px 10px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={folderPath}>
                    {folderPath.split('/').pop() || folderPath}
                  </div>
                  {tree.map((n) => renderNode(n, 0))}
                </>
              ) : (
                <div style={{ padding: '16px 12px', textAlign: 'center' }}>
                  <p style={{ fontSize: 12, color: skin.muted, marginBottom: 12, lineHeight: 1.5 }}>
                    No folder open. Open one to browse and edit its files.
                  </p>
                  <button
                    onClick={openFolder}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, padding: '7px', borderRadius: 6, border: 'none', background: settings.accent, color: '#1c260a', cursor: 'pointer', marginBottom: 8 }}
                  >
                    <FolderInput size={13} /> Open Folder
                  </button>
                  <button
                    onClick={openScratch}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, padding: '7px', borderRadius: 6, border: `0.5px solid ${skin.brd}`, background: 'transparent', color: skin.text, cursor: 'pointer' }}
                  >
                    <FilePlus2 size={13} /> New Scratch
                  </button>
                </div>
              )}
            </div>
            {folderPath && (
              <div style={{ borderTop: `0.5px solid ${skin.brd}`, padding: 8 }}>
                <button
                  onClick={openScratch}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 11, padding: '6px', borderRadius: 6, border: `0.5px solid ${skin.brd}`, background: 'transparent', color: skin.muted, cursor: 'pointer' }}
                >
                  <FilePlus2 size={12} /> New Scratch
                </button>
              </div>
            )}
          </aside>
        )}

        {/* CENTER — tab bar + editor */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', alignItems: 'stretch', background: skin.tab, borderBottom: `0.5px solid ${skin.brd}`, flexShrink: 0, overflowX: 'auto', minHeight: 34 }}>
            {openDocs.length === 0 && (
              <span style={{ display: 'flex', alignItems: 'center', padding: '0 12px', fontSize: 12, color: skin.muted }}>No open files</span>
            )}
            {openDocs.map((d) => {
              const on = activeId === d.id;
              const dirty = isDirty(d);
              const { Icon, color } = d.kind === 'scratch'
                ? { Icon: Code2 as LucideIcon, color: settings.accent }
                : iconForFile(d.name);
              return (
                <div
                  key={d.id}
                  onClick={() => setActiveId(d.id)}
                  onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeDoc(d.id); } }}
                  title={d.kind === 'file' ? d.path : 'Scratch playground'}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 0 12px', cursor: 'pointer',
                    background: on ? skin.bg : 'transparent', borderRight: `0.5px solid ${skin.brd}`,
                    color: on ? skin.text : skin.muted, fontSize: 12, whiteSpace: 'nowrap',
                    boxShadow: on ? `inset 0 -2px 0 ${settings.accent}` : 'none',
                  }}
                >
                  <Icon size={13} style={{ color, flexShrink: 0 }} />
                  <span>{d.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); closeDoc(d.id); }}
                    title="Close"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: 4, border: 'none', background: 'transparent', color: skin.muted, cursor: 'pointer' }}
                  >
                    {dirty ? <span style={{ width: 7, height: 7, borderRadius: '50%', background: settings.accent }} /> : <X size={12} />}
                  </button>
                </div>
              );
            })}
          </div>

          {/* Breadcrumbs: file path + symbol path at the cursor (subtle) */}
          {activeDoc?.kind === 'file' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: skin.tab, borderBottom: `0.5px solid ${skin.brd}`, flexShrink: 0, height: 24, padding: '0 12px', fontSize: 11, color: skin.muted, overflowX: 'auto', whiteSpace: 'nowrap' }}>
              {crumbPathParts.map((part, i) => (
                <span key={`p${i}`} style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  {i > 0 && <ChevronRight size={11} style={{ color: skin.brd }} />}
                  <span style={{ color: i === crumbPathParts.length - 1 && crumbs.length === 0 ? skin.text : skin.muted }}>{part}</span>
                </span>
              ))}
              {crumbs.map((sym, i) => {
                const { Icon, color } = symbolKindMeta(sym.kind);
                const last = i === crumbs.length - 1;
                return (
                  <button
                    key={`s${i}`}
                    onClick={() => revealSymbol(sym)}
                    title={`Reveal ${sym.name}`}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, color: last ? skin.text : skin.muted, fontSize: 11 }}
                  >
                    <ChevronRight size={11} style={{ color: skin.brd }} />
                    <Icon size={11} style={{ color, flexShrink: 0 }} />
                    <span>{sym.name}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Editor area */}
          <div ref={bodyRef} style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>
            {!activeDoc ? (
              /* Empty state */
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: skin.muted }}>
                <EEditorIcon size={44} />
                <p style={{ fontSize: 13 }}>Open a file from the Explorer, or start a Scratch playground.</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={openFolder} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '7px 12px', borderRadius: 6, border: 'none', background: settings.accent, color: '#1c260a', cursor: 'pointer' }}>
                    <FolderInput size={13} /> Open Folder
                  </button>
                  <button onClick={openScratch} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '7px 12px', borderRadius: 6, border: `0.5px solid ${skin.brd}`, background: 'transparent', color: skin.text, cursor: 'pointer' }}>
                    <FilePlus2 size={13} /> New Scratch
                  </button>
                </div>
              </div>
            ) : activeDoc.kind === 'scratch' ? (
              /* SCRATCH — sub-tabs + Monaco + always-on live preview split */
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', background: skin.panel, borderBottom: `0.5px solid ${skin.brd}`, flexShrink: 0 }}>
                  {(Object.keys(SCRATCH_META) as FileKey[]).map((k) => {
                    const m = SCRATCH_META[k];
                    const SIcon = m.icon;
                    const on = scratchActive === k;
                    return (
                      <button
                        key={k}
                        onClick={() => setScratchActive(k)}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', cursor: 'pointer', background: on ? skin.bg : 'transparent', border: 'none', borderRight: `0.5px solid ${skin.brd}`, color: on ? skin.text : skin.muted, fontSize: 12, boxShadow: on ? `inset 0 -2px 0 ${settings.accent}` : 'none' }}
                      >
                        <SIcon size={13} style={{ color: m.color }} /> {m.label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
                  <div style={{ width: `${splitPct}%`, minWidth: 0 }}>
                    <Editor
                      language={SCRATCH_META[scratchActive].lang}
                      path={`scratch/${SCRATCH_META[scratchActive].label}`}
                      theme={skin.monaco}
                      value={scratchFiles[scratchActive]}
                      onMount={handleEditorMount}
                      onChange={(v) => setScratchFiles((f) => ({ ...f, [scratchActive]: v ?? '' }))}
                      options={monacoOptions}
                    />
                  </div>
                  <div onMouseDown={startDrag} title="Drag to resize" style={{ width: 6, flexShrink: 0, cursor: 'col-resize', background: skin.brd }} />
                  <div style={{ flex: 1, minWidth: 0, background: '#fff' }}>
                    <iframe
                      title="scratch-preview"
                      src={scratchUrl}
                      sandbox="allow-scripts allow-modals allow-popups"
                      style={{ width: '100%', height: '100%', border: 'none', pointerEvents: dragging ? 'none' : 'auto' }}
                    />
                  </div>
                </div>
              </div>
            ) : (
              /* FILE — single-pane by default; opt-in preview split */
              <>
                <div style={{ width: showPreview ? `${splitPct}%` : '100%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  {activeDoc.saveError && (
                    <div style={{ fontSize: 11, color: '#ff8a80', background: 'rgba(255,80,80,0.08)', borderBottom: '0.5px solid rgba(255,80,80,0.3)', padding: '4px 10px' }}>
                      Save failed: {activeDoc.saveError}
                    </div>
                  )}
                  {activeDoc.error ? (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center' }}>
                      <div>
                        <p style={{ fontSize: 13, color: '#ff8a80', marginBottom: 6 }}>Failed to load file</p>
                        <p style={{ fontSize: 11, color: skin.muted }}>{activeDoc.error}</p>
                      </div>
                    </div>
                  ) : activeDoc.loading ? (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Loader2 size={20} className="animate-spin" style={{ color: settings.accent }} />
                    </div>
                  ) : (
                    <div style={{ flex: 1, minHeight: 0 }}>
                      <Editor
                        language={activeDoc.language}
                        path={activeDoc.path}
                        theme={skin.monaco}
                        value={activeDoc.content}
                        onMount={handleEditorMount}
                        onChange={(v) => {
                          const id = activeDoc.id;
                          setOpenDocs((docs) => docs.map((x) => (x.id === id && x.kind === 'file' ? { ...x, content: v ?? '' } : x)));
                        }}
                        options={fileEditorOptions}
                      />
                    </div>
                  )}
                </div>
                {showPreview && (
                  <>
                    <div onMouseDown={startDrag} title="Drag to resize" style={{ width: 6, flexShrink: 0, cursor: 'col-resize', background: skin.brd }} />
                    <div style={{ flex: 1, minWidth: 0, background: activeFileIsHtml ? '#fff' : skin.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {activeFileIsHtml ? (
                        <iframe
                          title="file-preview"
                          src={fileUrl}
                          sandbox="allow-scripts allow-modals allow-popups"
                          style={{ width: '100%', height: '100%', border: 'none', pointerEvents: dragging ? 'none' : 'auto' }}
                        />
                      ) : (
                        <p style={{ fontSize: 12, color: skin.muted, padding: 16, textAlign: 'center' }}>
                          Open an .html file (or a Scratch) to preview.
                        </p>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {/* RIGHT — Outline (document symbols for the active file) */}
        {showOutline && (
          <aside style={{ width: 240, flexShrink: 0, background: skin.panel, borderLeft: `0.5px solid ${skin.brd}`, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: `0.5px solid ${skin.brd}` }}>
              <ListTree size={13} style={{ color: settings.accent }} />
              <span style={{ fontSize: 11, letterSpacing: '.08em', color: skin.muted, fontWeight: 600 }}>OUTLINE</span>
              <button onClick={() => setShowOutline(false)} title="Close" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: skin.muted, cursor: 'pointer', display: 'flex' }}>
                <X size={14} />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', paddingTop: 4 }}>
              {!activeDoc ? (
                <div style={{ padding: '14px 12px', fontSize: 11, color: skin.muted, lineHeight: 1.5 }}>Open a file to see its symbols.</div>
              ) : symbols.length === 0 ? (
                <div style={{ padding: '14px 12px', fontSize: 11, color: skin.muted, lineHeight: 1.5 }}>
                  No symbols for this file. Press <span style={{ color: skin.text }}>⌘⇧O</span> to jump to a symbol.
                </div>
              ) : (
                symbols.map((s, i) => renderSymbol(s, 0, `${i}`))
              )}
            </div>
          </aside>
        )}

        {/* RIGHT — AI review (analyzes the Scratch playground) */}
        {aiOpen && (
          <aside style={{ width: 280, flexShrink: 0, background: skin.panel, borderLeft: `0.5px solid ${skin.brd}`, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: `0.5px solid ${skin.brd}` }}>
              <Sparkles size={13} style={{ color: settings.accent }} />
              <span style={{ fontSize: 12, fontWeight: 500 }}>AI Review</span>
              <button onClick={() => setAiOpen(false)} title="Close" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: skin.muted, cursor: 'pointer', display: 'flex' }}>
                <X size={14} />
              </button>
            </div>
            <div style={{ padding: '8px 10px' }}>
              <div style={{ fontSize: 10, color: skin.muted, marginBottom: 6 }}>Reviews the Scratch playground (HTML/CSS/JS).</div>
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
                        {SCRATCH_META[issue.file].label}:{issue.line}
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
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%' }}>{statusPath}</span>
        {activeDoc && isDirty(activeDoc) && <span>● Unsaved</span>}
        <span style={{ marginLeft: 'auto' }}>{activeDoc?.kind === 'scratch' ? (settings.autoRun ? 'Auto-run' : 'Manual') : showPreview ? 'Preview on' : 'Editor'}</span>
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: skin.text, cursor: 'pointer', marginBottom: 8 }}>
            <input type="checkbox" checked={settings.minimap} onChange={(e) => setSetting('minimap', e.target.checked)} />
            Minimap
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: skin.text, cursor: 'pointer', marginBottom: 8 }}>
            <input type="checkbox" checked={settings.wordWrap} onChange={(e) => setSetting('wordWrap', e.target.checked)} />
            Word wrap
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: skin.text, cursor: 'pointer' }}>
            <input type="checkbox" checked={settings.autoRun} onChange={(e) => setSetting('autoRun', e.target.checked)} />
            Auto-run Scratch on edit
          </label>
        </div>
      )}

      {/* Command palette (⌘⇧P) */}
      {paletteOpen && (
        <CommandPalette skin={skin} accent={settings.accent} commands={commands} onClose={() => setPaletteOpen(false)} />
      )}

      {/* Fuzzy quick-open (⌘P) */}
      {quickOpenOpen && (
        <QuickOpen
          skin={skin}
          accent={settings.accent}
          files={flatFiles}
          hasFolder={!!folderPath}
          onPick={openFile}
          onClose={() => setQuickOpenOpen(false)}
        />
      )}
    </div>
  );
}

export default EEditor;
