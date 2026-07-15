/**
 * @file Shared OAuth flow UI — progress spinner, paste-a-code prompt, and
 * device-code display (GitHub Copilot style). Used by onboarding AuthStep
 * and Settings → Auth so both surfaces render the same login experience.
 */
import { useState } from 'react';
import { useAuthStore, type OAuthDeviceCodeInfo } from '../../stores/auth-store';
import { Key, Loader2, Copy, Check, ExternalLink } from 'lucide-react';

// ─── OAuth Prompt Dialog (paste a code) ──────────────────────────────────

export function OAuthPromptDialog({
  message,
  onSubmit,
  onCancel,
}: {
  message: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!value.trim()) return;
    setSubmitting(true);
    onSubmit(value.trim());
  };

  return (
    <div className="p-3 bg-accent/10 border border-accent/20 rounded-lg space-y-2.5">
      <div className="flex items-start gap-2">
        <Key className="w-4 h-4 text-accent mt-0.5 flex-shrink-0" />
        <p className="text-sm text-text-primary">{message}</p>
      </div>
      <div className="flex gap-1.5">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
          placeholder="Paste code here…"
          autoFocus
          className="flex-1 text-xs bg-bg-base border border-border rounded px-2.5 py-1.5 text-text-primary placeholder:text-text-secondary/40 focus:outline-none focus:border-accent"
        />
        <button
          onClick={handleSubmit}
          disabled={!value.trim() || submitting}
          className="px-2.5 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent/90 rounded transition-colors disabled:opacity-50"
        >
          {submitting ? '…' : 'Submit'}
        </button>
        <button
          onClick={onCancel}
          className="px-1.5 py-1.5 text-xs text-text-secondary hover:text-text-primary"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

// ─── Device Code Dialog (GitHub Copilot device flow) ─────────────────────

export function DeviceCodeDialog({ info }: { info: OAuthDeviceCodeInfo }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(info.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — user can still read the code on screen
    }
  };

  return (
    <div className="p-3 bg-accent/10 border border-accent/20 rounded-lg space-y-2.5">
      <p className="text-sm text-text-primary font-medium">Enter this code to finish signing in</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-center text-xl font-mono font-semibold tracking-[0.3em] text-text-primary bg-bg-base border border-border rounded px-3 py-2 select-all">
          {info.userCode}
        </code>
        <button
          onClick={handleCopy}
          className={`flex items-center gap-1 px-2.5 py-2 text-xs font-medium rounded border transition-colors ${
            copied
              ? 'text-success bg-success/10 border-success/30'
              : 'text-text-primary bg-bg-elevated border-border hover:border-accent/50'
          }`}
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="text-xs text-text-secondary">
        A browser window should have opened at{' '}
        <a
          href={info.verificationUri}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline inline-flex items-center gap-0.5"
        >
          {info.verificationUri}
          <ExternalLink className="w-3 h-3" />
        </a>
        . Paste the code there — this dialog closes automatically once you approve.
      </p>
      <div className="flex items-center gap-1.5 text-xs text-text-secondary">
        <Loader2 className="w-3 h-3 animate-spin" />
        Waiting for approval…
      </div>
    </div>
  );
}

// ─── Combined flow panels (reads the auth store) ─────────────────────────

/**
 * Renders whichever OAuth flow panel is active: progress spinner,
 * paste-a-code prompt, or device-code display. Renders nothing when no
 * OAuth flow is in progress.
 */
export function OAuthFlowPanels() {
  const { oauthInProgress, oauthMessage, oauthPrompt, oauthDeviceCode, submitOAuthPrompt, cancelOAuthPrompt } = useAuthStore();

  if (oauthPrompt) {
    return (
      <OAuthPromptDialog
        message={oauthPrompt}
        onSubmit={submitOAuthPrompt}
        onCancel={cancelOAuthPrompt}
      />
    );
  }

  if (oauthDeviceCode) {
    return <DeviceCodeDialog info={oauthDeviceCode} />;
  }

  if (oauthInProgress) {
    return (
      <div className="flex items-center gap-3 p-3 bg-accent/10 border border-accent/20 rounded-lg">
        <Loader2 className="w-4 h-4 text-accent animate-spin flex-shrink-0" />
        <div>
          <p className="text-sm text-text-primary font-medium">Authenticating…</p>
          <p className="text-xs text-text-secondary">{oauthMessage || 'Complete login in your browser'}</p>
        </div>
      </div>
    );
  }

  return null;
}
