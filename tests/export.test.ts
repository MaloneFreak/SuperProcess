import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { BpmnModdle } from 'bpmn-moddle';
import { normalizeModel } from '../src/core/model/normalize';
import { layoutProcess } from '../src/core/layout/layout';
import { exportBpmn } from '../src/core/export/bpmn';
import { exportVsdx } from '../src/core/export/vsdx';
import { getTheme } from '../src/core/render/theme';
import { linearRaw, purchaseRaw, tangledRaw } from './fixtures/models';

const OUT = process.env.SP_RENDER_DIR;
const cases: [string, unknown][] = [
  ['purchase', purchaseRaw],
  ['linear', linearRaw],
  ['tangled', tangledRaw],
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
