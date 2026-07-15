/**
 * @file Monaco setup — configures the editor to run fully offline (no CDN/AMD
 * loader) and to spawn its language workers as same-origin Vite worker bundles,
 * which keeps it within the app's `script-src 'self'` CSP.
 *
 * Import this module once (side-effecting) before any Monaco editor mounts.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import { initializeExternalLsp } from './lsp-external';

// Vite `?worker` imports: each becomes a bundled, same-origin worker file at
// build time — no blob: scripts, no remote loader, CSP-clean.
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(self as any).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Use the locally-bundled monaco instance instead of the default CDN loader.
loader.config({ monaco });

let languageDefaultsConfigured = false;

/**
 * Wire up Monaco's BUILT-IN language services so opening a .ts/.tsx/.js/.jsx/
 * .json/.css/.html file yields completion, hover, signature help, and live
 * diagnostic squiggles with no external server. All of this runs in-process via
 * the same-origin workers registered above. Idempotent.
 */
export function configureLanguageDefaults(): void {
  if (languageDefaultsConfigured) return;
  languageDefaultsConfigured = true;

  const ts = monaco.languages.typescript;

  // Sensible project-wide defaults matching a modern TS/React (Vite) codebase.
  // `allowNonTsExtensions` lets the service type files opened by absolute path
  // (as @monaco-editor/react keys models), and `esnext` libs enable DOM + modern
  // JS globals so browser code type-resolves out of the box.
  const compilerOptions: monaco.languages.typescript.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    // ReactJSX (the automatic runtime) matches the project's "jsx": "react-jsx"
    // so JSX type-checks without an explicit `import React`.
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    noEmit: true,
    lib: ['esnext', 'dom', 'dom.iterable'],
    typeRoots: ['node_modules/@types'],
  };
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.javascriptDefaults.setCompilerOptions({ ...compilerOptions, checkJs: false });

  // Sync every open model into the TS/JS language service so cross-file features
  // (go-to-definition, cross-file completion) resolve across the open project.
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.javascriptDefaults.setEagerModelSync(true);

  // Turn ON semantic + syntax + suggestion diagnostics (red/yellow squiggles).
  const diagnostics: monaco.languages.typescript.DiagnosticsOptions = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
  };
  ts.typescriptDefaults.setDiagnosticsOptions(diagnostics);
  ts.javascriptDefaults.setDiagnosticsOptions(diagnostics);

  // JSON: validation is on by default; assert it and allow JSONC comments so
  // config-style files don't drown in false errors.
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: true,
    schemaValidation: 'warning',
    enableSchemaRequest: false, // stay offline / CSP-clean — no remote schema fetches
  });

  // CSS/SCSS/LESS and HTML built-in services are enabled by default (their
  // workers are registered above); nothing to toggle — they provide completion,
  // hover, diagnostics and document symbols as soon as a model of that language
  // exists.

  // External-LSP seam (python/rust/go). Inert unless explicitly gated on; see
  // src/lib/lsp-external.ts. Called here so the seam is wired but does nothing.
  initializeExternalLsp();
}

let themesRegistered = false;

/**
 * Register the e-Editor's custom Monaco themes (grey + dark), matching the
 * app's editor skins. Idempotent.
 */
export function registerEEditorThemes(): void {
  if (themesRegistered) return;
  themesRegistered = true;

  monaco.editor.defineTheme('eeditor-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c678dd' },
      { token: 'string', foreground: '98c379' },
      { token: 'number', foreground: 'd19a66' },
      { token: 'tag', foreground: 'e06c75' },
      { token: 'attribute.name', foreground: 'd19a66' },
      { token: 'delimiter', foreground: 'abb2bf' },
    ],
    colors: {
      'editor.background': '#0d0f16',
      'editor.foreground': '#e7e9ee',
      'editorLineNumber.foreground': '#454b59',
      'editorLineNumber.activeForeground': '#9aa0ac',
      'editor.selectionBackground': '#2a3040',
      'editor.lineHighlightBackground': '#141824',
      'editorCursor.foreground': '#b5d94a',
      'editorGutter.background': '#0d0f16',
    },
  });

  monaco.editor.defineTheme('eeditor-grey', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8a8f9a', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c678dd' },
      { token: 'string', foreground: '98c379' },
      { token: 'number', foreground: 'd19a66' },
      { token: 'tag', foreground: 'e06c75' },
      { token: 'attribute.name', foreground: 'd19a66' },
    ],
    colors: {
      'editor.background': '#26262c',
      'editor.foreground': '#d6d7dc',
      'editorLineNumber.foreground': '#54545e',
      'editorLineNumber.activeForeground': '#9a9ba4',
      'editor.lineHighlightBackground': '#2e2e35',
      'editorCursor.foreground': '#b5d94a',
      'editorGutter.background': '#26262c',
    },
  });

  monaco.editor.defineTheme('eeditor-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#26262c',
      'editorLineNumber.foreground': '#b6b6bf',
    },
  });
}

export { monaco };
