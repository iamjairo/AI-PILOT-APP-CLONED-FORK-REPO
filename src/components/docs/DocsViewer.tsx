import { useEffect, useState, useCallback } from 'react';
import { ArrowLeft, BookOpen, Globe, Printer, X, Loader2 } from 'lucide-react';
import { useTabStore } from '../../stores/tab-store';
import { IPC } from '../../../shared/ipc';
import { MarkdownContent } from './docs-markdown';
import { invoke } from '../../lib/ipc-client';
import type { DocsFetchResult } from '../../../shared/types';

// Page title map for breadcrumbs
const PAGE_TITLES: Record<string, string> = {
  index: 'Documentation',
  'getting-started': 'Getting Started',
  sessions: 'Sessions',
  memory: 'Memory',
  tasks: 'Tasks',
  agent: 'Agent',
  steering: 'Steering & Follow-up',
  'keyboard-shortcuts': 'Keyboard Shortcuts',
  settings: 'Settings',
  sidebar: 'Sidebar',
  'context-panel': 'Context Panel',
};

// Injected once: print stylesheet that isolates the reader pane onto A4.
// When printing, everything is hidden except the `.ee-reader` container, which
// is pinned to the page so only the article content lands on the PDF.
const PRINT_STYLE_ID = 'ee-reader-print-style';
const PRINT_STYLE = `
@media print {
  @page { size: A4; margin: 18mm; }
  body * { visibility: hidden; }
  .ee-reader, .ee-reader * { visibility: visible; }
  .ee-reader { position: absolute; inset: 0; overflow: visible; }
}
`;

function ensurePrintStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(PRINT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PRINT_STYLE_ID;
  style.textContent = PRINT_STYLE;
  document.head.appendChild(style);
}

export function DocsViewer() {
  const activeTab = useTabStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const { addDocsTab } = useTabStore();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<string[]>([]);

  // ── URL reader mode ──────────────────────────────────────────────────
  const [urlInput, setUrlInput] = useState('');
  const [reader, setReader] = useState<DocsFetchResult | null>(null);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerError, setReaderError] = useState<string | null>(null);

  const currentPage = activeTab?.filePath || 'index';

  useEffect(() => {
    ensurePrintStyle();
  }, []);

  const loadUrl = useCallback(async () => {
    const url = urlInput.trim();
    if (!url || readerLoading) return;
    setReaderLoading(true);
    setReaderError(null);
    try {
      const result = (await invoke(IPC.DOCS_FETCH_URL, url)) as DocsFetchResult;
      if (result.ok) {
        setReader(result);
        setReaderError(null);
      } else {
        setReader(null);
        setReaderError(result.error || 'Failed to load page');
      }
    } catch (err) {
      setReader(null);
      setReaderError(err instanceof Error ? err.message : 'Failed to load page');
    } finally {
      setReaderLoading(false);
    }
  }, [urlInput, readerLoading]);

  const closeReader = useCallback(() => {
    setReader(null);
    setReaderError(null);
  }, []);

  const printReader = useCallback(() => {
    ensurePrintStyle();
    window.print();
  }, []);

  // Load page content
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    invoke(IPC.DOCS_READ, currentPage)
      .then((result) => {
        if (!cancelled) {
          setContent(result as string | null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setContent(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentPage]);

  const navigateTo = useCallback(
    (page: string) => {
      setHistory((prev) => [...prev, currentPage]);
      addDocsTab(page);
    },
    [currentPage, addDocsTab]
  );

  const goBack = useCallback(() => {
    const prev = history[history.length - 1];
    if (prev) {
      setHistory((h) => h.slice(0, -1));
      addDocsTab(prev);
    }
  }, [history, addDocsTab]);

  // Handle clicks on internal links
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest('a');
      if (!anchor) return;

      const href = anchor.getAttribute('data-doc-link');
      if (href) {
        e.preventDefault();
        navigateTo(href);
        return;
      }

      // External links
      const externalHref = anchor.getAttribute('href');
      if (externalHref && (externalHref.startsWith('http') || externalHref.startsWith('mailto:'))) {
        e.preventDefault();
        window.api.openExternal(externalHref);
      }
    },
    [navigateTo]
  );

  // ── URL bar (always visible, above every mode) ────────────────────────
  const urlBar = (
    <div className="flex items-center gap-2 px-6 py-2.5 border-b border-border bg-bg-surface print:hidden">
      <Globe className="w-4 h-4 text-text-secondary shrink-0" />
      <input
        type="text"
        value={urlInput}
        onChange={(e) => setUrlInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void loadUrl();
          }
        }}
        placeholder="Load any docs URL (https://…)"
        className="flex-1 min-w-0 px-3 py-1.5 text-sm bg-bg-base border border-border rounded text-text-primary placeholder:text-text-secondary/60 focus:outline-none focus:border-accent"
      />
      <button
        onClick={() => void loadUrl()}
        disabled={readerLoading || !urlInput.trim()}
        className="px-3 py-1.5 text-sm bg-accent text-bg-base rounded hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {readerLoading ? 'Loading…' : 'Load'}
      </button>
      {reader && (
        <>
          <button
            onClick={printReader}
            title="Print / Save as PDF (A4)"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded text-text-primary hover:bg-bg-base transition-colors"
          >
            <Printer className="w-4 h-4" />
            Print / Save as PDF (A4)
          </button>
          <button
            onClick={closeReader}
            title="Close reader"
            className="p-1.5 hover:bg-bg-elevated rounded transition-colors"
          >
            <X className="w-4 h-4 text-text-secondary" />
          </button>
        </>
      )}
    </div>
  );

  // ── Reader mode: render sanitized article HTML ────────────────────────
  if (reader && reader.ok) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-bg-base">
        {urlBar}
        <div className="flex-1 overflow-y-auto">
          {/*
            SAFETY BOUNDARY: `reader.html` was sanitized server-side in the
            Electron main process (electron/ipc/docs.ts) with DOMPurify —
            scripts/styles/iframes/forms and inline event handlers are stripped.
            This is the ONLY reason dangerouslySetInnerHTML is acceptable here.
          */}
          <article className="ee-reader ee-reader-prose mx-auto px-8 py-10">
            <header className="mb-6 pb-4 border-b border-border">
              {reader.title && (
                <h1 className="text-2xl font-bold text-text-primary leading-tight">
                  {reader.title}
                </h1>
              )}
              {reader.byline && (
                <p className="mt-2 text-sm text-text-secondary">{reader.byline}</p>
              )}
              {reader.finalUrl && (
                <p className="mt-1 text-xs text-text-secondary/70 break-all">
                  {reader.finalUrl}
                </p>
              )}
            </header>
            <div dangerouslySetInnerHTML={{ __html: reader.html ?? '' }} />
          </article>
        </div>
      </div>
    );
  }

  // ── Reader loading / error states ─────────────────────────────────────
  if (readerLoading || readerError) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-bg-base">
        {urlBar}
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          {readerLoading ? (
            <>
              <Loader2 className="w-6 h-6 text-accent animate-spin" />
              <p className="text-sm text-text-secondary">Fetching and cleaning page…</p>
            </>
          ) : (
            <>
              <Globe className="w-10 h-10 text-text-secondary opacity-40" />
              <p className="text-sm text-red-400 max-w-md text-center px-6">{readerError}</p>
              <button
                onClick={() => setReaderError(null)}
                className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded text-text-primary hover:bg-bg-base transition-colors"
              >
                Dismiss
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Default: existing bundled/mkdocs docs (unchanged behavior) ────────
  const docsBody = loading ? (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-sm text-text-secondary">Loading…</div>
    </div>
  ) : !content ? (
    <div className="flex-1 flex flex-col items-center justify-center gap-3">
      <BookOpen className="w-10 h-10 text-text-secondary opacity-40" />
      <p className="text-sm text-text-secondary">Page not found</p>
      <button
        onClick={() => navigateTo('index')}
        className="px-3 py-1.5 text-sm bg-accent text-bg-base rounded hover:bg-accent/90 transition-colors"
      >
        Go to Documentation Home
      </button>
    </div>
  ) : (
    <div className="flex-1 flex flex-col overflow-hidden" onClick={handleClick}>
      {/* Top bar */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border bg-bg-surface">
        {history.length > 0 && (
          <button
            onClick={goBack}
            className="p-1 hover:bg-bg-elevated rounded transition-colors"
            title="Go back"
          >
            <ArrowLeft className="w-4 h-4 text-text-secondary" />
          </button>
        )}
        <BookOpen className="w-4 h-4 text-accent" />
        <nav className="flex items-center gap-1 text-sm">
          {currentPage !== 'index' && (
            <>
              <button
                onClick={() => navigateTo('index')}
                className="text-accent hover:underline"
              >
                Docs
              </button>
              <span className="text-text-secondary">/</span>
            </>
          )}
          <span className="text-text-primary font-medium">
            {PAGE_TITLES[currentPage] || currentPage}
          </span>
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-8">
          <MarkdownContent content={content} currentPage={currentPage} />
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg-base">
      {urlBar}
      {docsBody}
    </div>
  );
}
