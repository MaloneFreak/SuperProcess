/**
 * Any server that speaks the OpenAI Chat Completions protocol: OpenAI itself,
 * Google Gemini (compatibility endpoint), OpenRouter, LM Studio, llama.cpp,
 * vLLM, Jan and others.
 */
import { AiError, type AiProvider, type ChatRequest, type ChatResult, type ModelInfo, type ProviderConfig } from '../types';
import { joinUrl, lines, request } from './http';

type FormatMode = 'schema' | 'object' | 'none';

interface Chunk {
  model?: string;
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  error?: { message?: string };
}

export class OpenAiCompatibleProvider implements AiProvider {
  /** Not every server supports schema-constrained output; remember what worked. */
  private format: FormatMode = 'schema';

  constructor(readonly config: ProviderConfig) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  private body(req: ChatRequest, mode: FormatMode): string {
    const user = req.context ? `${req.context}\n\n${req.prompt}` : req.prompt;
    const body: Record<string, unknown> = {
      model: this.config.model,
      stream: true,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: user },
      ],
    };
    if (req.schema && mode === 'schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: req.schemaName ?? 'answer', strict: true, schema: req.schema },
      };
    } else if (req.schema && mode === 'object') {
      body.response_format = { type: 'json_object' };
    }
    return JSON.stringify(body);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const url = joinUrl(this.config.baseUrl, 'chat/completions');
    const fallbacks: FormatMode[] = this.format === 'schema' ? ['schema', 'object', 'none'] : this.format === 'object' ? ['object', 'none'] : ['none'];

    let response: Response | undefined;
    let lastError: unknown;
    for (const mode of req.schema ? fallbacks : (['none'] as FormatMode[])) {
      try {
        response = await request(url, { method: 'POST', headers: this.headers(), body: this.body(req, mode), signal: req.signal });
        if (req.schema) this.format = mode;
        break;
      } catch (error) {
        lastError = error;
        // A 400 on the first tries usually means "response_format not supported".
        if (!(error instanceof AiError) || error.kind !== 'badRequest' || mode === 'none') throw error;
      }
    }
    if (!response) throw lastError;

    let text = '';
    let model = this.config.model;
    let finish: string | null | undefined;
    const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let started = false;
    for await (const line of lines(response, req.signal)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data) as Chunk;
      } catch {
        continue;
      }
      if (chunk.error?.message) throw new AiError('server', chunk.error.message);
      if (!started) {
        started = true;
        req.onStart?.();
      }
      if (chunk.model) model = chunk.model;
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        text += choice.delta.content;
        req.onText?.(text);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
        usage.outputTokens = chunk.usage.completion_tokens ?? 0;
        usage.cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      }
    }
    if (finish === 'length') throw new AiError('truncated', 'The answer was cut off because it reached the output limit.');
    if (finish === 'content_filter') throw new AiError('refusal', 'The provider filtered this request.');
    if (!text.trim()) throw new AiError('invalidOutput', 'The model returned an empty answer.');
    return { text, model, usage };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await request(joinUrl(this.config.baseUrl, 'models'), { headers: this.headers(), signal });
    type Entry = { id?: string; name?: string };
    const data = (await response.json()) as { data?: Entry[] } | Entry[];
    const items = Array.isArray(data) ? data : (data.data ?? []);
    return items
      .map((item) => ({ id: String(item.id ?? '').replace(/^models\//, ''), label: item.name }))
      .filter((item) => item.id)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async test(signal?: AbortSignal): Promise<void> {
    const models = await this.listModels(signal);
    if (models.length > 0 && !models.some((model) => model.id === this.config.model)) {
      throw new AiError('modelNotFound', `Model "${this.config.model}" is not available on this endpoint.`);
    }
  }
}
