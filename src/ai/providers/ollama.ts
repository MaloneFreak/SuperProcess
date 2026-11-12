/**
 * Ollama, through its native API. The native API (rather than the OpenAI
 * shim) is used because it lets the app set the context window per request
 * (Ollama's default is small and silently truncates long transcripts) and
 * download models with progress.
 */
import { AiError, type AiProvider, type ChatRequest, type ChatResult, type ModelInfo, type ProviderConfig } from '../types';
import { joinUrl, lines, request } from './http';

interface ChatChunk {
  model?: string;
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export interface PullProgress {
  status: string;
  /** 0–1 for the layer being downloaded, when known. */
  fraction?: number;
  completed?: number;
  total?: number;
}

export class OllamaProvider implements AiProvider {
  constructor(readonly config: ProviderConfig) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const user = req.context ? `${req.context}\n\n${req.prompt}` : req.prompt;
    const response = await request(joinUrl(this.config.baseUrl, 'api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: req.signal,
      body: JSON.stringify({
        model: this.config.model,
        stream: true,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: user },
        ],
        ...(req.schema ? { format: req.schema } : {}),
        options: { num_ctx: this.config.contextTokens, temperature: 0.2 },
      }),
    });

    let text = '';
    let model = this.config.model;
    let reason: string | undefined;
    const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let started = false;
    for await (const line of lines(response, req.signal)) {
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(line) as ChatChunk;
      } catch {
        continue;
      }
      if (chunk.error) throw new AiError('server', chunk.error);
      if (!started) {
        started = true;
        req.onStart?.();
      }
      if (chunk.model) model = chunk.model;
      if (chunk.message?.content) {
        text += chunk.message.content;
        req.onText?.(text);
      }
      if (chunk.done) {
        reason = chunk.done_reason;
        usage.inputTokens = chunk.prompt_eval_count ?? 0;
        usage.outputTokens = chunk.eval_count ?? 0;
      }
    }
    if (reason === 'length') throw new AiError('truncated', 'The answer was cut off because it reached the output limit.');
    if (!text.trim()) throw new AiError('invalidOutput', 'The model returned an empty answer.');
    return { text, model, usage };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await request(joinUrl(this.config.baseUrl, 'api/tags'), { signal });
    const data = (await response.json()) as { models?: { name: string; size?: number; details?: { parameter_size?: string } }[] };
    return (data.models ?? [])
      .map((model) => ({ id: model.name, label: model.details?.parameter_size, size: model.size }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async test(signal?: AbortSignal): Promise<void> {
    const models = await this.listModels(signal);
    const wanted = this.config.model;
    const installed = models.some((model) => model.id === wanted || model.id === `${wanted}:latest`);
    if (!installed) throw new AiError('modelNotFound', `Model "${wanted}" is not installed in Ollama.`);
  }

  /** Downloads a model into the local Ollama library. */
  async pull(model: string, onProgress: (progress: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    const response = await request(joinUrl(this.config.baseUrl, 'api/pull'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal,
    });
    for await (const line of lines(response, signal)) {
      let event: { status?: string; total?: number; completed?: number; error?: string };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (event.error) throw new AiError('server', event.error);
      onProgress({
        status: event.status ?? '',
        completed: event.completed,
        total: event.total,
        fraction: event.total ? (event.completed ?? 0) / event.total : undefined,
      });
    }
  }
}

/** True when an Ollama server answers at `baseUrl`. */
export async function detectOllama(baseUrl: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await request(joinUrl(baseUrl, 'api/version'), { signal });
    const data = (await response.json()) as { version?: string };
    return data.version ?? 'unknown';
  } catch {
    return null;
  }
}
