import {
  getKnownModels,
  getProviderDefaults,
} from './services/modelRegistry';
import type { KnownModel } from './services/modelRegistry';

export type { KnownModel } from './services/modelRegistry';

export const PLUGIN_ID = 'engram';
export const ENGRAM_VIEW_TYPE = 'engram-view';

export const ENGRAM_TAB_IDS = ['chat', 'dreams', 'memories', 'snapshots'] as const;
export type EngramTabId = typeof ENGRAM_TAB_IDS[number];

export const DEFAULT_ENGRAM_TAB: EngramTabId = 'chat';

export const DEFAULT_PREAMBLE =
  'You are a helpful AI assistant. You have access to the user\'s knowledge vault and can recall relevant memories from past conversations.';

// ─── Built-in provider IDs (cannot be removed by the user) ───────────────────

export const BUILTIN_PROVIDER_IDS = ['openrouter', 'openai', 'anthropic', 'minimax', 'mistral', 'local'] as const;

// ─── Known model catalog (bundled, not persisted) ─────────────────────────────

function buildKnownModels(): Record<string, KnownModel[]> {
  const result: Record<string, KnownModel[]> = {};
  for (const id of BUILTIN_PROVIDER_IDS) {
    result[id] = getKnownModels(id);
  }
  return result;
}

export const KNOWN_MODELS: Record<string, KnownModel[]> = buildKnownModels();

// ─── Provider settings shape ───────────────────────────────────────────────────

export interface ProviderSettings {
  id: string;
  name: string;
  baseUrl?: string;
  defaultModel: string;
  /** Secret name in Obsidian SecretStorage that holds this provider's API key. */
  apiKeySecret?: string;
  /** Model IDs currently shown in the model picker (subset of known + custom). */
  enabledModels: string[];
  /** User-added model IDs beyond the bundled catalog. */
  customModels: string[];
}

export interface DreamsSettings {
  analysisProviderId: string;
  analysisModelId: string;
  narrativeProviderId: string;
  narrativeModelId: string;
}

// ─── Default settings ─────────────────────────────────────────────────────────

interface ProviderSeed {
  fallbackName: string;
  fallbackBaseUrl?: string;
  preferredDefault?: string;
}

const PROVIDER_SEEDS: Record<string, ProviderSeed> = {
  openrouter: { fallbackName: 'OpenRouter' },
  openai: { fallbackName: 'OpenAI', preferredDefault: 'gpt-5' },
  anthropic: { fallbackName: 'Anthropic', preferredDefault: 'claude-sonnet-4-6' },
  minimax: { fallbackName: 'MiniMax' },
  mistral: { fallbackName: 'Mistral', preferredDefault: 'mistral-large-latest' },
  local: {
    fallbackName: 'Local (LM Studio / Unsloth Studio / etc.)',
    fallbackBaseUrl: 'http://localhost:1234',
  },
};

const DEFAULT_ACTIVE_PROVIDER_ID = process.env.NODE_ENV === 'production'
  ? 'openrouter'
  : 'local';

function buildProviderSettings(
  id: string,
  seed: ProviderSeed,
  models: KnownModel[],
): ProviderSettings {
  const defaults = getProviderDefaults(id);
  const enabledModels = models.map((model) => model.id);
  const defaultModel =
    seed.preferredDefault !== undefined && enabledModels.includes(seed.preferredDefault)
      ? seed.preferredDefault
      : enabledModels[0] ?? '';

  return {
    id,
    name: defaults?.name ?? seed.fallbackName,
    baseUrl: defaults?.baseUrl ?? seed.fallbackBaseUrl,
    defaultModel,
    enabledModels,
    customModels: [],
  };
}

function buildDefaultProviders(): Record<string, ProviderSettings> {
  const result: Record<string, ProviderSettings> = {};
  for (const id of BUILTIN_PROVIDER_IDS) {
    result[id] = buildProviderSettings(
      id,
      PROVIDER_SEEDS[id],
      KNOWN_MODELS[id] ?? [],
    );
  }
  return result;
}

const DEFAULT_PROVIDERS: Record<string, ProviderSettings> = buildDefaultProviders();

export const DEFAULT_SETTINGS = {
  // Provider config
  activeProviderId: DEFAULT_ACTIVE_PROVIDER_ID,
  providers: DEFAULT_PROVIDERS,

  // Dreams
  dreams: {
    analysisProviderId: '',
    analysisModelId: '',
    narrativeProviderId: '',
    narrativeModelId: '',
  } satisfies DreamsSettings,

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

  // Tool calling (exposes Engram memory tools to the model during chat)
  toolCallingEnabled: true,
};

export type EngramSettings = typeof DEFAULT_SETTINGS;
