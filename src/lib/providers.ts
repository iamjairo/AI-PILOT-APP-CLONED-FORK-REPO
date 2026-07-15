/**
 * @file Shared AI-provider definitions used by onboarding (AuthStep) and
 * Settings → Auth. Single source of truth for which providers are featured,
 * which are available via the "add another provider" dropdown, and their
 * display metadata.
 *
 * Provider ids match the @earendil-works/pi-ai SDK provider ids exactly
 * (the id is passed straight through AUTH_SET_API_KEY / AUTH_LOGIN_OAUTH).
 * OAuth flows exist in the SDK for: `anthropic`, `openai-codex`,
 * `github-copilot` (device-code flow).
 */

export interface ProviderDef {
  /** pi-ai provider id (also the OAuth provider id where supportsOAuth) */
  id: string;
  /** Human-readable name */
  name: string;
  /** One-line description shown under the name */
  description: string;
  /** Env var used as the API-key input placeholder ('' = no API key entry) */
  envVar: string;
  /** True when the SDK ships a browser/device OAuth flow for this id */
  supportsOAuth: boolean;
  /** Ollama is enabled through its own settings flow, not auth.json */
  isOllama?: boolean;
}

/**
 * Featured providers, shown as cards in onboarding and settings (in order).
 */
export const FEATURED_PROVIDERS: ProviderDef[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Local models — no API key needed',
    envVar: '',
    supportsOAuth: false,
    isOllama: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude (Pro/Max subscription or API key)',
    envVar: 'ANTHROPIC_API_KEY',
    supportsOAuth: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'ChatGPT / GPT models (API key)',
    envVar: 'OPENAI_API_KEY',
    supportsOAuth: false,
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    description: 'Codex — sign in with your ChatGPT subscription',
    envVar: '',
    supportsOAuth: true,
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    description: 'GitHub Copilot subscription',
    envVar: 'COPILOT_GITHUB_TOKEN',
    supportsOAuth: true,
  },
];

/**
 * Remaining pi-ai providers, available via the "add another provider"
 * dropdown. All are API-key based. Alphabetical by display name.
 */
export const ADDITIONAL_PROVIDERS: ProviderDef[] = [
  { id: 'amazon-bedrock', name: 'Amazon Bedrock', description: 'AWS-hosted models (Claude, Llama, and more)', envVar: 'AWS_BEARER_TOKEN_BEDROCK', supportsOAuth: false },
  { id: 'azure-openai-responses', name: 'Azure OpenAI', description: 'OpenAI models hosted on Azure', envVar: 'AZURE_OPENAI_API_KEY', supportsOAuth: false },
  { id: 'cerebras', name: 'Cerebras', description: 'Fast inference on Cerebras hardware', envVar: 'CEREBRAS_API_KEY', supportsOAuth: false },
  { id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway', description: 'Route requests through Cloudflare AI Gateway', envVar: 'CLOUDFLARE_API_KEY', supportsOAuth: false },
  { id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', description: 'Models on Cloudflare’s edge network', envVar: 'CLOUDFLARE_API_KEY', supportsOAuth: false },
  { id: 'deepseek', name: 'DeepSeek', description: 'DeepSeek V3 / R1 models', envVar: 'DEEPSEEK_API_KEY', supportsOAuth: false },
  { id: 'fireworks', name: 'Fireworks AI', description: 'Open-weight models via Fireworks', envVar: 'FIREWORKS_API_KEY', supportsOAuth: false },
  { id: 'google', name: 'Google', description: 'Gemini models (API key)', envVar: 'GEMINI_API_KEY', supportsOAuth: false },
  { id: 'google-vertex', name: 'Google Vertex AI', description: 'Gemini via Google Cloud Vertex AI', envVar: 'GOOGLE_CLOUD_API_KEY', supportsOAuth: false },
  { id: 'groq', name: 'Groq', description: 'Ultra-fast inference on Groq LPUs', envVar: 'GROQ_API_KEY', supportsOAuth: false },
  { id: 'huggingface', name: 'Hugging Face', description: 'Inference providers on Hugging Face', envVar: 'HF_TOKEN', supportsOAuth: false },
  { id: 'kimi-coding', name: 'Kimi Coding', description: 'Moonshot Kimi coding plan', envVar: 'KIMI_API_KEY', supportsOAuth: false },
  { id: 'minimax', name: 'MiniMax', description: 'MiniMax models', envVar: 'MINIMAX_API_KEY', supportsOAuth: false },
  { id: 'mistral', name: 'Mistral', description: 'Mistral and Codestral models', envVar: 'MISTRAL_API_KEY', supportsOAuth: false },
  { id: 'moonshotai', name: 'Moonshot AI', description: 'Kimi models via Moonshot AI', envVar: 'MOONSHOT_API_KEY', supportsOAuth: false },
  { id: 'nvidia', name: 'NVIDIA', description: 'NVIDIA NIM hosted models', envVar: 'NVIDIA_API_KEY', supportsOAuth: false },
  { id: 'openrouter', name: 'OpenRouter', description: 'One API key for many models', envVar: 'OPENROUTER_API_KEY', supportsOAuth: false },
  { id: 'together', name: 'Together AI', description: 'Open-source models via Together', envVar: 'TOGETHER_API_KEY', supportsOAuth: false },
  { id: 'vercel-ai-gateway', name: 'Vercel AI Gateway', description: 'Route requests through Vercel AI Gateway', envVar: 'AI_GATEWAY_API_KEY', supportsOAuth: false },
  { id: 'xai', name: 'xAI', description: 'Grok models', envVar: 'XAI_API_KEY', supportsOAuth: false },
  { id: 'zai', name: 'Z.ai', description: 'GLM models', envVar: 'ZAI_API_KEY', supportsOAuth: false },
];

/** All known provider definitions (featured first). */
export const ALL_PROVIDERS: ProviderDef[] = [...FEATURED_PROVIDERS, ...ADDITIONAL_PROVIDERS];

/** Look up a provider definition by pi-ai id. */
export function getProviderDef(id: string): ProviderDef | undefined {
  return ALL_PROVIDERS.find(p => p.id === id);
}

/** Display label for a provider id (falls back to the raw id). */
export function getProviderLabel(id: string): string {
  return getProviderDef(id)?.name ?? id;
}

/**
 * Fallback definition for a provider that has stored auth but isn't in our
 * static lists (e.g. added by hand-editing auth.json or a newer SDK).
 */
export function fallbackProviderDef(id: string): ProviderDef {
  return { id, name: id, description: 'Custom provider', envVar: '', supportsOAuth: false };
}
