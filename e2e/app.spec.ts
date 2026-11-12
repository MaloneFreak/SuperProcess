import { expect, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import { download, mockAnthropic, setUpWithClaude, setUpWithoutAi, usePlainDownloads } from './helpers';

test.beforeEach(async ({ context, page }) => {
  await usePlainDownloads(context);
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) problems.push(message.text());
  });
  test.info().annotations.push({ type: 'problems', description: '' });
  (page as unknown as { problems: string[] }).problems = problems;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems, 'no errors in the browser console').toEqual([]);
});

test('first run without an AI: the sample process, BPMN check, step details, theme and language', async ({ page }) => {
  await setUpWithoutAi(page);
  await expect(page.getByTestId('demo-banner')).toBeVisible();
  await expect(page.getByTestId('analyze')).toBeDisabled();

  await page.getByTestId('open-sample').click();
  await expect(page.getByTestId('analysis-title')).toHaveText('Supplier invoice payment');
  await expect(page.locator('[data-testid=diagram] svg .sp-node')).toHaveCount(24);

  // The Supplier pool runs the whole length of the process. Its name stays in
  // view although the middle of the band is far off to the right.
  const frame = (await page.getByTestId('diagram').locator('..').boundingBox())!;
  const supplier = page.locator('.sp-band-name').first();
  await expect(supplier).toHaveText('Supplier');
  const name = (await supplier.boundingBox())!;
  expect(name.x).toBeGreaterThan(frame.x);
  expect(name.x + name.width).toBeLessThan(frame.x + frame.width);

  await page.locator('[data-tab=quality]').click();
  await expect(page.getByTestId('bpmn-score')).toHaveText('99');

  // Clicking a step in the diagram shows what the meeting said about it.
  await page.locator('.sp-node[data-id="t5"]').click();
  const details = page.getByTestId('step-details');
  await expect(details).toContainText('Approve invoice');
  await expect(details).toContainText('Cost centre manager');
  await expect(details).toContainText('Approvals by phone or in the corridor leave no record');

  // Reports need an AI.
  await expect(page.getByTestId('generate-reports')).toBeDisabled();

  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveClass(/dark/);

  await page.getByTestId('open-settings').click();
  await page.getByTestId('ui-language').selectOption('pt-BR');
  await expect(page.getByRole('heading', { name: 'Configurações' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Configurações' })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
});

test('maps a process with the AI and saves the diagram in every format', async ({ page }) => {
  const requests = await mockAnthropic(page, { delay: 700 });
  await setUpWithClaude(page);

  await page.getByTestId('use-sample').click();
  await expect(page.getByTestId('file-list')).toContainText('accounts-payable-meeting.vtt');
  await page.locator('textarea').fill('We are subject to SOX.');
  await page.locator('[data-format=bpmn]').click();
  await page.getByTestId('analyze').click();

  await expect(page.getByTestId('work-stages')).toContainText('Understanding the process');
  await expect(page.getByTestId('analysis-title')).toHaveText('Supplier invoice payment', { timeout: 20_000 });
  await expect(page.locator('[data-testid=diagram] svg .sp-node')).toHaveCount(24);

  // The request is what the Claude API expects, with the user's context included.
  expect(requests).toHaveLength(1);
  const { body, authorization, beta } = requests[0];
  expect(authorization).toBe('Bearer sk-ant-test-key');
  expect(beta).toContain('server-side-fallback-2026-07-01');
  expect(body).toMatchObject({ model: 'claude-opus-5-5', stream: true, thinking: { type: 'adaptive' }, fallbacks: 'default' });
  expect(body.output_config).toMatchObject({ effort: 'high', format: { type: 'json_schema' } });
  const [sources, instruction] = body.messages[0].content;
  expect(sources.cache_control).toEqual({ type: 'ephemeral' });
  expect(sources.text).toContain('accounts-payable-meeting.vtt');
  expect(sources.text).toContain('<user_notes>\nWe are subject to SOX.\n</user_notes>');
  expect(instruction.text).toContain('Map the process');

  // The main button saves in the format chosen on the start screen.
  const bpmn = await download(page, () => page.getByTestId('save-diagram').click());
  expect(bpmn.name).toBe('Supplier invoice payment.bpmn');
  expect(bpmn.bytes.toString()).toContain('<bpmn:definitions');

  const signatures: Record<string, (bytes: Buffer) => boolean> = {
    vsdx: (bytes) => 'visio/pages/page1.xml' in unzipSync(new Uint8Array(bytes)),
    drawio: (bytes) => bytes.toString().startsWith('<mxfile'),
    svg: (bytes) => bytes.toString().startsWith('<svg'),
    png: (bytes) => bytes.subarray(1, 4).toString() === 'PNG',
    pdf: (bytes) => bytes.subarray(0, 5).toString() === '%PDF-',
  };
  for (const [format, valid] of Object.entries(signatures)) {
    await page.getByTestId('save-menu').click();
    const file = await download(page, () => page.locator(`[role=menu] [data-format=${format}]`).click());
    expect(file.name).toBe(`Supplier invoice payment.${format}`);
    expect(valid(file.bytes), `${format} file is valid`).toBe(true);
  }

  // The analysis is in the history, and survives a reload.
  await page.reload();
  await expect(page.getByTestId('analysis-title')).toHaveText('Supplier invoice payment');
  await page.getByRole('button', { name: 'All analyses' }).click();
  await expect(page.getByTestId('history')).toContainText('24 steps');
});

test('writes several reports at once, shows them and saves them', async ({ page }) => {
  const requests = await mockAnthropic(page);
  await setUpWithClaude(page);
  await page.getByTestId('use-sample').click();
  await page.getByTestId('analyze').click();
  await expect(page.getByTestId('analysis-title')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('focus-picker').click();
  for (const focus of ['cost', 'compliance', 'audit']) await page.locator(`[data-focus=${focus}]`).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('generate-reports').click();
  await expect(page.getByTestId('report-row')).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByTestId('report-job')).toHaveCount(0);

  // One request per report, each with its own brief over the same cached context.
  const reports = requests.slice(1);
  expect(reports).toHaveLength(3);
  const briefs = reports.map((r) => r.body.messages[0].content[1].text);
  expect(briefs.join('\n')).toContain('Angle: cost reduction');
  expect(briefs.join('\n')).toContain('Angle: compliance gaps');
  expect(briefs.join('\n')).toContain('Angle: auditability');
  const contexts = new Set(reports.map((r) => r.body.messages[0].content[0].text));
  expect(contexts.size).toBe(1);
  expect([...contexts][0]).toContain('<process_model>');

  await page.getByTestId('report-row').filter({ hasText: 'Cost reduction' }).getByRole('button', { name: 'View' }).click();
  const view = page.getByTestId('report-view');
  await expect(view).toContainText('Executive summary');
  await expect(view.locator('.finding')).toHaveCount(5);
  await expect(view.locator('.map svg')).toBeVisible();

  // Every format, one after another, from the same report.
  const dialog = page.getByRole('dialog');
  const word = await download(page, () => dialog.getByRole('button', { name: 'Word', exact: true }).click());
  expect(Object.keys(unzipSync(new Uint8Array(word.bytes)))).toContain('word/document.xml');
  const pdf = await download(page, () => dialog.getByRole('button', { name: 'PDF', exact: true }).click());
  expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const html = await download(page, () => dialog.getByRole('button', { name: 'Web page', exact: true }).click());
  expect(html.bytes.toString()).toContain('<h1>Cost reduction and efficiency</h1>');
  expect(html.bytes.toString()).toContain('What is the loaded hourly cost');
  const markdown = await download(page, () => dialog.getByRole('button', { name: 'Markdown', exact: true }).click());
  expect(markdown.bytes.toString()).toContain('# Cost reduction and efficiency');
  await page.keyboard.press('Escape');

  const zip = await download(page, () => page.getByTestId('save-all').click());
  expect(Object.keys(unzipSync(new Uint8Array(zip.bytes))).sort()).toEqual([
    'Supplier invoice payment - Auditability.docx',
    'Supplier invoice payment - Compliance gaps.docx',
    'Supplier invoice payment - Cost reduction.docx',
  ]);

  // Findings show up on the step they refer to.
  await page.locator('.sp-node[data-id="t11"]').click();
  await expect(page.getByTestId('step-details')).toContainText('Bank reconciliation is done in a spreadsheet');

  await page.getByRole('button', { name: 'All analyses' }).click();
  await expect(page.getByTestId('history')).toContainText('3 reports');
});

test('explains files it cannot read and failed AI requests', async ({ page }) => {
  await mockAnthropic(page, { fail: 1 });
  await setUpWithClaude(page);

  await page.getByTestId('file-input').setInputFiles([
    { name: 'old-map.vsd', mimeType: 'application/vnd.visio', buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) },
    { name: 'call.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from([1, 2, 3]) },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('First the clerk checks the order, then the manager approves it.') },
  ]);
  await expect(page.getByTestId('file-error')).toHaveCount(2);
  await expect(page.getByTestId('file-error').first()).toContainText('save it as .vsdx');
  await expect(page.getByTestId('file-list')).toContainText('notes.txt');

  await page.getByTestId('analyze').click();
  await expect(page.getByTestId('work-error')).toContainText('rejected the API key');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('analysis-title')).toBeVisible({ timeout: 20_000 });
});

test('connects a local model through Ollama and downloads one', async ({ page }) => {
  let installed = [{ name: 'gemma3:4b', size: 3_300_000_000, details: { parameter_size: '4.3B' } }];
  const chats: { model: string; options: { num_ctx: number }; format?: object }[] = [];
  await page.route('http://localhost:11434/**', async (route) => {
    const url = route.request().url();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.endsWith('/api/version')) return route.fulfill({ status: 200, headers, contentType: 'application/json', body: '{"version":"0.12.6"}' });
    if (url.endsWith('/api/tags')) return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ models: installed }) });
    if (url.endsWith('/api/pull')) {
      installed = [...installed, { name: 'qwen3:8b', size: 5_200_000_000, details: { parameter_size: '8.2B' } }];
      const lines = [{ status: 'pulling manifest' }, { status: 'pulling', total: 100, completed: 40 }, { status: 'pulling', total: 100, completed: 100 }, { status: 'success' }];
      return route.fulfill({ status: 200, headers, body: lines.map((line) => JSON.stringify(line)).join('\n') });
    }
    if (url.endsWith('/api/chat')) {
      chats.push(JSON.parse(route.request().postData() ?? '{}'));
      const { MODEL } = await import('./helpers');
      const lines = [{ model: 'qwen3:8b', message: { content: MODEL } }, { done: true, done_reason: 'stop', prompt_eval_count: 900, eval_count: 700 }];
      return route.fulfill({ status: 200, headers, body: lines.map((line) => JSON.stringify(line)).join('\n') });
    }
    return route.fulfill({ status: 404, headers });
  });

  await page.goto('/');
  await page.getByTestId('setup-next').click();
  await page.getByRole('button', { name: /Local AI/ }).click();
  await expect(page.getByText('Ollama 0.12.6 is running.')).toBeVisible();
  await expect(page.getByText('gemma3:4b', { exact: true })).toBeVisible();

  // Download a recommended model from inside the app; it is selected when done.
  await page.locator('div').filter({ hasText: /^Qwen3 8B/ }).getByRole('button', { name: 'Download' }).first().click();
  await expect(page.locator('div').filter({ hasText: /^qwen3:8b/ }).getByText('In use').first()).toBeVisible();

  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByTestId('ai-test-ok')).toContainText('qwen3:8b');
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-start').click();

  await page.getByTestId('use-sample').click();
  await page.getByTestId('analyze').click();
  await expect(page.getByTestId('analysis-title')).toHaveText('Supplier invoice payment', { timeout: 20_000 });
  // The context window is set explicitly and the answer is schema-constrained.
  expect(chats[0]).toMatchObject({ model: 'qwen3:8b', options: { num_ctx: 16384 } });
  expect(chats[0].format).toMatchObject({ type: 'object' });
});
