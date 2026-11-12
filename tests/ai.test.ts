import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateTokens, parseJsonLenient } from '../src/ai/json';
import { analyze, runReportJobs, writeReport } from '../src/ai/pipeline';
import { AnthropicProvider } from '../src/ai/providers/anthropic';
import { OllamaProvider, detectOllama } from '../src/ai/providers/ollama';
import { OpenAiCompatibleProvider } from '../src/ai/providers/openaiCompatible';
import { createProvider, defaultConfig, isConfigured, suggestModel } from '../src/ai/registry';
import { PROCESS_SCHEMA, REPORT_SCHEMA } from '../src/ai/schemas';
import { AiError, type AiProvider, type ChatRequest, type ChatResult, type ProviderConfig } from '../src/ai/types';
import { normalizeModel } from '../src/core/model/normalize';
import type { SourceDocument } from '../src/core/import';
import { purchaseRaw } from './fixtures/models';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Replaces global fetch with a scripted one and records the requests. */
function mockFetch(responder: (call: Captured, n: number) => Response): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined;
      const headers: Record<string, string> = {};
      new Headers(init?.headers ?? request?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const raw = init?.body ?? (request ? await request.text() : undefined);
      const call: Captured = {
        url: String(request?.url ?? input),
        headers,
        body: typeof raw === 'string' && raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      calls.push(call);
      return responder(call, calls.length);
    }),
  );
  return calls;
}

const sse = (events: string[], status = 200): Response =>
  new Response(events.join(''), { status, headers: { 'content-type': 'text/event-stream' } });
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const config = (overrides: Partial<ProviderConfig>): ProviderConfig => ({ ...defaultConfig('custom'), ...overrides });
const request = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  system: 'SYSTEM',
  context: 'CONTEXT',
  prompt: 'PROMPT',
  schema: { type: 'object' },
  schemaName: 'thing',
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('parseJsonLenient', () => {
  it('reads plain, fenced and prefixed JSON', () => {
    expect(parseJsonLenient('{"a":1}').value).toEqual({ a: 1 });
    expect(parseJsonLenient('Here you go:\n```json\n{"a":[1,2,],}\n```\nDone.').value).toEqual({ a: [1, 2] });
    expect(parseJsonLenient('<think>{"not": "this"}</think>{"a":"}"}').value).toEqual({ a: '}' });
  });

  it('salvages the complete part of a truncated answer', () => {
    const cut = '{"name":"P","nodes":[{"id":"a","name":"A"},{"id":"b","name":"B"},{"id":"c","na';
    const parsed = parseJsonLenient(cut);
    expect(parsed.truncated).toBe(true);
    expect(parsed.value).toEqual({ name: 'P', nodes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
  });

  it('fails clearly when there is no object', () => {
    expect(() => parseJsonLenient('I cannot help with that.')).toThrow(AiError);
  });
});

describe('schemas', () => {
  it('stay within the strict subset every provider accepts', () => {
    const check = (schema: Record<string, unknown>, path: string): void => {
      if (schema.type === 'object') {
        expect(schema.additionalProperties, path).toBe(false);
        const properties = schema.properties as Record<string, Record<string, unknown>>;
        expect(schema.required, path).toEqual(Object.keys(properties));
        for (const [key, value] of Object.entries(properties)) check(value, `${path}.${key}`);
      }
      if (schema.type === 'array') check(schema.items as Record<string, unknown>, `${path}[]`);
      for (const banned of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems']) {
        expect(schema[banned], `${path}.${banned}`).toBeUndefined();
      }
    };
    check(PROCESS_SCHEMA, 'process');
    check(REPORT_SCHEMA, 'report');
  });
});

describe('Anthropic provider', () => {
  const events = (text: string[], stop = 'end_turn'): string[] => [
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 },
      },
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    ...text.map(
      (part) =>
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } })}\n\n`,
    ),
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 40 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];
  const provider = (model = 'claude-opus-5-5'): AnthropicProvider =>
    new AnthropicProvider({ ...defaultConfig('anthropic'), apiKey: 'sk-ant-test', model });

  it('sends a streaming, cached, schema-constrained request with a refusal fallback', async () => {
    const calls = mockFetch(() => sse(events(['{"a"', ':1}'])));
    const seen: string[] = [];
    let started = 0;
    const result = await provider().chat(request({ onText: (t) => seen.push(t), onStart: () => started++ }));

    expect(result.text).toBe('{"a":1}');
    expect(result.model).toBe('claude-opus-5-5');
    expect(result.usage).toEqual({ inputTokens: 912, outputTokens: 40, cachedTokens: 900 });
    expect(seen).toEqual(['{"a"', '{"a":1}']);
    expect(started).toBe(1);

    const [call] = calls;
    expect(call.url).toContain('https://api.anthropic.com/v1/messages');
    expect(call.headers.authorization).toBe('Bearer sk-ant-test');
    expect(call.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(call.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(call.body).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } },
      fallbacks: 'default',
      system: 'SYSTEM',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'CONTEXT', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'PROMPT' },
          ],
        },
      ],
    });
    // Sampling parameters and thinking budgets are rejected by current models.
    for (const banned of ['temperature', 'top_p', 'top_k']) expect(call.body[banned]).toBeUndefined();
  });

  it('does not ask for a fallback on Haiku', async () => {
    const calls = mockFetch(() => sse(events(['{}'])));
    await provider('claude-haiku-5-5').chat(request());
    expect(calls[0].body.fallbacks).toBeUndefined();
    expect(calls[0].headers['anthropic-beta'] ?? '').not.toContain('server-side-fallback');
  });

  it('reports refusals, truncation and bad keys as typed errors', async () => {
    mockFetch(() => sse(events([''], 'refusal')));
    await expect(provider().chat(request())).rejects.toMatchObject({ kind: 'refusal' });

    mockFetch(() => sse(events(['{"a":'], 'max_tokens')));
    await expect(provider().chat(request())).rejects.toMatchObject({ kind: 'truncated' });

    mockFetch(() => json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401));
    await expect(provider().chat(request())).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('tests the connection by looking the model up', async () => {
    const calls = mockFetch(() => json({ id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }));
    await provider().test();
    expect(calls[0].url).toContain('/v1/models/claude-opus-5-5');

    mockFetch(() => json({ type: 'error', error: { type: 'not_found_error', message: 'no such model' } }, 404));
    await expect(provider('claude-typo').test()).rejects.toMatchObject({ kind: 'modelNotFound' });
  });
});

describe('OpenAI-compatible provider', () => {
  const chunks = (parts: string[], finish = 'stop'): string[] => [
    ...parts.map((content) => `data: ${JSON.stringify({ model: 'm-1', choices: [{ delta: { content } }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const provider = (): OpenAiCompatibleProvider =>
    new OpenAiCompatibleProvider(config({ baseUrl: 'https://llm.example/v1/', apiKey: 'key', model: 'm-1' }));

  it('streams a strict JSON-schema completion', async () => {
    const calls = mockFetch(() => sse(chunks(['{"ok"', ':true}'])));
    const result = await provider().chat(request());
    expect(result).toMatchObject({ text: '{"ok":true}', model: 'm-1', usage: { inputTokens: 7, outputTokens: 3 } });
    expect(calls[0].url).toBe('https://llm.example/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer key');
    expect(calls[0].body).toMatchObject({
      model: 'm-1',
      stream: true,
      messages: [
        { role: 'system', content: 'SYSTEM' },
        { role: 'user', content: 'CONTEXT\n\nPROMPT' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'thing', strict: true, schema: { type: 'object' } } },
    });
  });

  it('falls back when the server rejects structured output, and remembers it', async () => {
    const calls = mockFetch((call) => {
      const format = (call.body.response_format as { type?: string } | undefined)?.type;
      return format ? json({ error: { message: `response_format ${format} not supported` } }, 400) : sse(chunks(['{"ok":1}']));
    });
    const p = provider();
    await p.chat(request());
    expect(calls.map((c) => (c.body.response_format as { type?: string } | undefined)?.type)).toEqual(['json_schema', 'json_object', undefined]);
    await p.chat(request());
    expect(calls).toHaveLength(4);
  });

  it('maps errors and cut-off answers', async () => {
    mockFetch(() => json({ error: { message: 'Incorrect API key' } }, 401));
    await expect(provider().chat(request())).rejects.toMatchObject({ kind: 'auth' });
    mockFetch(() => json({ error: { message: 'slow down' } }, 429));
    await expect(provider().chat(request())).rejects.toMatchObject({ kind: 'rateLimit' });
    mockFetch(() => json({ error: { message: "This model's maximum context length is 8192 tokens" } }, 400));
    await expect(provider().chat(request({ schema: undefined }))).rejects.toMatchObject({ kind: 'tooLong' });
    mockFetch(() => sse(chunks(['{"a":'], 'length')));
    await expect(provider().chat(request())).rejects.toMatchObject({ kind: 'truncated' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(provider().chat(request())).rejects.toMatchObject({ kind: 'network' });
  });

  it('lists models and checks the chosen one exists', async () => {
    mockFetch(() => json({ data: [{ id: 'm-2' }, { id: 'models/m-1' }] }));
    expect((await provider().listModels()).map((m) => m.id)).toEqual(['m-1', 'm-2']);
    await provider().test();
    mockFetch(() => json({ data: [{ id: 'other' }] }));
    await expect(provider().test()).rejects.toMatchObject({ kind: 'modelNotFound' });
  });
});

describe('Ollama provider', () => {
  const ndjson = (rows: unknown[]): Response => new Response(rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  const provider = (): OllamaProvider => new OllamaProvider({ ...defaultConfig('ollama'), model: 'qwen3:8b', contextTokens: 32768 });

  it('chats with a schema and an explicit context window', async () => {
    const calls = mockFetch(() =>
      ndjson([
        { model: 'qwen3:8b', message: { content: '{"x":' } },
        { message: { content: '2}' } },
        { done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 9 },
      ]),
    );
    const result = await provider().chat(request());
    expect(result).toMatchObject({ text: '{"x":2}', usage: { inputTokens: 100, outputTokens: 9 } });
    expect(calls[0].url).toBe('http://localhost:11434/api/chat');
    expect(calls[0].body).toMatchObject({ model: 'qwen3:8b', stream: true, format: { type: 'object' }, options: { num_ctx: 32768 } });
  });

  it('reports download progress', async () => {
    mockFetch(() =>
      ndjson([{ status: 'pulling manifest' }, { status: 'pulling abc', total: 200, completed: 50 }, { status: 'success' }]),
    );
    const seen: (number | undefined)[] = [];
    await provider().pull('gemma3:4b', (p) => seen.push(p.fraction));
    expect(seen).toEqual([undefined, 0.25, undefined]);
  });

  it('checks that the model is installed and detects the server', async () => {
    mockFetch(() => json({ models: [{ name: 'gemma3:4b', size: 3_300_000_000 }] }));
    await expect(provider().test()).rejects.toMatchObject({ kind: 'modelNotFound' });
    mockFetch(() => json({ version: '0.12.3' }));
    expect(await detectOllama('http://localhost:11434')).toBe('0.12.3');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await detectOllama('http://localhost:11434')).toBeNull();
  });
});

describe('registry', () => {
  it('builds the right client and refuses incomplete configurations', () => {
    expect(isConfigured(defaultConfig('anthropic'))).toBe(false);
    expect(isConfigured({ ...defaultConfig('anthropic'), apiKey: 'k' })).toBe(true);
    expect(defaultConfig('anthropic').model).toBe('claude-opus-5-5');
    expect(isConfigured({ ...defaultConfig('ollama'), model: 'qwen3:8b' })).toBe(true);
    expect(isConfigured(defaultConfig('demo'))).toBe(false);
    expect(createProvider({ ...defaultConfig('anthropic'), apiKey: 'k' })).toBeInstanceOf(AnthropicProvider);
    expect(createProvider({ ...defaultConfig('ollama'), model: 'm' })).toBeInstanceOf(OllamaProvider);
    expect(createProvider({ ...defaultConfig('openai'), apiKey: 'k', model: 'm' })).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(() => createProvider(defaultConfig('openai'))).toThrow(AiError);
  });

  it('suggests a general-purpose model from a live list', () => {
    expect(suggestModel(['text-embedding-3-large', 'gpt-5-mini', 'gpt-5.1', 'gpt-4o', 'whisper-1'])).toBe('gpt-5.1');
    expect(suggestModel(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-embedding-001'])).toBe('gemini-2.5-pro');
    expect(suggestModel([])).toBe('');
  });
});

/** A provider that answers from a script and records what it was asked. */
type Script = (string | Error)[] | ((request: ChatRequest) => string | Error);

function scripted(answers: Script, overrides: Partial<ProviderConfig> = {}): AiProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    config: { ...defaultConfig('anthropic'), apiKey: 'k', ...overrides },
    requests,
    async chat(req): Promise<ChatResult> {
      requests.push(req);
      const answer = typeof answers === 'function' ? answers(req) : answers[requests.length - 1];
      if (answer === undefined) throw new Error('unexpected request');
      if (answer instanceof Error) throw answer;
      req.onStart?.();
      req.onText?.(answer);
      return { text: answer, model: 'fake-model', usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 } };
    },
    listModels: async () => [],
    test: async () => {},
  };
}

const transcript: SourceDocument = { name: 'meeting.vtt', kind: 'transcript', format: 'WebVTT', text: '[00:01] Ana: We raise a request.' };
const goodModel = JSON.stringify(purchaseRaw);
const flawed = JSON.stringify({
  name: 'Flawed',
  lanes: [{ id: 'l', name: 'Team' }],
  nodes: [
    { id: 's', type: 'startEvent', name: 'Begin', lane: 'l' },
    { id: 'a', type: 'task', name: 'Work', lane: 'l' },
    { id: 'b', type: 'task', name: 'Ship', lane: 'l' },
    { id: 'c', type: 'task', name: 'Bill', lane: 'l' },
    { id: 'e', type: 'endEvent', name: 'Done', lane: 'l' },
  ],
  flows: [
    { from: 's', to: 'a' },
    { from: 'a', to: 'b' },
    { from: 'a', to: 'c' },
    { from: 'b', to: 'e' },
    { from: 'c', to: 'e' },
  ],
});

describe('analyze', () => {
  it('extracts a model in one pass when it is clean', async () => {
    const provider = scripted([goodModel]);
    const stages: string[] = [];
    const result = await analyze(provider, { sources: [transcript], userNotes: 'Focus on approvals', language: 'auto' }, (p) => stages.push(p.stage));

    expect(provider.requests).toHaveLength(1);
    expect(result.model.name).toBe('Purchase request approval');
    expect(result.validation.counts.error).toBe(0);
    expect(result.aiModel).toBe('fake-model');
    expect(stages).toContain('model');
    expect(stages).toContain('check');

    const req = provider.requests[0];
    expect(req.schema).toBe(PROCESS_SCHEMA);
    expect(req.context).toContain('<source index="1" name="meeting.vtt" kind="transcript" format="WebVTT">');
    expect(req.context).toContain('<user_notes>\nFocus on approvals\n</user_notes>');
    expect(req.system).toContain('language of the sources');
  });

  it('asks the model to fix what the BPMN check finds, and keeps the better result', async () => {
    const provider = scripted([flawed, goodModel]);
    const result = await analyze(provider, { sources: [transcript], userNotes: '', language: 'pt-BR' });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].prompt).toContain('several outgoing flows');
    expect(provider.requests[1].context).toBe(provider.requests[0].context);
    expect(provider.requests[0].system).toContain('Brazilian Portuguese');
    expect(result.model.name).toBe('Purchase request approval');
    expect(result.usage.outputTokens).toBe(10);
  });

  it('keeps the first model when the repair pass fails or makes things worse', async () => {
    const failing = scripted([flawed, new AiError('server', 'boom')]);
    expect((await analyze(failing, { sources: [transcript], userNotes: '', language: 'auto' })).model.name).toBe('Flawed');

    const worse = scripted([flawed, '{"name":"Empty","nodes":[],"flows":[]}']);
    expect((await analyze(worse, { sources: [transcript], userNotes: '', language: 'auto' })).model.name).toBe('Flawed');
  });

  it('rejects an answer without steps and passes cancellation through', async () => {
    await expect(analyze(scripted(['{"nodes":[]}']), { sources: [transcript], userNotes: '', language: 'auto' })).rejects.toMatchObject({
      kind: 'invalidOutput',
    });
    const cancelled = scripted([flawed, new AiError('aborted', 'Cancelled.')]);
    await expect(analyze(cancelled, { sources: [transcript], userNotes: '', language: 'auto' })).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('condenses transcripts that exceed a small context window', async () => {
    const long: SourceDocument = { ...transcript, text: Array.from({ length: 400 }, (_, i) => `[${i}] Speaker: line ${i} of the meeting about invoices.`).join('\n') };
    let note = 0;
    const provider = scripted((req) => (req.schema ? goodModel : `notes ${++note}`), { contextTokens: 14_000 });
    const parts: number[] = [];
    const result = await analyze(provider, { sources: [long], userNotes: '', language: 'auto' }, (p) => {
      if (p.stage === 'condense' && p.parts) parts.push(p.parts);
    });
    const noteCalls = provider.requests.filter((r) => !r.schema);
    expect(noteCalls.length).toBeGreaterThan(1);
    expect(parts[0]).toBe(noteCalls.length);
    expect(estimateTokens(long.text)).toBeGreaterThan(14_000 - 11_500);
    expect(result.sources[0].text).toContain('notes 1');
    expect(result.sources[0].format).toBe('WebVTT (notes)');
    // Every line of the transcript reached the model exactly once.
    const sent = noteCalls.map((r) => r.prompt).join('\n');
    for (const i of [0, 137, 399]) expect(sent).toContain(`line ${i} of the meeting`);
  });

  it('refuses rather than truncating a diagram that cannot fit', async () => {
    const huge: SourceDocument = { name: 'map.vsdx', kind: 'diagram', format: 'Visio', text: 'x'.repeat(200_000) };
    await expect(
      analyze(scripted([goodModel], { contextTokens: 16_000 }), { sources: [huge], userNotes: '', language: 'auto' }),
    ).rejects.toMatchObject({ kind: 'tooLong' });
  });
});

describe('reports', () => {
  const { model } = normalizeModel(purchaseRaw);
  const answer = JSON.stringify({
    title: 'Cost review',
    executiveSummary: 'Approvals wait too long.',
    score: { value: 58, label: 'Room to improve', rationale: 'Manual hand-offs.' },
    dimensions: [{ name: 'Manual effort', score: 40, comment: 'High' }],
    metrics: [{ label: 'Hand-offs', value: '7', note: 'from the model' }],
    findings: [
      { id: 'F1', title: 'Slow approval', severity: 'HIGH', category: 'Waiting', steps: ['t2', 'nope'], description: 'd', evidence: 'e', impact: 'i', recommendation: 'r' },
      { id: 'F2', title: 'Chasing by phone', severity: 'minor', category: '', steps: ['t5b'], description: 'd', evidence: '', impact: '', recommendation: '' },
    ],
    sections: [{ heading: 'Cost drivers', body: 'See table.', table: { columns: ['Step', 'Driver'], rows: [['Review request', 'Waiting'], ['Chase', 'Manual', 'extra']] } }],
    actions: [{ title: 'Add reminders', description: '', priority: 'high', effort: 'Low', impact: 'medium', horizon: 'quick win', findings: ['F1', 'F9'] }],
    openQuestions: ['Volume per month?'],
    limitations: 'No volumes given.',
  });

  it('writes a normalised report in the requested language', async () => {
    const provider = scripted([answer]);
    const result = await writeReport(provider, { model, sources: [transcript], userNotes: '', language: 'es' }, { focusId: 'cost', instructions: 'Be brief' });
    const req = provider.requests[0];
    expect(req.schema).toBe(REPORT_SCHEMA);
    expect(req.system).toContain('Spanish (es)');
    expect(req.prompt).toContain('Angle: cost reduction');
    expect(req.prompt).toContain('<additional_instructions>\nBe brief');
    expect(req.context).toContain('<process_model>');
    expect(req.context).toContain('"handoffs"');
    expect(req.context).toContain('meeting.vtt');

    expect(result.language).toBe('es');
    expect(result.content.findings.map((f) => [f.id, f.severity, f.steps])).toEqual([
      ['F1', 'high', ['t2']],
      ['F2', 'low', ['t5b']],
    ]);
    expect(result.content.sections[0].table.rows).toEqual([['Review request', 'Waiting'], ['Chase', 'Manual']]);
    expect(result.content.actions[0]).toMatchObject({ effort: 'low', horizon: 'quickWin', findings: ['F1'] });
  });

  it('uses the user brief for a custom focus and the model language for "auto"', async () => {
    const provider = scripted([answer]);
    const result = await writeReport(provider, { model, sources: [], userNotes: '', language: 'auto' }, { focusId: 'custom', instructions: 'Assess ESG impact' });
    expect(provider.requests[0].prompt).toContain('Assess ESG impact');
    expect(provider.requests[0].system).toContain('English (en)');
    expect(result.language).toBe('en');
  });

  it('leaves the sources out, with a note, when they do not fit', async () => {
    const big: SourceDocument = { ...transcript, text: 'word '.repeat(40_000) };
    const provider = scripted([answer], { contextTokens: 24_000 });
    await writeReport(provider, { model, sources: [big], userNotes: '', language: 'auto' }, { focusId: 'audit', instructions: '' });
    expect(provider.requests[0].context).not.toContain('word word');
    expect(provider.requests[0].prompt).toContain('not included');
  });

  it('starts the first cloud report alone so the others reuse its prompt cache', async () => {
    const log: string[] = [];
    let releaseFirst: () => void = () => {};
    const provider = scripted([]);
    const done = runReportJobs(provider, ['a', 'b', 'c'], async (job, onStart) => {
      log.push(`start ${job}`);
      if (job === 'a') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        onStart();
      }
      log.push(`end ${job}`);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(log).toEqual(['start a']);
    releaseFirst();
    await done;
    expect(log.slice(0, 2)).toEqual(['start a', 'end a']);
    expect(log).toHaveLength(6);
  });

  it('runs local reports one at a time', async () => {
    const provider = scripted([], { provider: 'ollama' });
    let running = 0;
    let peak = 0;
    await runReportJobs(provider, [1, 2, 3], async () => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
    });
    expect(peak).toBe(1);
  });
});
