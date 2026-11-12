import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { normalizeModel } from '../src/core/model/normalize';
import { layoutProcess, type Box, type DiagramLayout, type Point, type TextBlock } from '../src/core/layout/layout';
import { METRICS } from '../src/core/layout/layout';
import { measureText } from '../src/core/layout/text';
import { renderSvg } from '../src/core/render/svg';
import { getTheme } from '../src/core/render/theme';
import type { ProcessModel } from '../src/core/model/types';
import { allSymbolsRaw, linearRaw, purchaseRaw, tangledRaw } from './fixtures/models';

const OUT = process.env.SP_RENDER_DIR;

function segments(points: Point[]): [Point, Point][] {
  const out: [Point, Point][] = [];
  for (let i = 0; i < points.length - 1; i++) out.push([points[i], points[i + 1]]);
  return out;
}

/** True when the segment passes through the inside of the box (touching the border is fine). */
function crosses([a, b]: [Point, Point], box: Box): boolean {
  const pad = 1;
  const left = box.x + pad;
  const right = box.x + box.width - pad;
  const top = box.y + pad;
  const bottom = box.y + box.height - pad;
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return maxX > left && minX < right && maxY > top && minY < bottom;
}

function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function textBox(text: TextBlock): Box {
  const x = text.anchor === 'start' ? text.x : text.anchor === 'end' ? text.x - text.width : text.x - text.width / 2;
  return { x, y: text.y, width: text.width, height: text.height };
}

/** Where the name of a collapsed pool is drawn. */
function nameBox(band: DiagramLayout['externals'][number]): Box {
  const width = Math.max(...band.labelLines.map((line) => measureText(line, METRICS.bandFont, true)));
  const height = band.labelLines.length * METRICS.bandLine;
  return {
    x: band.x + band.width / 2 + (band.labelOffset ?? 0) - width / 2,
    y: band.y + (band.height - height) / 2,
    width,
    height,
  };
}

/** Counts what a crowded drawing cannot always avoid, instead of failing on it. */
interface Tally {
  names: number;
  struckNames: number;
  labels: number;
  crowdedLabels: number;
}

/**
 * External pools and message flows: tidy, attached and legible.
 *
 * With a tally, a pool name struck through by a flow and a label that overlaps
 * another flow or label are counted rather than asserted: when one step
 * exchanges messages with three or four partners there is no room to avoid
 * them all.
 */
function checkCollaboration(layout: DiagramLayout, options: { allowCrossing?: boolean; tally?: Tally } = {}): void {
  const { tally } = options;
  const bands = layout.externals;
  const messages = layout.edges.filter((edge) => edge.kind === 'message');

  for (const band of bands) {
    expect(band.x, `${band.id} starts on the canvas`).toBeGreaterThanOrEqual(0);
    expect(band.y, `${band.id} starts on the canvas`).toBeGreaterThanOrEqual(0);
    expect(band.x + band.width).toBeLessThanOrEqual(layout.width);
    expect(band.y + band.height).toBeLessThanOrEqual(layout.height);
    expect(overlap(band, layout.pool), `${band.id} overlaps the pool`).toBe(false);
    for (const other of bands) {
      if (other !== band) expect(overlap(band, other), `${band.id} overlaps ${other.id}`).toBe(false);
    }
    // The name fits inside its pool.
    const name = nameBox(band);
    expect(name.x, `${band.id}: name fits`).toBeGreaterThanOrEqual(band.x + 2);
    expect(name.x + name.width, `${band.id}: name fits`).toBeLessThanOrEqual(band.x + band.width - 2);
    expect(name.height).toBeLessThanOrEqual(band.height - 6);
  }

  for (const edge of messages) {
    const band = bands.find((item) => item.id === edge.from || item.id === edge.to);
    expect(band, `${edge.id} has a pool`).toBeDefined();
    if (!band) continue;
    // The flow ends on the edge of its own pool, away from the corners.
    const end = edge.from === band.id ? edge.points[0] : edge.points[edge.points.length - 1];
    expect([band.y, band.y + band.height], `${edge.id} touches ${band.id}`).toContain(end.y);
    expect(end.x).toBeGreaterThanOrEqual(band.x + 10);
    expect(end.x).toBeLessThanOrEqual(band.x + band.width - 10);

    for (const other of bands) {
      if (other === band) continue;
      const through = segments(edge.points).some((segment) => crosses(segment, other));
      if (!options.allowCrossing) expect(through, `${edge.id} runs through ${other.id}`).toBe(false);
    }

    if (edge.label) {
      const label = textBox(edge.label);
      expect(label.x, `${edge.id}: label on the canvas`).toBeGreaterThanOrEqual(0);
      expect(label.x + label.width, `${edge.id}: label on the canvas`).toBeLessThanOrEqual(layout.width);
      for (const band of bands) expect(overlap(label, band), `${edge.id}: label over ${band.id}`).toBe(false);
      expect(overlap(label, layout.pool), `${edge.id}: label over the pool`).toBe(false);
      const clashes = messages.filter(
        (other) =>
          other !== edge &&
          (segments(other.points).some((segment) => crosses(segment, label)) ||
            (other.label !== null && overlap(label, textBox(other.label)))),
      );
      if (tally) {
        tally.labels++;
        if (clashes.length > 0) tally.crowdedLabels++;
      } else {
        expect(clashes.map((other) => other.id), `flows that clash with the label of ${edge.id}`).toEqual([]);
      }
    }
  }

  // Even where a flow has to cross a pool, the name of the pool stays readable.
  for (const band of bands) {
    const name = nameBox(band);
    const padded = { x: name.x - 3, y: name.y, width: name.width + 6, height: name.height };
    const strikes = messages.filter(
      (edge) => edge.from !== band.id && edge.to !== band.id && segments(edge.points).some((segment) => crosses(segment, padded)),
    );
    if (tally) {
      tally.names++;
      if (strikes.length > 0) tally.struckNames++;
    } else {
      expect(strikes.map((edge) => edge.id), `flows that strike through the name of ${band.id}`).toEqual([]);
    }
  }
}

function check(model: ProcessModel, layout: DiagramLayout): void {
  const boundary = new Set(model.nodes.filter((n) => n.type === 'boundaryEvent').map((n) => n.id));
  const boxes = model.nodes.map((n) => layout.nodes[n.id]);
  for (const box of boxes) expect(box, 'every node is positioned').toBeDefined();

  // Shapes never overlap (boundary events sit on their host by design).
  const solid = boxes.filter((b) => !boundary.has(b.id));
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      expect(overlap(solid[i], solid[j]), `${solid[i].id} overlaps ${solid[j].id}`).toBe(false);
    }
  }

  for (const edge of layout.edges) {
    expect(edge.points.length, `${edge.id} has a route`).toBeGreaterThanOrEqual(2);
    for (const [a, b] of segments(edge.points)) {
      expect(a.x === b.x || a.y === b.y, `${edge.id} is orthogonal`).toBe(true);
    }
    // A flow never runs through a shape, its own end points included.
    for (const box of solid) {
      for (const segment of segments(edge.points)) {
        expect(crosses(segment, box), `${edge.id} crosses ${box.id}`).toBe(false);
      }
    }
  }

  // Everything stays on the canvas.
  for (const box of boxes) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
    expect(box.y + box.height).toBeLessThanOrEqual(layout.height);
  }
}

describe('layout', () => {
  const cases: [string, unknown][] = [
    ['purchase', purchaseRaw],
    ['linear', linearRaw],
    ['tangled', tangledRaw],
    ['all-symbols', allSymbolsRaw],
  ];

  for (const [name, raw] of cases) {
    it(`lays out "${name}" without overlaps or crossings through shapes`, () => {
      const { model } = normalizeModel(raw);
      const layout = layoutProcess(model);
      check(model, layout);
      checkCollaboration(layout);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        for (const dark of [false, true]) {
          const svg = renderSvg(model, layout, { theme: getTheme('color', dark) });
          writeFileSync(`${OUT}/${name}${dark ? '-dark' : ''}.svg`, svg);
        }
      }
    });
  }

  it('handles an empty model', () => {
    const { model } = normalizeModel({});
    const layout = layoutProcess(model);
    expect(layout.edges).toHaveLength(0);
    expect(layout.width).toBeGreaterThan(0);
  });
});

/** A straight line of tasks with the given message flows. */
function chain(length: number, externals: string[], messageFlows: { from: string; to: string; label?: string }[]): unknown {
  const tasks = Array.from({ length }, (_, i) => ({ id: `t${i + 1}`, type: 'userTask', name: `Step ${i + 1}`, lane: 'a' }));
  const ids = ['s', ...tasks.map((task) => task.id), 'e'];
  return {
    name: 'Chain',
    language: 'en',
    pool: 'Company',
    lanes: [{ id: 'a', name: 'Team' }],
    nodes: [{ id: 's', type: 'startEvent', name: 'Start', lane: 'a' }, ...tasks, { id: 'e', type: 'endEvent', name: 'End', lane: 'a' }],
    flows: ids.slice(0, -1).map((id, i) => ({ from: id, to: ids[i + 1] })),
    externals,
    messageFlows,
  };
}

describe('external pools', () => {
  const layoutOf = (raw: unknown): { model: ProcessModel; layout: DiagramLayout } => {
    const { model } = normalizeModel(raw);
    const layout = layoutProcess(model);
    check(model, layout);
    return { model, layout };
  };
  const band = (layout: DiagramLayout, name: string): DiagramLayout['externals'][number] =>
    layout.externals.find((item) => item.name === name)!;

  it('span only the stretch they exchange messages with', () => {
    const { layout } = layoutOf(
      chain(8, ['Customer'], [
        { from: 'Customer', to: 't2', label: 'Order' },
        { from: 't3', to: 'Customer', label: 'Confirmation' },
      ]),
    );
    checkCollaboration(layout);
    const customer = band(layout, 'Customer');
    expect(customer.width).toBeLessThan(layout.pool.width / 2);
    // It sits over the two steps it talks to.
    const centre = customer.x + customer.width / 2;
    expect(centre).toBeGreaterThan(layout.nodes.t2.x);
    expect(centre).toBeLessThan(layout.nodes.t3.x + layout.nodes.t3.width);
  });

  it('share a row when they do not overlap', () => {
    const { layout } = layoutOf(
      chain(8, ['Customer', 'Bank'], [
        { from: 'Customer', to: 't1', label: 'Order' },
        { from: 't7', to: 'Bank', label: 'Payment order' },
      ]),
    );
    checkCollaboration(layout);
    expect(band(layout, 'Customer').y).toBe(band(layout, 'Bank').y);
  });

  it('stack when they overlap, the narrow one next to the process', () => {
    const { layout } = layoutOf(
      chain(8, ['Customer', 'Bank'], [
        { from: 'Customer', to: 't1', label: 'Order' },
        { from: 't8', to: 'Customer', label: 'Invoice' },
        { from: 't4', to: 'Bank', label: 'Payment order' },
      ]),
    );
    checkCollaboration(layout);
    const customer = band(layout, 'Customer');
    const bank = band(layout, 'Bank');
    expect(bank.y).toBeGreaterThan(customer.y);
    expect(bank.y + bank.height).toBeLessThan(layout.pool.y);
    expect(customer.y).toBeGreaterThanOrEqual(METRICS.margin);
  });

  it('take opposite sides when their message flows alternate', () => {
    // Customer and Supplier take turns along the process: on one side, a flow
    // of one would have to cross the pool of the other.
    const { layout } = layoutOf(
      chain(8, ['Customer', 'Supplier'], [
        { from: 'Customer', to: 't1', label: 'Order' },
        { from: 't5', to: 'Customer', label: 'Delivery note' },
        { from: 't3', to: 'Supplier', label: 'Purchase order' },
        { from: 'Supplier', to: 't7', label: 'Parts' },
      ]),
    );
    checkCollaboration(layout);
    // The pool listed first keeps the usual place above the process.
    expect(band(layout, 'Customer').y).toBeLessThan(layout.pool.y);
    expect(band(layout, 'Supplier').y).toBeGreaterThan(layout.pool.y + layout.pool.height);
  });

  it('keep their name clear of a flow that has to cross them', () => {
    // Three partners that all alternate: two of them must share a side.
    const { layout } = layoutOf(
      chain(8, ['Customer', 'Supplier', 'Carrier'], [
        { from: 'Customer', to: 't1' },
        { from: 't5', to: 'Customer' },
        { from: 't3', to: 'Supplier' },
        { from: 'Supplier', to: 't7' },
        { from: 't2', to: 'Carrier' },
        { from: 'Carrier', to: 't6' },
      ]),
    );
    checkCollaboration(layout, { allowCrossing: true });
    const crossed = layout.externals.filter((item) =>
      layout.edges.some(
        (edge) =>
          edge.kind === 'message' &&
          edge.from !== item.id &&
          edge.to !== item.id &&
          segments(edge.points).some((segment) => crosses(segment, item)),
      ),
    );
    expect(crossed).toHaveLength(1);
    expect(crossed[0].labelOffset ?? 0).not.toBe(0);
  });

  it('put a label on the free side of its flow', () => {
    // One step sends and receives: the two lines are close together.
    const { layout } = layoutOf(
      chain(4, ['Customer'], [
        { from: 't2', to: 'Customer', label: 'Clarifying questions' },
        { from: 'Customer', to: 't2', label: 'Answers and documents' },
      ]),
    );
    checkCollaboration(layout);
    const [question, answer] = layout.edges.filter((edge) => edge.kind === 'message');
    expect(question.label?.anchor).toBe('end');
    expect(answer.label?.anchor).toBe('start');
  });

  it('keep a label at the right edge on the drawing', () => {
    const { layout } = layoutOf(
      chain(3, ['Customer'], [{ from: 'e', to: 'Customer', label: 'Final confirmation of the order' }]),
    );
    checkCollaboration(layout);
  });
});

/** Small deterministic random generator, so a failure can be reproduced from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random process with branches, several lanes and external partners. */
function randomCollaboration(seed: number): unknown {
  const random = mulberry32(seed);
  const int = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];

  const lanes = Array.from({ length: int(1, 4) }, (_, i) => ({ id: `l${i}`, name: `Lane ${i + 1}` }));
  const lane = (): string => pick(lanes).id;
  const nodes: Record<string, unknown>[] = [{ id: 's', type: 'startEvent', name: 'Start', lane: lane() }];
  const flows: { from: string; to: string; label?: string }[] = [];
  const steps: string[] = ['s'];
  let last = 's';
  let counter = 0;
  const task = (): string => {
    const id = `t${++counter}`;
    nodes.push({ id, type: pick(['userTask', 'serviceTask', 'sendTask', 'receiveTask', 'task']), name: `Step ${counter}`, lane: lane() });
    steps.push(id);
    return id;
  };
  for (let block = int(3, 8); block > 0; block--) {
    if (random() < 0.3) {
      const split = `g${++counter}`;
      const join = `g${++counter}`;
      nodes.push({ id: split, type: 'exclusiveGateway', name: 'Which way?', lane: lane() });
      nodes.push({ id: join, type: 'exclusiveGateway', name: '', lane: lane() });
      flows.push({ from: last, to: split });
      for (const label of ['Yes', 'No']) {
        let at = split;
        for (let i = int(1, 2); i > 0; i--) {
          const id = task();
          flows.push({ from: at, to: id, ...(at === split ? { label } : {}) });
          at = id;
        }
        flows.push({ from: at, to: join });
      }
      last = join;
    } else {
      const id = task();
      flows.push({ from: last, to: id });
      last = id;
    }
  }
  nodes.push({ id: 'e', type: 'endEvent', name: 'End', lane: lane() });
  steps.push('e');
  flows.push({ from: last, to: 'e' });

  const names = ['Customer', 'Bank', 'Supplier of spare parts and maintenance services', 'Tax office', 'Carrier'];
  const externals = names.slice(0, int(1, 4));
  const messageFlows: { from: string; to: string; label?: string }[] = [];
  for (const external of externals) {
    for (let i = int(1, 3); i > 0; i--) {
      const step = pick(steps);
      const label = random() < 0.7 ? pick(['Order', 'Payment order', 'Request for a corrected invoice', 'Confirmation']) : undefined;
      messageFlows.push(random() < 0.5 ? { from: external, to: step, label } : { from: step, to: external, label });
    }
  }
  return { name: `Random ${seed}`, language: 'en', pool: 'Company', lanes, nodes, flows, externals, messageFlows };
}

describe('random collaborations', () => {
  it('stay tidy whatever the partners and message flows', () => {
    const failures: string[] = [];
    const tally: Tally = { names: 0, struckNames: 0, labels: 0, crowdedLabels: 0 };
    const seeds = Number(process.env.SP_FUZZ_SEEDS ?? 300);
    for (let seed = 1; seed <= seeds; seed++) {
      const { model } = normalizeModel(randomCollaboration(seed));
      const layout = layoutProcess(model);
      try {
        check(model, layout);
        checkCollaboration(layout, { allowCrossing: true, tally });
      } catch (error) {
        failures.push(`seed ${seed}: ${(error as Error).message.split('\n')[0]}`);
      }
    }
    expect(failures).toEqual([]);
    // These processes are far more crowded than real ones: up to four partners,
    // each with up to three message flows, on a dozen steps. Even so, almost
    // every name and label finds a clear spot.
    if (process.env.SP_FUZZ_SEEDS) console.info(JSON.stringify(tally));
    expect(tally.struckNames / tally.names).toBeLessThan(0.01);
    expect(tally.crowdedLabels / tally.labels).toBeLessThan(0.03);
  }, 120_000);
});
