export const PLUGIN_ID = 'engram';
export const CHAT_VIEW_TYPE = 'engram-chat-view';
export const MEMORY_VIEW_TYPE = 'engram-memory-view';

export const DEFAULT_PREAMBLE =
  'You are a helpful AI assistant. You have access to the user\'s knowledge vault and can recall relevant memories from past conversations.';

// ─── Built-in provider IDs (cannot be removed by the user) ───────────────────

export const BUILTIN_PROVIDER_IDS = ['openrouter', 'openai', 'anthropic', 'mistral', 'local'] as const;

// ─── Known model catalog (bundled, not persisted) ─────────────────────────────

export interface KnownModel {
  id: string;
  name: string;
  contextWindow?: number;
}

export const KNOWN_MODELS: Record<string, KnownModel[]> = {
  openrouter: [
    { id: 'openrouter/auto', name: 'Auto (best available)' },
    { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 200000 },
    { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000 },
    { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000 },
    { id: 'openai/gpt-5', name: 'GPT-5', contextWindow: 128000 },
    { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini', contextWindow: 128000 },
    { id: 'openai/gpt-4.1', name: 'GPT-4.1', contextWindow: 1047576 },
    { id: 'openai/gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000 },
    { id: 'openai/o4-mini', name: 'o4 Mini', contextWindow: 200000 },
    { id: 'openai/o3', name: 'o3', contextWindow: 200000 },
    { id: 'mistralai/mistral-large-2411', name: 'Mistral Large', contextWindow: 128000 },
    { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash', contextWindow: 1048576 },
  ],
  openai: [
    // GPT-5 line
    { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 128000 },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 128000 },
    { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', contextWindow: 128000 },
    { id: 'gpt-5', name: 'GPT-5', contextWindow: 128000 },
    { id: 'gpt-5-mini', name: 'GPT-5 Mini', contextWindow: 128000 },
    { id: 'gpt-5-nano', name: 'GPT-5 Nano', contextWindow: 128000 },
    // GPT-4.1 line
    { id: 'gpt-4.1', name: 'GPT-4.1', contextWindow: 1047576 },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', contextWindow: 1047576 },
    { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', contextWindow: 1047576 },
    // GPT-4o line (proven, widely supported)
    { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000 },
    // Reasoning models
    { id: 'o4-mini', name: 'o4 Mini', contextWindow: 200000 },
    { id: 'o3', name: 'o3', contextWindow: 200000 },
  ],
  anthropic: [
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 200000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000 },
  ],
  mistral: [
    { id: 'mistral-large-latest', name: 'Mistral Large', contextWindow: 131072 },
    { id: 'mistral-medium-latest', name: 'Mistral Medium', contextWindow: 131072 },
    { id: 'mistral-small-latest', name: 'Mistral Small', contextWindow: 131072 },
    { id: 'codestral-latest', name: 'Codestral', contextWindow: 256000 },
    { id: 'open-mistral-nemo', name: 'Mistral Nemo', contextWindow: 131072 },
  ],
  local: [],
};

// ─── Provider settings shape ───────────────────────────────────────────────────

export interface ProviderSettings {
  id: string;
  name: string;
  baseUrl?: string;
  defaultModel: string;
  /** Model IDs currently shown in the model picker (subset of known + custom). */
  enabledModels: string[];
  /** User-added model IDs beyond the bundled catalog. */
  customModels: string[];
}

// ─── Default settings ─────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS = {
  // Provider config
  activeProviderId: (process.env.NODE_ENV === 'production' ? 'openrouter' : 'local') as string,
  providers: {
    openrouter: {
      id: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'openrouter/auto',
      enabledModels: KNOWN_MODELS.openrouter.map((m) => m.id),
      customModels: [] as string[],
    },
    openai: {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com',
      defaultModel: 'gpt-5',
      enabledModels: KNOWN_MODELS.openai.map((m) => m.id),
      customModels: [] as string[],
    },
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic',
      defaultModel: 'claude-sonnet-4-6',
      enabledModels: KNOWN_MODELS.anthropic.map((m) => m.id),
      customModels: [] as string[],
    },
    mistral: {
      id: 'mistral',
      name: 'Mistral',
      baseUrl: 'https://api.mistral.ai',
      defaultModel: 'mistral-large-latest',
      enabledModels: KNOWN_MODELS.mistral.map((m) => m.id),
      customModels: [] as string[],
    },
    local: {
      id: 'local',
      name: 'Local (LM Studio / Unsloth Studio / etc.)',
      baseUrl: 'http://localhost:1234',
      defaultModel: '',
      enabledModels: [] as string[],
      customModels: [] as string[],
    },
  } as Record<string, ProviderSettings>,

  // Memory
  maxMemoryCount: 10,
  defaultPreamble: DEFAULT_PREAMBLE,

  // Vault
  vaultMode: 'integrated' as 'integrated' | 'standalone',
  engramRoot: 'engram',
  readPaths: [] as string[],

  // Conversation
  autosaveEnabled: true,
  autosaveIntervalMs: 30_000,

  // Extraction
  memoryExtractionMode: 'manual' as 'auto' | 'manual' | 'disabled',

  // Completion defaults
  temperature: 0.7,
  maxTokens: 4096,
};

export type EngramSettings = typeof DEFAULT_SETTINGS;
