/**
 * Claude, through the official Anthropic SDK.
 *
 * SuperProcess is a bring-your-own-key app: the key stays on the user's
 * machine and requests go straight from it to api.anthropic.com, which is why
 * the SDK's browser guard is switched off here.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AiError, type AiProvider, type ChatRequest, type ChatResult, type ModelInfo, type ProviderConfig } from '../types';

const MAX_OUTPUT_TOKENS = 64000;

/** Server-side fallback is not offered for Haiku models. */
const supportsFallback = (model: string): boolean => !model.includes('haiku');

function toAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof Anthropic.APIUserAbortError) return new AiError('aborted', 'Cancelled.');
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AiError('auth', error.message, error.status);
  }
  if (error instanceof Anthropic.NotFoundError) return new AiError('modelNotFound', error.message, error.status);
  if (error instanceof Anthropic.RateLimitError) return new AiError('rateLimit', error.message, error.status);
  if (error instanceof Anthropic.ContentTooLargeError) return new AiError('tooLong', error.message, error.status);
  if (error instanceof Anthropic.BadRequestError) {
    const tooLong = /prompt is too long|context window|too many tokens/i.test(error.message);
    return new AiError(tooLong ? 'tooLong' : 'badRequest', error.message, error.status);
  }
  if (error instanceof Anthropic.APIConnectionError) return new AiError('network', error.message);
  if (error instanceof Anthropic.APIError) return new AiError('server', error.message, error.status);
  return new AiError('server', error instanceof Error ? error.message : String(error));
}

export class AnthropicProvider implements AiProvider {
  private readonly client: Anthropic;

  constructor(readonly config: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || undefined,
      dangerouslyAllowBrowser: true,
      maxRetries: 2,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const { model, effort } = this.config;
    const fallback = supportsFallback(model);
    try {
      const stream = this.client.beta.messages.stream(
        {
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          thinking: { type: 'adaptive' },
          output_config: {
            effort,
            ...(request.schema ? { format: { type: 'json_schema' as const, schema: request.schema } } : {}),
          },
          // If a safety classifier declines the request, let the API retry it
          // on the model Anthropic recommends instead of failing the analysis.
          ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          system: request.system,
          messages: [
            {
              role: 'user',
              content: [
                // The sources are identical across the extraction, its repair
                // pass and every report: cache up to here.
                ...(request.context
                  ? [{ type: 'text' as const, text: request.context, cache_control: { type: 'ephemeral' as const } }]
                  : []),
                { type: 'text' as const, text: request.prompt },
              ],
            },
          ],
        },
        { signal: request.signal },
      );

      let started = false;
      stream.on('streamEvent', () => {
        if (!started) {
          started = true;
          request.onStart?.();
        }
      });
      stream.on('text', (_delta, snapshot) => request.onText?.(snapshot));

      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') {
        throw new AiError('refusal', message.stop_details?.explanation ?? 'The model declined this request.');
      }
      if (message.stop_reason === 'max_tokens') {
        throw new AiError('truncated', 'The answer was cut off because it reached the output limit.');
      }
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      return {
        text,
        model: message.model,
        usage: {
          inputTokens:
            message.usage.input_tokens +
            (message.usage.cache_creation_input_tokens ?? 0) +
            (message.usage.cache_read_input_tokens ?? 0),
          outputTokens: message.usage.output_tokens,
          cachedTokens: message.usage.cache_read_input_tokens ?? 0,
        },
      };
    } catch (error) {
      throw toAiError(error);
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const models: ModelInfo[] = [];
      for await (const model of this.client.models.list({ limit: 100 }, { signal })) {
        models.push({ id: model.id, label: model.display_name });
      }
      return models;
    } catch (error) {
      throw toAiError(error);
    }
  }

  /** Looks the model up: validates the key and the model id without generating anything. */
  async test(signal?: AbortSignal): Promise<void> {
    try {
      await this.client.models.retrieve(this.config.model, {}, { signal });
    } catch (error) {
      throw toAiError(error);
    }
  }
}
