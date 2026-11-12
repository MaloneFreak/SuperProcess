import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { reportToDocx } from '../src/core/export/docx';
import { reportToPdf } from '../src/core/export/pdf';
import { buildReportDocument, columnWeights, findingHighlights, textBlocks, toHtml, toMarkdown } from '../src/core/report/document';
import { normalizeReport, type Report } from '../src/core/report/types';
import { initI18n, translatorFor } from '../src/i18n';
import { sampleModel } from '../src/samples/sample';

initI18n('en');
const model = sampleModel('en');
const raw = JSON.parse(readFileSync('e2e/fixtures/report.json', 'utf8')) as unknown;

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) freeze(entry);
  }
  return value;
}

const report = (language = 'en'): Report =>
  freeze({
    id: 'r1',
    focusId: 'cost',
    instructions: '',
    language,
    createdAt: '2026-11-12T10:00:00Z',
    model: 'claude-opus-5-5',
    content: normalizeReport(raw, new Set(model.nodes.map((node) => node.id))),
  });

// A 1×1 opaque PNG stands in for the rendered process map (no alpha channel:
// decoding one needs a Web Worker, which the test environment lacks).
const png = new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'), (c) => c.charCodeAt(0))], { type: 'image/png' });
const diagram = { png, width: 1600, height: 500 };

describe('report document', () => {
  const doc = buildReportDocument(report(), model, 'Cost reduction', translatorFor('en'));

  it('lays the report out in a fixed order', () => {
    const headings = doc.blocks.filter((b) => b.t === 'heading').map((b) => (b.t === 'heading' ? b.text : ''));
    expect(headings).toEqual([
      'Executive summary',
      'Assessment',
      'Key figures',
      'Process facts',
      'Process map',
      'Findings',
      'Cost drivers by step',
      'Quick wins and structural changes',
      'Savings estimate and assumptions',
      'Action plan',
      'Open questions',
      'Limitations',
      'Appendix: process steps',
    ]);
    expect(doc.title).toBe('Cost review: supplier invoice payment');
    expect(doc.meta[0]).toEqual(['Process', 'Supplier invoice payment']);
    expect(doc.disclaimer).toContain('claude-opus-5-5');
  });

  it('names the steps a finding refers to and keeps the worst first', () => {
    const findings = doc.blocks.filter((b) => b.t === 'finding');
    expect(findings).toHaveLength(5);
    const first = findings[0];
    if (first.t !== 'finding') throw new Error('unreachable');
    expect(first.severity).toBe('high');
    expect(first.fields).toContainEqual(['Steps', 'Register invoice in ERP']);
  });

  it('writes chrome in the language of the report', () => {
    const pt = buildReportDocument(report('pt-BR'), model, 'Redução de custos', translatorFor('pt-BR'));
    const headings = pt.blocks.filter((b) => b.t === 'heading').map((b) => (b.t === 'heading' ? b.text : ''));
    expect(headings).toContain('Resumo executivo');
    expect(headings).toContain('Plano de ação');
    expect(pt.meta[2][1]).toBe('12 de novembro de 2026');
    // A language without interface translations falls back to English labels.
    expect(buildReportDocument(report('de'), model, 'x', translatorFor('de')).meta[0][0]).toBe('Process');
  });

  it('highlights steps by their worst finding', () => {
    expect(findingHighlights(report())).toMatchObject({
      t1: { color: '#ea580c', badge: '2' },
      t11: { color: '#2563eb', badge: '1' },
    });
  });

  it('splits text into paragraphs and bullet lists', () => {
    expect(textBlocks('Intro\n- one\n- two\n\nOutro\n1. first\n2) second')).toEqual([
      { t: 'paragraph', text: 'Intro' },
      { t: 'bullets', items: ['one', 'two'] },
      { t: 'paragraph', text: 'Outro' },
      { t: 'bullets', items: ['first', 'second'] },
    ]);
    const weights = columnWeights(['Step', 'Why it costs'], [['A', 'x'.repeat(200)]]);
    expect(weights[0] + weights[1]).toBeCloseTo(1);
    expect(weights[1]).toBeGreaterThan(weights[0]);
  });
});

describe('report writers', () => {
  // Frozen input: a writer that tried to modify the report would throw.
  const doc = freeze(buildReportDocument(report(), model, 'Cost reduction', translatorFor('en')));

  it('writes Markdown', () => {
    const md = toMarkdown(doc);
    expect(md).toContain('# Cost review: supplier invoice payment');
    expect(md).toContain('| Step | Lane | Cost driver | Why it costs | Saving potential |');
    expect(md).toContain('### F1 · Invoice data is typed into the ERP by hand (High)');
    expect(md).not.toContain('![](');
    expect(md).not.toContain('## Process map');
    expect(toMarkdown(doc, 'map.png')).toContain('![](map.png)');
  });

  it('writes self-contained, escaped HTML', () => {
    const hostile = buildReportDocument(
      { ...report(), content: { ...report().content, title: '<script>alert(1)</script>', executiveSummary: 'a < b & "c"' } },
      model,
      'Cost <b>',
      translatorFor('en'),
    );
    const html = toHtml(hostile, '<svg id="map"></svg>');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('a &lt; b &amp; &quot;c&quot;');
    expect(html).toContain('<svg id="map"></svg>');
    expect(html).not.toMatch(/<link|src="http/);
    const parsed = new DOMParser().parseFromString(toHtml(doc, ''), 'text/html');
    expect(parsed.querySelectorAll('section.finding')).toHaveLength(5);
    expect(parsed.querySelectorAll('table').length).toBeGreaterThanOrEqual(6);
  });

  it('writes a Word document with the map on a landscape page', async () => {
    const blob = await reportToDocx(doc, diagram);
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const xml = strFromU8(files['word/document.xml']);
    expect(xml).toContain('Cost review: supplier invoice payment');
    expect(xml).toContain('Invoice data is typed into the ERP by hand');
    expect(xml).toContain('w:orient="landscape"');
    expect(Object.keys(files).some((name) => name.startsWith('word/media/'))).toBe(true);
    expect(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('parsererror')).toHaveLength(0);
  });

  it('writes a PDF without touching the report', async () => {
    const blob = await reportToPdf(doc, diagram);
    const head = strFromU8(new Uint8Array(await blob.slice(0, 5).arrayBuffer()));
    expect(head).toBe('%PDF-');
    expect(blob.size).toBeGreaterThan(20_000);
    // The same document still renders afterwards.
    expect(toHtml(doc, '')).toContain('What is the loaded hourly cost');
  }, 30_000);
});
