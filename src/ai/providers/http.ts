/** fetch helpers shared by the HTTP-based providers. */
import { AiError } from '../types';

export async function request(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new AiError('aborted', 'Cancelled.');
    // Browsers report unreachable hosts and CORS rejections the same way.
    throw new AiError('network', error instanceof Error ? error.message : String(error));
  }
  if (response.ok) return response;

  let detail = '';
  try {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message ?? body);
    } catch {
      detail = body;
    }
  } catch {
    // no body
  }
  detail = detail.slice(0, 400) || response.statusText;
  const status = response.status;
  if (status === 401 || status === 403) throw new AiError('auth', detail, status);
  if (status === 404) throw new AiError('modelNotFound', detail, status);
  if (status === 429) throw new AiError('rateLimit', detail, status);
  if (status === 413 || /context length|context window|too long|maximum context|too many tokens/i.test(detail)) {
    throw new AiError('tooLong', detail, status);
  }
  if (status >= 500) throw new AiError('server', detail, status);
  throw new AiError('badRequest', detail, status);
}

/** Yields the lines of a streamed response body. */
export async function* lines(response: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line) yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer.trim();
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new AiError('aborted', 'Cancelled.');
    }
    throw new AiError('network', error instanceof Error ? error.message : String(error));
  } finally {
    reader.releaseLock();
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
