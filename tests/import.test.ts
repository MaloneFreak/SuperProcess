import { describe, expect, it } from 'vitest';
import { strToU8, zipSync, zlibSync } from 'fflate';
import { normalizeModel } from '../src/core/model/normalize';
import { layoutProcess } from '../src/core/layout/layout';
import { exportBpmn } from '../src/core/export/bpmn';
import { exportDrawio } from '../src/core/export/drawio';
import { exportVsdx } from '../src/core/export/vsdx';
import { importBpmn } from '../src/core/import/bpmn';
import { importDrawio } from '../src/core/import/drawio';
import { importVsdx } from '../src/core/import/vsdx';
import { ingest, UnsupportedFileError } from '../src/core/import';
import { parseDocx, parseSrt, parseTranscriptJson, parseVtt } from '../src/core/import/transcript';
import { getTheme } from '../src/core/render/theme';
import { purchaseRaw, tangledRaw } from './fixtures/models';

const { model } = normalizeModel(purchaseRaw);
const layout = layoutProcess(model);
const theme = getTheme('color');
const named = model.nodes.filter((n) => n.name);

describe('Visio import', () => {
  const sketch = importVsdx(exportVsdx(model, layout, { theme }));
  const page = sketch.pages[0];

  it('recovers every step with its text and stencil', () => {
    for (const node of named) {
      const shape = page.shapes.find((s) => s.text === node.name);
      expect(shape, node.name).toBeDefined();
    }
    expect(page.shapes.find((s) => s.text === 'Review request')?.kind).toBe('task');
    expect(page.shapes.find((s) => s.text === 'Request approved?')?.kind).toBe('gateway');
    expect(page.shapes.find((s) => s.text === 'Purchase need identified')?.kind).toBe('startEvent');
    expect(page.shapes.find((s) => s.text === 'Order placed')?.kind).toBe('endEvent');
  });

  it('recovers swimlanes and which lane each step is in', () => {
    const lanes = page.containers.filter((c) => c.kind === 'lane').map((c) => c.label);
    expect(lanes).toEqual(expect.arrayContaining(model.lanes.map((l) => l.name)));
    expect(page.containers.find((c) => c.kind === 'pool')?.label).toBe('Acme Ltd');
    expect(page.shapes.find((s) => s.text === 'Review request')?.container).toBe('Acme Ltd / Line manager');
    expect(page.shapes.find((s) => s.text === 'Reserve budget')?.container).toBe('Acme Ltd / Finance');
  });

  it('recovers connections with direction, labels and kind', () => {
    expect(page.connections).toHaveLength(model.flows.length + model.messageFlows.length);
    const id = (text: string): string => page.shapes.find((s) => s.text === text)!.id;
    expect(page.connections).toContainEqual({
      from: id('Request approved?'),
      to: id('Adjust request'),
      label: 'Needs changes',
      kind: 'sequence',
    });
    expect(page.connections).toContainEqual({
      from: id('Request three quotations'),
      to: id('Supplier'),
      label: 'Quotation request',
      kind: 'message',
    });
  });

  it('carries shape data', () => {
    expect(page.shapes.find((s) => s.text === 'Review request')?.props).toMatchObject({
      BpmnType: 'User task',
      Systems: 'ERP, E-mail',
      Duration: '2 days',
    });
  });

  it('rejects files that are not Visio drawings', () => {
    expect(() => importVsdx(strToU8('not a zip'))).toThrow(/vsdx/);
    expect(() => importVsdx(zipSync({ 'hello.xml': strToU8('<a/>') }))).toThrow(/Visio/);
  });
});

describe('BPMN import', () => {
  it('round-trips nodes, lanes, flows and message flows', () => {
    const sketch = importBpmn(exportBpmn(model, layout));
    const pool = sketch.pools.find((p) => !p.blackBox)!;
    expect(pool.name).toBe('Acme Ltd');
    expect(pool.nodes).toHaveLength(model.nodes.length);
    expect(pool.flows).toHaveLength(model.flows.length);
    expect(pool.lanes.map((l) => l.name)).toEqual(model.lanes.map((l) => l.name));
    expect(sketch.pools.filter((p) => p.blackBox).map((p) => p.name)).toEqual(['Supplier']);
    expect(sketch.messageFlows).toContainEqual({ from: 't4', to: 'Supplier', label: 'Quotation request' });

    const timer = pool.nodes.find((n) => n.id === 'b1')!;
    expect(timer).toMatchObject({ type: 'boundaryEvent', eventKind: 'timer', attachedTo: 't5', interrupting: false });
    expect(pool.nodes.find((n) => n.id === 't2')?.lane).toBe('mgr');
    expect(pool.nodes.find((n) => n.id === 't2')?.documentation).toContain('Systems: ERP, E-mail');
  });

  it('keeps default flows and loop markers', () => {
    const tangled = normalizeModel(tangledRaw).model;
    const sketch = importBpmn(exportBpmn(tangled, layoutProcess(tangled)));
    const pool = sketch.pools.find((p) => !p.blackBox)!;
    expect(pool.flows.find((f) => f.label === 'Always')?.isDefault).toBe(true);
    expect(pool.nodes.find((n) => n.name === 'Transfer payment')?.loop).toBe('parallel');
    expect(pool.nodes.find((n) => n.name === 'Claim closed')?.eventKind).toBe('terminate');
  });

  it('rejects other XML', () => {
    expect(() => importBpmn('<html/>')).toThrow(/BPMN/);
  });
});

describe('draw.io import', () => {
  const xml = exportDrawio(model, layout, theme);

  it('round-trips shapes, lanes and connections', () => {
    const page = importDrawio(xml).pages[0];
    for (const node of named) expect(page.shapes.find((s) => s.text === node.name), node.name).toBeDefined();
    expect(page.shapes.find((s) => s.text === 'Review request')).toMatchObject({
      kind: 'task',
      container: 'Acme Ltd / Line manager',
      props: { Systems: 'ERP, E-mail' },
    });
    expect(page.shapes.find((s) => s.text === 'Request approved?')?.kind).toBe('gateway');
    expect(page.connections).toHaveLength(model.flows.length + model.messageFlows.length);
    expect(page.connections).toContainEqual({ from: 'g1', to: 't3', label: 'Needs changes', kind: 'sequence' });
    expect(page.containers.find((c) => c.kind === 'pool')?.label).toBe('Acme Ltd');
  });

  it('reads compressed pages', () => {
    const inner = xml.slice(xml.indexOf('<mxGraphModel'), xml.indexOf('</diagram>'));
    const deflated = zlibSync(strToU8(encodeURIComponent(inner))).slice(2, -4); // raw deflate
    let binary = '';
    for (const byte of deflated) binary += String.fromCharCode(byte);
    const packed = `<mxfile><diagram name="Packed">${btoa(binary)}</diagram></mxfile>`;
    const page = importDrawio(packed).pages[0];
    expect(page.name).toBe('Packed');
    expect(page.shapes.length).toBeGreaterThanOrEqual(named.length);
  });
});

describe('transcripts', () => {
  it('reads WebVTT with voice tags and merges speaker turns', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE made by a meeting tool',
      '',
      '1',
      '00:00:01.000 --> 00:00:04.000',
      '<v Ana Souza>First we receive the</v>',
      '',
      '2',
      '00:00:04.000 --> 00:00:07.500',
      '<v Ana Souza>purchase request by e-mail.</v>',
      '',
      '00:01:10.000 --> 00:01:12.000',
      '<v Bruno>And who approves it?</v>',
    ].join('\n');
    expect(parseVtt(vtt)).toBe(
      '[00:01] Ana Souza: First we receive the purchase request by e-mail.\n[01:10] Bruno: And who approves it?',
    );
  });

  it('reads SubRip with inline speaker names', () => {
    const srt = '1\n00:00:02,000 --> 00:00:05,000\nCarla: We check the <i>invoice</i>.\n\n2\n01:02:03,000 --> 01:02:05,000\nThen we pay it.';
    expect(parseSrt(srt)).toBe('[00:02] Carla: We check the invoice.\n[1:02:03] Then we pay it.');
  });

  it('reads Whisper, AssemblyAI and Deepgram JSON', () => {
    expect(parseTranscriptJson(JSON.stringify({ text: 'x', segments: [{ start: 3.2, text: ' Hello there.' }, { start: 5, text: ' Bye.' }] }))).toBe(
      '[00:03] Hello there. Bye.',
    );
    expect(parseTranscriptJson(JSON.stringify({ utterances: [{ speaker: 'A', start: 61000, text: 'Hi.' }, { speaker: 'B', start: 62000, text: 'Hello.' }] }))).toBe(
      '[01:01] Speaker A: Hi.\n[01:02] Speaker B: Hello.',
    );
    expect(
      parseTranscriptJson(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'Plain words.' }] }] } })),
    ).toBe('Plain words.');
    expect(parseTranscriptJson('{"unrelated": true}')).toBeNull();
    expect(parseTranscriptJson('not json')).toBeNull();
  });

  it('reads Word documents including tables', () => {
    const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const xml =
      `<w:document ${w}><w:body>` +
      '<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:t>Meeting </w:t></w:r><w:r><w:t>notes</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Step</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    expect(parseDocx(zipSync({ 'word/document.xml': strToU8(xml) }))).toBe('Meeting notes\nStep | Owner\nLine one\nLine two');
  });
});

describe('ingest', () => {
  it('classifies files by content', async () => {
    const bpmn = await ingest('map.xml', strToU8(exportBpmn(model, layout)));
    expect(bpmn).toMatchObject({ kind: 'diagram', format: 'BPMN 2.0' });
    const drawio = await ingest('map.xml', strToU8(exportDrawio(model, layout, theme)));
    expect(drawio).toMatchObject({ kind: 'diagram', format: 'draw.io' });
    const visio = await ingest('map.vsdx', exportVsdx(model, layout, { theme }));
    expect(visio.kind).toBe('diagram');
    expect(JSON.parse(visio.text).pages[0].shapes.length).toBeGreaterThan(10);
    const text = await ingest('notes.txt', strToU8('﻿First the clerk opens the ticket.\r\n\r\n\r\n\r\nThen it is assigned.'));
    expect(text).toMatchObject({ kind: 'transcript', text: 'First the clerk opens the ticket.\n\nThen it is assigned.' });
  });

  it('decodes UTF-16 text', async () => {
    const bytes = new Uint8Array([0xff, 0xfe, ...[...'Olá'].flatMap((ch) => [ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8])]);
    expect((await ingest('a.txt', bytes)).text).toBe('Olá');
  });

  it('explains unsupported files', async () => {
    await expect(ingest('old.vsd', new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ reason: 'legacyVisio' });
    await expect(ingest('call.mp3', new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ reason: 'audio' });
    await expect(ingest('blob.bin', new Uint8Array(200))).rejects.toBeInstanceOf(UnsupportedFileError);
    await expect(ingest('empty.txt', strToU8('   '))).rejects.toMatchObject({ reason: 'empty' });
  });
});
