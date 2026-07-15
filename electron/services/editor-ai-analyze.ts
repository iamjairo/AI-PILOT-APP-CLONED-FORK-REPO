/**
 * editor-ai-analyze.ts — one-shot AI review for the e-Editor playground.
 *
 * Mirrors pi-session-commit.ts: selects a cheap/fast model and uses the Pi
 * SDK's completeSimple() (handles all providers, API-key + OAuth, retries) to
 * return structured issues the AI panel renders and can auto-fix.
 */
import type { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { TextContent, Context } from '@earendil-works/pi-ai';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import type {
  EditorAiAnalyzeRequest,
  EditorAiAnalyzeResult,
  EditorAiIssue,
  EEditorFileKey,
} from '../../shared/types';

export async function runEditorAnalysis(
  req: EditorAiAnalyzeRequest,
  modelRegistry: ModelRegistry,
  authStorage: AuthStorage
): Promise<EditorAiAnalyzeResult> {
  const availableModels = modelRegistry.getAvailable();
  const model =
    availableModels.find(
      (m) => m.id.includes('claude-haiku-4') || m.id.includes('gpt-5.1-codex-mini') || m.id.includes('flash')
    ) ||
    availableModels.find((m) => m.id.includes('haiku') || m.id.includes('mini') || m.id.includes('flash')) ||
    availableModels[0];

  if (!model) return { ok: false, issues: [], error: 'No models available' };

  const apiKey = await authStorage.getApiKey(model.provider);
  if (!apiKey) {
    return { ok: false, issues: [], error: 'No API key configured — add one in Settings → Auth' };
  }

  const context: Context = {
    systemPrompt: `You review a tiny HTML/CSS/JS playground and report concrete issues (bugs, syntax errors, obvious mistakes, references to missing elements).
Respond with ONLY minified JSON, no markdown fences, no prose:
{"issues":[{"file":"html|css|js","line":<1-based line within that file>,"severity":"error|warning|info","message":"<short>","fix":"<optional full replacement for that single line>"}],"summary":"<one short line>"}
Only include "fix" when replacing that one line fully resolves the issue. Keep messages under ~100 chars. Report at most 12 issues.`,
    messages: [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: `Active file: ${req.activeFile}

=== index.html ===
${req.html.slice(0, 20000)}

=== styles.css ===
${req.css.slice(0, 20000)}

=== script.js ===
${req.js.slice(0, 20000)}`,
          },
        ],
        timestamp: Date.now(),
      },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await completeSimple(model, context, { apiKey, maxTokens: 2048, signal: controller.signal });
    if (response.errorMessage) return { ok: false, issues: [], error: response.errorMessage };

    const text = response.content
      .filter((c): c is TextContent => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .trim();

    const { issues, summary } = parseIssues(text);
    return { ok: true, issues, summary };
  } catch (e) {
    return { ok: false, issues: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeout);
  }
}

const FILE_KEYS: EEditorFileKey[] = ['html', 'css', 'js'];

function parseIssues(raw: string): { issues: EditorAiIssue[]; summary?: string } {
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);

  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    return { issues: [] };
  }
  if (typeof obj !== 'object' || obj === null) return { issues: [] };

  const rec = obj as Record<string, unknown>;
  const rawIssues = Array.isArray(rec.issues) ? rec.issues : [];
  const issues: EditorAiIssue[] = [];
  for (const item of rawIssues) {
    if (typeof item !== 'object' || item === null) continue;
    const i = item as Record<string, unknown>;
    if (!FILE_KEYS.includes(i.file as EEditorFileKey)) continue;
    if (typeof i.message !== 'string') continue;
    const severity =
      i.severity === 'error' || i.severity === 'warning' || i.severity === 'info' ? i.severity : 'info';
    issues.push({
      file: i.file as EEditorFileKey,
      line: Number(i.line) > 0 ? Math.floor(Number(i.line)) : 1,
      endLine: Number(i.endLine) > 0 ? Math.floor(Number(i.endLine)) : undefined,
      severity,
      message: i.message,
      fix: typeof i.fix === 'string' ? i.fix : undefined,
    });
  }
  return { issues, summary: typeof rec.summary === 'string' ? rec.summary : undefined };
}
