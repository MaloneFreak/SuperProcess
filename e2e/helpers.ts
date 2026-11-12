import { readFileSync } from 'node:fs';
import type { BrowserContext, Download, Page, Route } from '@playwright/test';

export const MODEL = readFileSync(new URL('./fixtures/model.json', import.meta.url), 'utf8');
export const REPORT = JSON.parse(readFileSync(new URL('./fixtures/report.json', import.meta.url), 'utf8')) as Record<string, unknown>;

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

/** A Messages API reply, as the server-sent events the SDK expects. */
export function anthropicStream(text: string, stopReason = 'end_turn'): string {
  const event = (type: string, data: object): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const parts = text.match(/[\s\S]{1,500}/g) ?? [''];
  return (
    event('message_start', {
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }) +
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    parts.map((part) => event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: part } })).join('') +
    event('content_block_stop', { index: 0 }) +
    event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 900 } }) +
    event('message_stop', {})
  );
}

export interface SeenRequest {
  authorization: string;
  beta: string;
  body: {
    model: string;
    system: string;
    stream: boolean;
    thinking: { type: string };
    output_config: { effort: string; format?: { type: string } };
    fallbacks?: string;
    messages: { content: { text: string; cache_control?: { type: string } }[] }[];
  };
}

/**
 * Stands in for api.anthropic.com: looks up models, maps the process with the
 * fixture model and writes the fixture report, titled after the requested angle.
 */
export async function mockAnthropic(page: Page, options: { delay?: number; fail?: number } = {}): Promise<SeenRequest[]> {
  const seen: SeenRequest[] = [];
  await page.route('https://api.anthropic.com/**', async (route: Route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (request.url().includes('/v1/models')) {
      const key = request.headers().authorization ?? '';
      if (key.includes('bad')) {
        return route.fulfill({ status: 401, headers: CORS, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
      }
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }),
      });
    }
    const body = JSON.parse(request.postData() ?? '{}') as SeenRequest['body'];
    seen.push({ authorization: request.headers().authorization ?? '', beta: request.headers()['anthropic-beta'] ?? '', body });
    if (options.fail && seen.length <= options.fail) {
      return route.fulfill({ status: 401, headers: CORS, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
    }
    await new Promise((resolve) => setTimeout(resolve, options.delay ?? 300));
    let text = MODEL;
    if (body.system.includes('principal consultant')) {
      const prompt = body.messages[0].content.map((part) => part.text).join('\n');
      const angle = prompt.match(/Angle: ([^.\n]+)/)?.[1] ?? 'report';
      text = JSON.stringify({ ...REPORT, title: `${angle[0].toUpperCase()}${angle.slice(1)}` });
    }
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: anthropicStream(text) });
  });
  return seen;
}

/** The native "Save as" dialog cannot be automated; without it the app downloads instead. */
export async function usePlainDownloads(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
}

export async function download(page: Page, trigger: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const [file]: [Download, void] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const path = await file.path();
  return { name: file.suggestedFilename(), bytes: readFileSync(path) };
}

/** Goes through the first-run setup with a Claude API key. */
export async function setUpWithClaude(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('setup-next').click();
  await page.locator('input[type=password]').fill('sk-ant-test-key');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await page.getByTestId('ai-test-ok').waitFor();
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-start').click();
  await page.getByTestId('dropzone').waitFor();
}

/** Goes through the first-run setup without connecting an AI. */
export async function setUpWithoutAi(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-skip').click();
  await page.getByTestId('setup-start').click();
  await page.getByTestId('dropzone').waitFor();
}
