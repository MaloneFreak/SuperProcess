import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { BpmnModdle } from 'bpmn-moddle';
import { normalizeModel } from '../src/core/model/normalize';
import { layoutProcess } from '../src/core/layout/layout';
import { exportBpmn } from '../src/core/export/bpmn';
import { exportDrawio } from '../src/core/export/drawio';
import { exportVsdx } from '../src/core/export/vsdx';
import { getTheme } from '../src/core/render/theme';
import { allSymbolsRaw, linearRaw, purchaseRaw, tangledRaw } from './fixtures/models';

const OUT = process.env.SP_RENDER_DIR;
const cases: [string, unknown][] = [
  ['purchase', purchaseRaw],
  ['linear', linearRaw],
  ['tangled', tangledRaw],
  ['all symbols', allSymbolsRaw],
];

function wellFormed(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror').length, xml.slice(0, 200)).toBe(0);
  return doc;
}

describe('BPMN 2.0 export', () => {
  for (const [name, raw] of cases) {
    it(`writes a valid, fully resolved file for "${name}"`, async () => {
      const { model } = normalizeModel(raw);
      const layout = layoutProcess(model);
      const xml = exportBpmn(model, layout);
      wellFormed(xml);

      const moddle = new BpmnModdle();
      const { rootElement, warnings, references } = await moddle.fromXML(xml);
      expect(warnings, JSON.stringify(warnings.map((w: { message: string }) => w.message))).toHaveLength(0);
      expect(references.length).toBeGreaterThan(0);

      const process = rootElement.rootElements.find((e: { $type: string }) => e.$type === 'bpmn:Process');
      expect(process.flowElements).toHaveLength(model.nodes.length + model.flows.length);
      const plane = rootElement.diagrams[0].plane;
      // Pool + lanes + externals + nodes + sequence flows + message flows.
      expect(plane.planeElement).toHaveLength(
        1 + model.lanes.length + model.externals.length + model.nodes.length + model.flows.length + model.messageFlows.length,
      );
      for (const element of plane.planeElement) expect(element.bpmnElement, element.id).toBeDefined();

      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        writeFileSync(`${OUT}/${name}.bpmn`, xml);
      }
    });
  }
});

describe('Visio export', () => {
  for (const [name, raw] of cases) {
    it(`writes a well-formed package for "${name}"`, () => {
      const { model } = normalizeModel(raw);
      const layout = layoutProcess(model);
      const bytes = exportVsdx(model, layout, { theme: getTheme('color'), createdAt: '2026-01-01T00:00:00Z' });
      const files = unzipSync(bytes);
      const names = Object.keys(files);
      expect(names[0]).toBe('[Content_Types].xml');
      for (const required of [
        '_rels/.rels',
        'visio/document.xml',
        'visio/_rels/document.xml.rels',
        'visio/pages/pages.xml',
        'visio/pages/_rels/pages.xml.rels',
        'visio/pages/page1.xml',
      ]) {
        expect(names).toContain(required);
      }
      for (const file of names) wellFormed(strFromU8(files[file]));

      const page = wellFormed(strFromU8(files['visio/pages/page1.xml']));
      const shapes = [...page.getElementsByTagName('Shape')];
      const ids = shapes.map((s) => s.getAttribute('ID'));
      expect(new Set(ids).size, 'shape ids are unique').toBe(ids.length);

      // Every connector end is glued to an existing shape.
      const connects = [...page.getElementsByTagName('Connect')];
      expect(connects).toHaveLength((model.flows.length + model.messageFlows.length) * 2);
      for (const connect of connects) {
        expect(ids).toContain(connect.getAttribute('FromSheet'));
        expect(ids).toContain(connect.getAttribute('ToSheet'));
      }
      // Every step carries its text.
      const texts = [...page.getElementsByTagName('Text')].map((t) => t.textContent);
      for (const node of model.nodes) if (node.name) expect(texts).toContain(node.name);

      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        writeFileSync(`${OUT}/${name}.vsdx`, bytes);
      }
    });
  }

  it('is deterministic for a fixed timestamp', () => {
    const { model } = normalizeModel(purchaseRaw);
    const layout = layoutProcess(model);
    const options = { theme: getTheme('classic'), createdAt: '2026-01-01T00:00:00Z' };
    const a = unzipSync(exportVsdx(model, layout, options));
    const b = unzipSync(exportVsdx(model, layout, options));
    expect(strFromU8(a['visio/pages/page1.xml'])).toBe(strFromU8(b['visio/pages/page1.xml']));
  });
});

/** What draw.io's BPMN shapes accept, taken from its shape definitions (mxBpmnShape2.js). */
const DRAWIO = {
  shapes: ['mxgraph.bpmn.task', 'mxgraph.bpmn.event', 'mxgraph.bpmn.gateway2'],
  outline: ['standard', 'eventInt', 'eventNonint', 'catching', 'boundInt', 'boundNonint', 'throwing', 'end', 'none'],
  // "terminate2" and "none" draw nothing: draw.io's own palette uses them for the plain end event and for gateways.
  symbol: [
    'general', 'message', 'timer', 'escalation', 'conditional', 'link', 'error', 'cancel', 'compensation', 'signal',
    'multiple', 'parallelMultiple', 'terminate', 'terminate2', 'none',
  ],
  taskMarker: ['abstract', 'service', 'send', 'receive', 'user', 'manual', 'businessRule', 'script'],
  bpmnShapeType: ['task', 'transaction', 'call', 'subprocess'],
  gwType: ['event', 'exclusive', 'parallel', 'complex'],
};

function styleOf(cell: Element): Record<string, string> {
  const style: Record<string, string> = {};
  for (const part of (cell.getAttribute('style') ?? '').split(';')) {
    if (!part) continue;
    const at = part.indexOf('=');
    if (at < 0) style[part] = '';
    else style[part.slice(0, at)] = part.slice(at + 1);
  }
  return style;
}

describe('draw.io export', () => {
  for (const [name, raw] of cases) {
    it(`writes an editable diagram for "${name}"`, () => {
      const { model } = normalizeModel(raw);
      const layout = layoutProcess(model);
      const doc = wellFormed(exportDrawio(model, layout, getTheme('color')));
      expect(doc.documentElement.localName).toBe('mxfile');

      const cells = [...doc.getElementsByTagName('mxCell')];
      const idOf = (cell: Element): string =>
        (cell.parentElement?.localName === 'object' ? cell.parentElement.getAttribute('id') : cell.getAttribute('id')) ?? '';
      const byId = new Map(cells.map((cell) => [idOf(cell), cell]));
      expect(byId.size, 'cell ids are unique').toBe(cells.length);
      expect(byId.has('0') && byId.get('1')?.getAttribute('parent') === '0', 'root and default layer').toBe(true);

      // Steps sit inside their lane and lanes inside the pool, so moving a lane moves its steps.
      for (const lane of model.lanes) expect(byId.get(lane.id)?.getAttribute('parent')).toBe('sp_pool');
      for (const node of model.nodes) {
        const cell = byId.get(node.id);
        expect(cell, node.id).toBeDefined();
        expect(cell?.getAttribute('vertex')).toBe('1');
        expect(cell?.getAttribute('parent')).toBe(node.lane);
        const geometry = cell?.getElementsByTagName('mxGeometry')[0];
        const lane = layout.lanes.find((item) => item.id === node.lane);
        const box = layout.nodes[node.id];
        expect(Number(geometry?.getAttribute('x'))).toBeCloseTo(box.x - (lane?.x ?? 0), 1);
        expect(Number(geometry?.getAttribute('y'))).toBeCloseTo(box.y - (lane?.y ?? 0), 1);
        // The label is HTML: line breaks chosen by the layout, text escaped.
        const label = (cell?.parentElement?.getAttribute('label') ?? '')
          .replace(/<br>/g, ' ')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&');
        expect(label).toBe(node.name);

        // Only shapes and options that draw.io knows.
        const style = styleOf(cell as Element);
        expect(DRAWIO.shapes, `${node.id}: ${style.shape}`).toContain(style.shape);
        for (const key of ['outline', 'symbol', 'taskMarker', 'bpmnShapeType', 'gwType'] as const) {
          if (style[key] !== undefined) expect(DRAWIO[key], `${node.id}: ${key}=${style[key]}`).toContain(style[key]);
        }
      }

      // Every flow is attached at both ends to a shape that exists.
      const edges = cells.filter((cell) => cell.getAttribute('edge') === '1');
      expect(edges).toHaveLength(model.flows.length + model.messageFlows.length);
      for (const edge of edges) {
        for (const end of ['source', 'target']) {
          const target = byId.get(edge.getAttribute(end) ?? '');
          expect(target?.getAttribute('vertex'), `${idOf(edge)} ${end}`).toBe('1');
        }
      }
      // Flow labels travel with their flow.
      const labelled = [...model.flows, ...model.messageFlows].filter((flow) => flow.label).length;
      expect(cells.filter((cell) => (cell.getAttribute('style') ?? '').startsWith('edgeLabel;'))).toHaveLength(labelled);

      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        writeFileSync(`${OUT}/${name.replace(/\s+/g, '-')}.drawio`, exportDrawio(model, layout, getTheme('color')));
      }
    });
  }

  it('marks each kind of step the way draw.io draws it', () => {
    const { model } = normalizeModel(allSymbolsRaw);
    const doc = wellFormed(exportDrawio(model, layoutProcess(model), getTheme('color')));
    const style = (id: string): Record<string, string> => {
      const object = [...doc.getElementsByTagName('object')].find((item) => item.getAttribute('id') === id);
      return styleOf(object?.getElementsByTagName('mxCell')[0] as Element);
    };
    expect(style('t2')).toMatchObject({ shape: 'mxgraph.bpmn.task', taskMarker: 'user' });
    expect(style('t1')).toMatchObject({ taskMarker: 'abstract' });
    expect(style('t9')).toMatchObject({ isLoopSub: '1' });
    expect(style('t10')).toMatchObject({ bpmnShapeType: 'call' });
    expect(style('t11')).toMatchObject({ isLoopStandard: '1' });
    expect(style('t12')).toMatchObject({ isLoopMultiSeq: '1' });
    expect(style('t13')).toMatchObject({ isLoopMultiParallel: '1' });
    expect(style('x')).toMatchObject({ shape: 'mxgraph.bpmn.gateway2', gwType: 'exclusive' });
    expect(style('p')).toMatchObject({ gwType: 'parallel' });
    expect(style('i')).toMatchObject({ outline: 'end', symbol: 'general' });
    expect(style('eb')).toMatchObject({ outline: 'catching', symbol: 'multiple' });
    expect(style('s')).toMatchObject({ shape: 'mxgraph.bpmn.event', outline: 'standard', symbol: 'timer' });
    expect(style('c2')).toMatchObject({ outline: 'catching', symbol: 'message' });
    expect(style('h3')).toMatchObject({ outline: 'throwing', symbol: 'escalation' });
    expect(style('b1')).toMatchObject({ outline: 'boundInt', symbol: 'timer' });
    expect(style('b3')).toMatchObject({ outline: 'boundNonint', symbol: 'message' });
    expect(style('e0')).toMatchObject({ outline: 'end', symbol: 'terminate2' });
    expect(style('e4')).toMatchObject({ outline: 'end', symbol: 'terminate' });
    expect(style('e2')).toMatchObject({ outline: 'end', symbol: 'error' });
  });
});
