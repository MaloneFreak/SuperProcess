/** Shared contracts between the AI providers and the analysis pipeline. */

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'ollama' | 'lmstudio' | 'custom' | 'demo';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ProviderConfig {
  provider: ProviderId;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Claude only: how much reasoning to spend. */
  effort: Effort;
  /** Size of the model's context window in tokens (used to decide when to condense long inputs). */
  contextTokens: number;
}

export type JsonSchema = Record<string, unknown>;

export interface ChatRequest {
  system: string;
  /**
   * Material shared by several requests (the sources). Providers that support
   * prompt caching mark the end of this block as a cache point.
   */
  context: string;
  /** The request-specific instruction; comes after `context`. */
  prompt: string;
  /** When set, the answer must be a JSON object matching this schema. */
  schema?: JsonSchema;
  schemaName?: string;
  signal?: AbortSignal;
  /** Called with the full answer text generated so far. */
  onText?: (text: string) => void;
  /** Called once the model has started answering (the prompt cache is warm from here on). */
  onStart?: () => void;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface ChatResult {
  text: string;
  usage: Usage;
  /** The model that actually answered (may differ from the requested one after a fallback). */
  model: string;
}

export interface ModelInfo {
  id: string;
  label?: string;
  /** Size on disk in bytes, for local models. */
  size?: number;
}

export interface AiProvider {
  readonly config: ProviderConfig;
  chat(request: ChatRequest): Promise<ChatResult>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Cheap call that proves the endpoint, key and model work. */
  test(signal?: AbortSignal): Promise<void>;
}

export type AiErrorKind =
  | 'auth'
  | 'rateLimit'
  | 'network'
  | 'modelNotFound'
  | 'refusal'
  | 'truncated'
  | 'invalidOutput'
  | 'tooLong'
  | 'badRequest'
  | 'server'
  | 'aborted'
  | 'notConfigured';

/** An error with a category the UI can translate into a helpful message. */
export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export function isAbort(error: unknown): boolean {
  return (
    (error instanceof AiError && error.kind === 'aborted') ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

export const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
  };
}
