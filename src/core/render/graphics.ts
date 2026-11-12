/**
 * BPMN symbol geometry.
 *
 * Every symbol is described once, as a few primitives (polygons, ellipses,
 * rounded rectangles) in the local coordinates of its node box. The SVG
 * renderer and the Visio writer both draw from this description, so a task
 * icon or a gateway marker looks the same in the app, in a PNG and in Visio.
 * Curves are approximated with polylines to keep the primitives portable.
 */
import { isEvent, isGateway, type EventKind, type ProcessNode } from '../model/types';

/** `shape` = themed fill of the node, `ink` = stroke colour, `paper` = background. */
export type FillRole = 'shape' | 'ink' | 'paper' | 'none';

interface PrimBase {
  fill: FillRole;
  /** Stroke width in px; 0 draws no outline. */
  sw: number;
  dashed?: boolean;
  /** Draw the outline in the background colour (details on top of a filled symbol). */
  paperStroke?: boolean;
}

export interface PolyPrim extends PrimBase {
  k: 'poly';
  pts: [number, number][];
  closed: boolean;
}

export interface EllipsePrim extends PrimBase {
  k: 'ellipse';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface RoundRectPrim extends PrimBase {
  k: 'rrect';
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

export type Prim = PolyPrim | EllipsePrim | RoundRectPrim;

export interface NodeGraphics {
  /** The main outline; carries the node's fill. */
  outline: Prim;
  /** Inner rings, icons and markers drawn on top of the outline. */
  decor: Prim[];
}

export type NodeRole = 'task' | 'start' | 'end' | 'intermediate' | 'gateway';

export function nodeRole(node: ProcessNode): NodeRole {
  if (node.type === 'startEvent') return 'start';
  if (node.type === 'endEvent') return 'end';
  if (isEvent(node.type)) return 'intermediate';
  if (isGateway(node.type)) return 'gateway';
  return 'task';
}

const poly = (pts: [number, number][], closed: boolean, fill: FillRole, sw = 1.2): PolyPrim => ({
  k: 'poly',
  pts,
  closed,
  fill,
  sw,
});
const ellipse = (cx: number, cy: number, rx: number, ry: number, fill: FillRole, sw = 1.2): EllipsePrim => ({
  k: 'ellipse',
  cx,
  cy,
  rx,
  ry,
  fill,
  sw,
});
const line = (x1: number, y1: number, x2: number, y2: number, sw = 1.2): PolyPrim =>
  poly(
    [
      [x1, y1],
      [x2, y2],
    ],
    false,
    'none',
    sw,
  );

function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

function arc(cx: number, cy: number, r: number, from: number, to: number, steps: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) pts.push(polar(cx, cy, r, from + ((to - from) * i) / steps));
  return pts;
}

/** Moves and scales primitives drawn in a design box to their final place. */
function place(prims: Prim[], dx: number, dy: number, scale = 1): Prim[] {
  return prims.map((p): Prim => {
    if (p.k === 'poly') {
      return { ...p, pts: p.pts.map(([x, y]) => [dx + x * scale, dy + y * scale]), sw: p.sw * Math.min(1, scale + 0.15) };
    }
    if (p.k === 'ellipse') {
      return { ...p, cx: dx + p.cx * scale, cy: dy + p.cy * scale, rx: p.rx * scale, ry: p.ry * scale };
    }
    return { ...p, x: dx + p.x * scale, y: dy + p.y * scale, w: p.w * scale, h: p.h * scale, r: p.r * scale };
  });
}

// ── Task type icons, drawn in a 16 × 16 box ────────────────────────────────

function gear(cx: number, cy: number, outer: number, inner: number, teeth: number): [number, number][] {
  const pts: [number, number][] = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    pts.push(
      polar(cx, cy, inner, a - step * 0.3),
      polar(cx, cy, outer, a - step * 0.17),
      polar(cx, cy, outer, a + step * 0.17),
      polar(cx, cy, inner, a + step * 0.3),
    );
  }
  return pts;
}

const envelope = (x: number, y: number, w: number, h: number, filled: boolean): Prim[] => [
  poly(
    [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
    true,
    filled ? 'ink' : 'paper',
    1.1,
  ),
  {
    ...poly(
      [
        [x, y],
        [x + w / 2, y + h * 0.56],
        [x + w, y],
      ],
      false,
      'none',
      1.1,
    ),
    paperStroke: filled,
  },
];

function taskIcon(type: ProcessNode['type']): Prim[] {
  switch (type) {
    case 'userTask':
      return [
        poly(
          [
            [1.6, 15],
            [1.9, 12.2],
            [3.4, 10.2],
            [5.8, 9.3],
            [10.2, 9.3],
            [12.6, 10.2],
            [14.1, 12.2],
            [14.4, 15],
          ],
          true,
          'paper',
          1.1,
        ),
        ellipse(8, 5, 3.3, 3.3, 'paper', 1.1),
      ];
    case 'manualTask':
      return [
        poly(
          [
            [1.4, 9.6],
            [5.4, 4.6],
            [6.6, 4.2],
            [7.2, 5.2],
            [5.9, 7.1],
            [13.4, 7.1],
            [14.2, 7.9],
            [13.4, 8.8],
            [14.4, 8.8],
            [15, 9.6],
            [14.4, 10.5],
            [13.9, 10.5],
            [14.5, 11.3],
            [13.9, 12.2],
            [13, 12.2],
            [13.5, 13],
            [12.9, 13.8],
            [5.2, 13.8],
            [3.4, 13.1],
            [1.4, 13.1],
          ],
          true,
          'paper',
          1,
        ),
        line(8.6, 8.8, 13.4, 8.8, 0.9),
        line(8.6, 10.5, 13.9, 10.5, 0.9),
        line(8.6, 12.2, 13, 12.2, 0.9),
      ];
    case 'serviceTask':
      return [poly(gear(8, 8, 7.4, 5.5, 8), true, 'paper', 1), ellipse(8, 8, 2.4, 2.4, 'paper', 1)];
    case 'scriptTask':
      return [
        poly(
          [
            [5.2, 1.6],
            [14, 1.6],
            [12.9, 3.2],
            [12.6, 5],
            [13.1, 6.8],
            [13.9, 8.6],
            [14.1, 10.6],
            [13.3, 12.6],
            [11.6, 14.4],
            [2.6, 14.4],
            [3.9, 12.6],
            [4.2, 10.8],
            [3.6, 9],
            [2.8, 7.2],
            [2.6, 5.2],
            [3.4, 3.2],
          ],
          true,
          'paper',
          1,
        ),
        line(5.6, 4.6, 10.6, 4.6, 0.9),
        line(5.2, 7.2, 11, 7.2, 0.9),
        line(6, 9.8, 11.6, 9.8, 0.9),
        line(5.6, 12.2, 10.4, 12.2, 0.9),
      ];
    case 'businessRuleTask':
      return [
        poly(
          [
            [1.5, 2.8],
            [14.5, 2.8],
            [14.5, 13.4],
            [1.5, 13.4],
          ],
          true,
          'paper',
          1,
        ),
        poly(
          [
            [1.5, 2.8],
            [14.5, 2.8],
            [14.5, 6],
            [1.5, 6],
          ],
          true,
          'ink',
          1,
        ),
        line(1.5, 9.7, 14.5, 9.7, 0.9),
        line(5.6, 6, 5.6, 13.4, 0.9),
      ];
    case 'sendTask':
      return envelope(1.5, 3.4, 13, 9.2, true);
    case 'receiveTask':
      return envelope(1.5, 3.4, 13, 9.2, false);
    default:
      return [];
  }
}

// ── Event symbols, drawn in a 20 × 20 box centred on (10, 10) ──────────────

function eventIcon(kind: EventKind, filled: boolean): Prim[] {
  const fill: FillRole = filled ? 'ink' : 'paper';
  switch (kind) {
    case 'message':
      return envelope(3.4, 5.6, 13.2, 8.8, filled);
    case 'timer': {
      const prims: Prim[] = [ellipse(10, 10, 7.4, 7.4, 'paper', 1.1)];
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        const [x1, y1] = polar(10, 10, 5.5, a);
        const [x2, y2] = polar(10, 10, 7.4, a);
        prims.push(line(x1, y1, x2, y2, 0.8));
      }
      prims.push(line(10, 10, 10, 5.2, 1.1), line(10, 10, 13.4, 11.2, 1.1));
      return prims;
    }
    case 'error':
      return [
        poly(
          [
            [3.6, 16.2],
            [7.4, 4.6],
            [11.8, 10.8],
            [16.4, 3.8],
            [12.6, 15.4],
            [8.2, 9.2],
          ],
          true,
          fill,
          1.1,
        ),
      ];
    case 'escalation':
      return [
        poly(
          [
            [10, 3.2],
            [15.2, 16.4],
            [10, 11.2],
            [4.8, 16.4],
          ],
          true,
          fill,
          1.1,
        ),
      ];
    case 'conditional':
      return [
        poly(
          [
            [4.6, 3.4],
            [15.4, 3.4],
            [15.4, 16.6],
            [4.6, 16.6],
          ],
          true,
          'paper',
          1.1,
        ),
        line(6.4, 6.2, 13.6, 6.2, 0.9),
        line(6.4, 8.8, 13.6, 8.8, 0.9),
        line(6.4, 11.4, 13.6, 11.4, 0.9),
        line(6.4, 14, 13.6, 14, 0.9),
      ];
    case 'signal':
      return [
        poly(
          [
            [10, 3.6],
            [16.8, 15.4],
            [3.2, 15.4],
          ],
          true,
          fill,
          1.1,
        ),
      ];
    case 'terminate':
      return [ellipse(10, 10, 6.6, 6.6, 'ink', 0)];
    default:
      return [];
  }
}

// ── Activity markers, drawn in a 12 × 12 box ───────────────────────────────

function loopMarker(): Prim[] {
  const pts = arc(6, 6, 4.5, Math.PI * 0.72, Math.PI * 2.32, 14);
  const [ex, ey] = pts[0];
  return [poly(pts, false, 'none', 1.2), poly([[ex - 0.4, ey - 3.4], [ex, ey], [ex - 3.3, ey + 0.5]], false, 'none', 1.2)];
}

function subProcessMarker(): Prim[] {
  return [
    poly(
      [
        [0.5, 0.5],
        [11.5, 0.5],
        [11.5, 11.5],
        [0.5, 11.5],
      ],
      true,
      'paper',
      1,
    ),
    line(6, 2.8, 6, 9.2, 1.2),
    line(2.8, 6, 9.2, 6, 1.2),
  ];
}

const barsVertical = (): Prim[] => [line(2, 1, 2, 11, 1.8), line(6, 1, 6, 11, 1.8), line(10, 1, 10, 11, 1.8)];
const barsHorizontal = (): Prim[] => [line(1, 2, 11, 2, 1.8), line(1, 6, 11, 6, 1.8), line(1, 10, 11, 10, 1.8)];

/** Geometry for one node, in the local coordinates of a `w` × `h` box. */
export function nodeGraphics(node: ProcessNode, w: number, h: number): NodeGraphics {
  const cx = w / 2;
  const cy = h / 2;

  if (isEvent(node.type)) {
    const r = Math.min(w, h) / 2;
    const isEnd = node.type === 'endEvent';
    const isStart = node.type === 'startEvent';
    const dashed = node.type === 'boundaryEvent' && !node.interrupting;
    const outline: EllipsePrim = { ...ellipse(cx, cy, r - (isEnd ? 1.2 : 0.6), r - (isEnd ? 1.2 : 0.6), 'shape', isEnd ? 3.4 : 1.4), dashed };
    const decor: Prim[] = [];
    if (!isStart && !isEnd) decor.push({ ...ellipse(cx, cy, r - 3.6, r - 3.6, 'none', 1.2), dashed });
    const filled = isEnd || node.type === 'intermediateThrowEvent';
    const scale = (r * 2) / 36;
    decor.push(...place(eventIcon(node.eventKind, filled), cx - 10 * scale, cy - 10 * scale, scale));
    return { outline, decor };
  }

  if (isGateway(node.type)) {
    const outline = poly(
      [
        [cx, 0.8],
        [w - 0.8, cy],
        [cx, h - 0.8],
        [0.8, cy],
      ],
      true,
      'shape',
      1.5,
    );
    const decor: Prim[] = [];
    const s = Math.min(w, h) / 50;
    if (node.type === 'exclusiveGateway') {
      decor.push(line(cx - 7.5 * s, cy - 7.5 * s, cx + 7.5 * s, cy + 7.5 * s, 3.2), line(cx + 7.5 * s, cy - 7.5 * s, cx - 7.5 * s, cy + 7.5 * s, 3.2));
    } else if (node.type === 'parallelGateway') {
      decor.push(line(cx, cy - 11 * s, cx, cy + 11 * s, 3.2), line(cx - 11 * s, cy, cx + 11 * s, cy, 3.2));
    } else if (node.type === 'inclusiveGateway') {
      decor.push(ellipse(cx, cy, 9.5 * s, 9.5 * s, 'none', 2.8));
    } else {
      const pentagon: [number, number][] = [];
      for (let i = 0; i < 5; i++) pentagon.push(polar(cx, cy + 0.4 * s, 5.4 * s, -Math.PI / 2 + (i * Math.PI * 2) / 5));
      decor.push(ellipse(cx, cy, 11.2 * s, 11.2 * s, 'none', 1), ellipse(cx, cy, 8.8 * s, 8.8 * s, 'none', 1), poly(pentagon, true, 'none', 1));
    }
    return { outline, decor };
  }

  // Activities.
  const outline: RoundRectPrim = {
    k: 'rrect',
    x: 0.75,
    y: 0.75,
    w: w - 1.5,
    h: h - 1.5,
    r: 10,
    fill: 'shape',
    sw: node.type === 'callActivity' ? 3.6 : 1.5,
  };
  const decor: Prim[] = [...place(taskIcon(node.type), 7, 7)];
  const markers: Prim[][] = [];
  if (node.loop === 'loop') markers.push(loopMarker());
  if (node.loop === 'parallel') markers.push(barsVertical());
  if (node.loop === 'sequential') markers.push(barsHorizontal());
  if (node.type === 'subProcess') markers.push(subProcessMarker());
  const total = markers.length * 12 + (markers.length - 1) * 4;
  markers.forEach((marker, i) => {
    decor.push(...place(marker, cx - total / 2 + i * 16, h - 16));
  });
  return { outline, decor };
}

