import { useEffect } from 'react';
import { useAuthStore } from '../stores/auth-store';
import { on } from '../lib/ipc-client';
import { IPC } from '../../shared/ipc';
import type { OAuthEventPayload } from '../../shared/types';
import type { OllamaStatusInfo } from '../stores/auth-store';

/**
 * The main process emits more OAuth event types than the shared
 * OAuthEventPayload union covers (see electron/ipc/auth.ts sendEvent calls).
 * Widen it locally so the renderer can handle the device-code flow
 * (GitHub Copilot) without touching shared/types.ts.
 */
type ExtendedOAuthEventPayload =
  | OAuthEventPayload
  | { type: 'auth'; url: string; instructions?: string }
  | {
      type: 'device_code';
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
      instructions?: string;
    }
  | { type: 'select'; message: string }
  | { type: 'error'; message: string };

/**
 * Listens for OAuth authentication events and Ollama status pushes from the main process.
 *
 * Handles OAuth flow state changes (success, prompt, progress) and updates
 * the auth store accordingly. Automatically refreshes auth status when login
 * completes. Shows OAuth prompts when the user needs to paste a code or token.
 * Also tracks Ollama connection status pushed from OllamaService.
 *
 * Should be mounted once at the app root level.
 */
export function useAuthEvents() {
  const loadStatus = useAuthStore(s => s.loadStatus);

  useEffect(() => {
    const unsubs = [
      on(IPC.AUTH_LOGIN_OAUTH_EVENT, (payload: ExtendedOAuthEventPayload) => {
        if (payload.type === 'success') {
          // Refresh auth status when OAuth login completes
          useAuthStore.setState({ oauthDeviceCode: null });
          loadStatus();
        } else if (payload.type === 'prompt') {
          // OAuth flow is asking the user to paste a code/token
          useAuthStore.setState({
            oauthPrompt: payload.message || 'Paste the code from your browser:',
            oauthMessage: null,
          });
        } else if (payload.type === 'progress') {
          useAuthStore.setState({ oauthMessage: payload.message });
        } else if (payload.type === 'device_code') {
          // Device-code flow (e.g. GitHub Copilot): show the user code +
          // verification URL so the user can finish signing in out-of-band.
          useAuthStore.setState({
            oauthDeviceCode: {
              userCode: payload.userCode,
              verificationUri: payload.verificationUri,
              expiresInSeconds: payload.expiresInSeconds,
            },
            oauthMessage: null,
          });
        }
      }),

      // Ollama status push events
      on(IPC.OLLAMA_STATUS, (status: unknown) => {
        useAuthStore.getState().setOllamaStatus(status as OllamaStatusInfo);
      }),
    ];

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [loadStatus]);
}
