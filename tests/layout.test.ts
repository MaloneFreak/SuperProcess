import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { normalizeModel } from '../src/core/model/normalize';
import { layoutProcess, type Box, type DiagramLayout, type Point } from '../src/core/layout/layout';
import { renderSvg } from '../src/core/render/svg';
import { getTheme } from '../src/core/render/theme';
import type { ProcessModel } from '../src/core/model/types';
import { linearRaw, purchaseRaw, tangledRaw } from './fixtures/models';

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
  ];

  for (const [name, raw] of cases) {
    it(`lays out "${name}" without overlaps or crossings through shapes`, () => {
      const { model } = normalizeModel(raw);
      const layout = layoutProcess(model);
      check(model, layout);
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
