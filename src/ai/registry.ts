/**
 * What the app knows about each AI provider: where it lives, whether it needs
 * a key, which models to suggest, and how to build a client for it.
 */
import { AnthropicProvider } from './providers/anthropic';
import { OllamaProvider } from './providers/ollama';
import { OpenAiCompatibleProvider } from './providers/openaiCompatible';
import { AiError, type AiProvider, type ProviderConfig, type ProviderId } from './types';

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** Cloud services need a key; local servers run on the user's machine. */
  kind: 'cloud' | 'local' | 'demo';
  baseUrl: string;
  needsKey: boolean;
  /** Whether the user may change the endpoint address. */
  editableUrl: boolean;
  /** Where to create an API key. */
  keyUrl?: string;
  /** Curated models, best default first. Empty when the list is read from the server. */
  models: { id: string; hint: 'recommended' | 'mostCapable' | 'faster' | 'cheapest' }[];
  /** Assumed context window in tokens when the user has not set one. */
  contextTokens: number;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    kind: 'cloud',
    baseUrl: '',
    needsKey: true,
    editableUrl: false,
    keyUrl: 'https://platform.claude.com/settings/keys',
    models: [
      { id: 'claude-opus-5-5', hint: 'recommended' },
      { id: 'claude-fable-5-2', hint: 'mostCapable' },
      { id: 'claude-sonnet-5-5', hint: 'faster' },
      { id: 'claude-haiku-5-5', hint: 'cheapest' },
    ],
    contextTokens: 900_000,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'cloud',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    editableUrl: false,
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [],
    contextTokens: 120_000,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'cloud',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    editableUrl: false,
    keyUrl: 'https://aistudio.google.com/apikey',
    models: [],
    contextTokens: 400_000,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'cloud',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    editableUrl: false,
    keyUrl: 'https://openrouter.ai/keys',
    models: [],
    contextTokens: 120_000,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'local',
    baseUrl: 'http://localhost:11434',
    needsKey: false,
    editableUrl: true,
    models: [],
    contextTokens: 16_384,
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    kind: 'local',
    baseUrl: 'http://localhost:1234/v1',
    needsKey: false,
    editableUrl: true,
    models: [],
    contextTokens: 16_384,
  },
  {
    id: 'custom',
    name: 'OpenAI-compatible',
    kind: 'cloud',
    baseUrl: '',
    needsKey: false,
    editableUrl: true,
    models: [],
    contextTokens: 32_000,
  },
  {
    id: 'demo',
    name: 'Demo',
    kind: 'demo',
    baseUrl: '',
    needsKey: false,
    editableUrl: false,
    models: [],
    contextTokens: 0,
  },
];

export function providerInfo(id: ProviderId): ProviderInfo {
  return PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0];
}

export function defaultConfig(id: ProviderId): ProviderConfig {
  const info = providerInfo(id);
  return {
    provider: id,
    apiKey: '',
    baseUrl: info.baseUrl,
    model: info.models[0]?.id ?? '',
    effort: 'high',
    contextTokens: info.contextTokens,
  };
}

/** True when the configuration has everything needed to make a request. */
export function isConfigured(config: ProviderConfig): boolean {
  const info = providerInfo(config.provider);
  if (info.kind === 'demo') return false;
  if (info.needsKey && !config.apiKey.trim()) return false;
  if (info.id !== 'anthropic' && !config.baseUrl.trim()) return false;
  return config.model.trim() !== '';
}

export function createProvider(config: ProviderConfig): AiProvider {
  const info = providerInfo(config.provider);
  if (info.kind === 'demo') throw new AiError('notConfigured', 'No AI provider is configured.');
  if (info.needsKey && !config.apiKey.trim()) throw new AiError('notConfigured', 'The API key is missing.');
  if (config.provider === 'anthropic') return new AnthropicProvider(config);
  if (config.provider === 'ollama') return new OllamaProvider(config);
  return new OpenAiCompatibleProvider(config);
}

/**
 * Picks a sensible default from a provider's live model list: prefer general
 * chat models, newest generation first, and skip specialised variants.
 */
export function suggestModel(ids: string[]): string {
  const skip = /embed|whisper|tts|audio|realtime|image|dall|moderation|vision-preview|search|transcribe|rerank|guard|instruct|-nano|:free/i;
  const candidates = ids.filter((id) => !skip.test(id));
  const score = (id: string): number => {
    const version = id.match(/(\d+(?:\.\d+)?)/);
    let value = version ? Number(version[1]) : 0;
    if (value > 100) value = 0; // a date or build number, not a generation
    if (/pro|opus|large|sonnet/i.test(id)) value += 0.4;
    if (/mini|flash|lite|small|haiku/i.test(id)) value -= 0.3;
    if (/preview|exp|beta|latest/i.test(id)) value -= 0.1;
    return value;
  };
  return [...candidates].sort((a, b) => score(b) - score(a) || a.length - b.length)[0] ?? ids[0] ?? '';
}

export interface LocalModel {
  /** Ollama tag. */
  id: string;
  name: string;
  /** Approximate download size in GB. */
  sizeGb: number;
  /** Memory (RAM or VRAM) needed to run it comfortably, in GB. */
  memoryGb: number;
  tier: 'light' | 'balanced' | 'best';
}

/**
 * Open-weight models that handle long documents and structured output well,
 * by hardware tier. This is a starting point: any model installed in Ollama
 * can be used, and the list is easy to extend.
 */
export const LOCAL_MODELS: LocalModel[] = [
  { id: 'qwen3:4b', name: 'Qwen3 4B', sizeGb: 2.6, memoryGb: 8, tier: 'light' },
  { id: 'gemma3:4b', name: 'Gemma 3 4B', sizeGb: 3.3, memoryGb: 8, tier: 'light' },
  { id: 'qwen3:8b', name: 'Qwen3 8B', sizeGb: 5.2, memoryGb: 12, tier: 'balanced' },
  { id: 'gemma3:12b', name: 'Gemma 3 12B', sizeGb: 8.1, memoryGb: 16, tier: 'balanced' },
  { id: 'qwen3:14b', name: 'Qwen3 14B', sizeGb: 9.3, memoryGb: 16, tier: 'balanced' },
  { id: 'gpt-oss:20b', name: 'gpt-oss 20B', sizeGb: 14, memoryGb: 24, tier: 'best' },
  { id: 'gemma3:27b', name: 'Gemma 3 27B', sizeGb: 17, memoryGb: 32, tier: 'best' },
  { id: 'qwen3:32b', name: 'Qwen3 32B', sizeGb: 20, memoryGb: 32, tier: 'best' },
];
