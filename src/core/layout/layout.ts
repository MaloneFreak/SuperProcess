/**
 * Automatic BPMN layout.
 *
 * Generic graph layouts do not understand swimlanes, so this is a purpose-built
 * engine. It works on a grid:
 *
 *   columns  = the rank of a node along the flow (longest path from the start),
 *   rows     = horizontal tracks inside a lane (a lane grows extra rows when
 *              branches or loops need them).
 *
 * Nodes occupy grid cells. Flows are routed orthogonally through cells that
 * are provably free, or through the vertical channels between columns, so a
 * line never runs through a shape. Gateway branches leave through the top and
 * bottom corners, the way a careful modeller draws them. Parallel line
 * segments in a channel are spread over separate tracks.
 *
 * The result is plain geometry (boxes, polylines, text blocks) that every
 * exporter consumes unchanged, which is what keeps the Visio, BPMN, draw.io
 * and image outputs identical.
 */
import { isActivity, isEvent, isGateway, type Flow, type ProcessModel, type ProcessNode } from '../model/types';
import { blockWidth, wrapText } from './text';

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Anchor = 'start' | 'middle' | 'end';

/** A block of pre-wrapped text. `x` is the anchor position, `y` the top of the block. */
export interface TextBlock {
  lines: string[];
  x: number;
  y: number;
  anchor: Anchor;
  fontSize: number;
  lineHeight: number;
  width: number;
  height: number;
}

export interface NodeLayout extends Box {
  id: string;
  label: TextBlock | null;
}

export interface EdgeLayout {
  id: string;
  kind: 'sequence' | 'message';
  from: string;
  to: string;
  points: Point[];
  label: TextBlock | null;
  isDefault: boolean;
}

/** A pool, lane or collapsed external pool. */
export interface BandLayout extends Box {
  id: string;
  name: string;
  /** Width of the rotated title strip on the left (0 for collapsed pools). */
  headerWidth: number;
  labelLines: string[];
}

export interface DiagramLayout {
  width: number;
  height: number;
  pool: BandLayout;
  lanes: BandLayout[];
  externals: BandLayout[];
  nodes: Record<string, NodeLayout>;
  edges: EdgeLayout[];
}

export const METRICS = {
  margin: 24,
  poolHeader: 30,
  laneHeader: 32,
  taskWidth: 120,
  taskHeight: 80,
  eventSize: 36,
  gatewaySize: 50,
  boundarySize: 30,
  channelMin: 56,
  edgeChannel: 34,
  trackGap: 12,
  rowMin: 116,
  passageRow: 40,
  externalHeight: 60,
  externalGap: 46,
  nodeFont: 12,
  nodeLine: 15,
  labelFont: 11,
  labelLine: 13,
  bandFont: 12,
  bandLine: 14,
} as const;

type Side = 'L' | 'R' | 'T' | 'B';

interface Row {
  lane: number;
  cells: Map<number, string>;
  hasNode: boolean;
  y: number;
  h: number;
}

interface LNode {
  node: ProcessNode;
  index: number;
  lane: number;
  col: number;
  row: Row;
  w: number;
  h: number;
  x: number;
  y: number;
  lines: string[];
  ports: Set<Side>;
  boundary: LBoundary[];
}

interface LBoundary {
  node: ProcessNode;
  host: LNode;
  slot: number;
  cx: number;
  cy: number;
}

interface LEdge {
  flow: Flow;
  /** Layout node the edge leaves from (the host, for boundary events). */
  src: LNode;
  dst: LNode;
  via: LBoundary | null;
  back: boolean;
}

type XSpec =
  | { t: 'left' | 'right' | 'cx'; n: LNode }
  | { t: 'bx'; b: LBoundary }
  | { t: 'chan'; seg: VSeg };

type YSpec =
  | { t: 'row'; row: Row }
  | { t: 'top' | 'bottom' | 'cy'; n: LNode }
  | { t: 'bbottom' | 'bjog'; b: LBoundary };

interface Waypoint {
  x: XSpec;
  y: YSpec;
}

/** A vertical run inside a channel; runs that share a port share a track. */
interface VSeg {
  channel: number;
  y1: YSpec;
  y2: YSpec;
  keys: string[];
  track: number;
  x: number;
}

interface Route {
  edge: LEdge;
  wps: Waypoint[];
  labelAt: 'first' | 'last';
}

const BOUNDARY_JOG = 9;

function nodeSize(node: ProcessNode): { w: number; h: number; lines: string[] } {
  if (isEvent(node.type)) return { w: METRICS.eventSize, h: METRICS.eventSize, lines: [] };
  if (isGateway(node.type)) return { w: METRICS.gatewaySize, h: METRICS.gatewaySize, lines: [] };
  const lines = wrapText(node.name, {
    fontSize: METRICS.nodeFont,
    maxWidth: METRICS.taskWidth - 16,
    maxLines: 6,
  });
  const marker = node.loop !== 'none' || node.type === 'subProcess' ? 14 : 0;
  const h = Math.max(METRICS.taskHeight, lines.length * METRICS.nodeLine + 26 + marker);
  return { w: METRICS.taskWidth, h, lines };
}

/** Cycle-breaking and longest-path ranking. */
function rankNodes(nodes: LNode[], edges: LEdge[]): void {
  const out = new Map<LNode, LEdge[]>(nodes.map((n) => [n, []]));
  for (const edge of edges) out.get(edge.src)!.push(edge);

  // Depth-first search: an edge to a node that is still on the stack closes a cycle.
  const state = new Map<LNode, number>();
  const roots = [...nodes.filter((n) => n.node.type === 'startEvent'), ...nodes];
  for (const root of roots) {
    if (state.get(root)) continue;
    const stack: { n: LNode; i: number }[] = [{ n: root, i: 0 }];
    state.set(root, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const list = out.get(frame.n)!;
      if (frame.i >= list.length) {
        state.set(frame.n, 2);
        stack.pop();
        continue;
      }
      const edge = list[frame.i++];
      const seen = state.get(edge.dst) ?? 0;
      if (seen === 1) edge.back = true;
      else if (seen === 0) {
        state.set(edge.dst, 1);
        stack.push({ n: edge.dst, i: 0 });
      }
    }
  }

  const forward = edges.filter((e) => !e.back);
  const indegree = new Map<LNode, number>(nodes.map((n) => [n, 0]));
  for (const edge of forward) indegree.set(edge.dst, indegree.get(edge.dst)! + 1);
  const queue = nodes.filter((n) => indegree.get(n) === 0);
  const order: LNode[] = [];
  for (const n of nodes) n.col = 0;
  while (queue.length > 0) {
    const n = queue.shift()!;
    order.push(n);
    for (const edge of out.get(n)!) {
      if (edge.back) continue;
      edge.dst.col = Math.max(edge.dst.col, n.col + 1);
      indegree.set(edge.dst, indegree.get(edge.dst)! - 1);
      if (indegree.get(edge.dst) === 0) queue.push(edge.dst);
    }
  }

  // Pull late entry points (secondary starts) next to the step they feed.
  const hasForwardIn = new Set(forward.map((e) => e.dst));
  for (const n of order) {
    if (hasForwardIn.has(n)) continue;
    const next = out
      .get(n)!
      .filter((e) => !e.back)
      .map((e) => e.dst.col);
    if (next.length > 0) n.col = Math.max(0, Math.min(...next) - 1);
  }
}

/** Longest forward path from each node to a sink: the main path gets the straight row. */
function tailLengths(nodes: LNode[], edges: LEdge[]): Map<LNode, number> {
  const tail = new Map<LNode, number>(nodes.map((n) => [n, 0]));
  const byCol = [...nodes].sort((a, b) => b.col - a.col);
  const out = new Map<LNode, LEdge[]>(nodes.map((n) => [n, []]));
  for (const edge of edges) if (!edge.back) out.get(edge.src)!.push(edge);
  for (const n of byCol) {
    for (const edge of out.get(n)!) tail.set(n, Math.max(tail.get(n)!, tail.get(edge.dst)! + 1));
  }
  return tail;
}

export function layoutProcess(model: ProcessModel): DiagramLayout {
  const M = METRICS;

  // ── Build the working graph ─────────────────────────────────────────────
  const laneIndex = new Map(model.lanes.map((lane, i) => [lane.id, i]));
  const laneRows: Row[][] = model.lanes.map(() => []);
  const newRow = (lane: number): Row => {
    const row: Row = { lane, cells: new Map(), hasNode: false, y: 0, h: 0 };
    laneRows[lane].push(row);
    return row;
  };
  const placeholder: Row = { lane: 0, cells: new Map(), hasNode: false, y: 0, h: 0 };

  const lnodes: LNode[] = [];
  const byId = new Map<string, LNode>();
  model.nodes.forEach((node, index) => {
    if (node.type === 'boundaryEvent') return;
    const size = nodeSize(node);
    const ln: LNode = {
      node,
      index,
      lane: laneIndex.get(node.lane) ?? 0,
      col: 0,
      row: placeholder,
      w: size.w,
      h: size.h,
      x: 0,
      y: 0,
      lines: size.lines,
      ports: new Set(),
      boundary: [],
    };
    lnodes.push(ln);
    byId.set(node.id, ln);
  });

  const boundaryById = new Map<string, LBoundary>();
  for (const node of model.nodes) {
    if (node.type !== 'boundaryEvent') continue;
    const host = byId.get(node.attachedTo);
    if (!host) continue;
    const b: LBoundary = { node, host, slot: host.boundary.length, cx: 0, cy: 0 };
    host.boundary.push(b);
    boundaryById.set(node.id, b);
  }

  const ledges: LEdge[] = [];
  for (const flow of model.flows) {
    const via = boundaryById.get(flow.from) ?? null;
    const src = via ? via.host : byId.get(flow.from);
    const dst = byId.get(flow.to);
    if (!src || !dst || src === dst) continue;
    ledges.push({ flow, src, dst, via, back: false });
  }

  rankNodes(lnodes, ledges);
  const tail = tailLengths(lnodes, ledges);
  const columnCount = lnodes.reduce((max, n) => Math.max(max, n.col + 1), 1);

  // ── Assign rows inside lanes ────────────────────────────────────────────
  const incoming = new Map<LNode, LEdge[]>(lnodes.map((n) => [n, []]));
  for (const edge of ledges) if (!edge.back) incoming.get(edge.dst)!.push(edge);

  const rowIndex = (row: Row): number => laneRows[row.lane].indexOf(row);
  for (let col = 0; col < columnCount; col++) {
    const here = lnodes
      .filter((n) => n.col === col)
      .map((n) => {
        const sameLane = incoming.get(n)!.filter((e) => e.src.lane === n.lane);
        const direct = sameLane.filter((e) => !e.via);
        let pref = 0;
        if (direct.length > 0) pref = Math.min(...direct.map((e) => rowIndex(e.src.row)));
        else if (sameLane.length > 0) pref = Math.min(...sameLane.map((e) => rowIndex(e.src.row))) + 1;
        return { n, pref };
      })
      .sort(
        (a, b) =>
          a.n.lane - b.n.lane || a.pref - b.pref || tail.get(b.n)! - tail.get(a.n)! || a.n.index - b.n.index,
      );
    for (const { n, pref } of here) {
      const rows = laneRows[n.lane];
      for (let i = pref; ; i++) {
        while (i >= rows.length) newRow(n.lane);
        if (!rows[i].cells.has(col)) {
          rows[i].cells.set(col, `n:${n.node.id}`);
          rows[i].hasNode = true;
          n.row = rows[i];
          break;
        }
      }
    }
  }
  laneRows.forEach((rows, lane) => {
    if (rows.length === 0) newRow(lane);
  });

  // ── Route sequence flows ────────────────────────────────────────────────
  const allRows = (): Row[] => laneRows.flat();
  const order = (row: Row): number => allRows().indexOf(row);
  const between = (a: Row, b: Row, includeB: boolean): Row[] => {
    const rows = allRows();
    const i = rows.indexOf(a);
    const j = rows.indexOf(b);
    const inner = i < j ? rows.slice(i + 1, j) : rows.slice(j + 1, i);
    return includeB ? [...inner, b] : inner;
  };
  const free = (row: Row, col: number, key: string): boolean => {
    const owner = row.cells.get(col);
    return owner === undefined || owner === key;
  };
  const columnClear = (col: number, from: Row, to: Row, key: string, includeTo: boolean): boolean =>
    between(from, to, includeTo).every((row) => free(row, col, key));
  const reserveColumn = (col: number, from: Row, to: Row, key: string, includeTo: boolean): void => {
    for (const row of between(from, to, includeTo)) row.cells.set(col, key);
  };
  const span = (a: number, b: number): number[] => {
    const cols: number[] = [];
    for (let c = a; c <= b; c++) cols.push(c);
    return cols;
  };

  const vsegs: VSeg[] = [];
  const channelRun = (channel: number, y1: YSpec, y2: YSpec, keys: string[]): VSeg => {
    const seg: VSeg = { channel, y1, y2, keys, track: 0, x: 0 };
    vsegs.push(seg);
    return seg;
  };
  const rowY = (row: Row): YSpec => ({ t: 'row', row });

  const routes: Route[] = [];
  const outCount = new Map<LNode, number>();
  for (const edge of ledges) if (!edge.via) outCount.set(edge.src, (outCount.get(edge.src) ?? 0) + 1);

  const routeForward = (edge: LEdge): Route => {
    const { src: u, dst: v, via } = edge;
    const key = `e:${edge.flow.id}`;
    const mid = span(u.col + 1, v.col - 1);
    const wps: Waypoint[] = [];
    let labelAt: Route['labelAt'] = 'first';

    // Row used to cross the columns between source and target.
    let passage: Row | null = null;
    if (mid.length > 0) {
      const near = (rows: Row[], ref: Row): Row[] =>
        [...rows].sort((a, b) => Math.abs(rowIndex(a) - rowIndex(ref)) - Math.abs(rowIndex(b) - rowIndex(ref)));
      const candidates = [u.row, v.row, ...near(laneRows[u.lane], u.row), ...near(laneRows[v.lane], v.row)];
      passage = candidates.find((row) => mid.every((c) => free(row, c, key))) ?? newRow(u.lane);
      for (const c of mid) passage.cells.set(c, key);
    }
    let firstRow = passage ?? v.row;
    if (!passage && !via && u.row !== v.row && isGateway(v.node.type)) {
      // Adjacent columns: run along the source's row and enter the merging
      // gateway through its top or bottom corner, unless the source is a
      // gateway that can leave through its own corner.
      const down = order(v.row) > order(u.row);
      const leaveByCorner =
        isGateway(u.node.type) && columnClear(u.col, u.row, v.row, `p:${u.node.id}:${down ? 'B' : 'T'}`, true);
      const enterByCorner = columnClear(v.col, v.row, u.row, `q:${v.node.id}:${down ? 'T' : 'B'}`, true);
      if (!leaveByCorner && enterByCorner) firstRow = u.row;
    }

    // Leave the source.
    if (via) {
      const bKey = `b:${via.node.id}`;
      wps.push({ x: { t: 'bx', b: via }, y: { t: 'bbottom', b: via } });
      if (order(firstRow) > order(u.row) && columnClear(u.col, u.row, firstRow, bKey, true)) {
        reserveColumn(u.col, u.row, firstRow, bKey, true);
        wps.push({ x: { t: 'bx', b: via }, y: rowY(firstRow) });
      } else {
        const seg = channelRun(u.col, { t: 'bjog', b: via }, rowY(firstRow), [`out:${via.node.id}`]);
        wps.push({ x: { t: 'bx', b: via }, y: { t: 'bjog', b: via } });
        wps.push({ x: { t: 'chan', seg }, y: { t: 'bjog', b: via } });
        wps.push({ x: { t: 'chan', seg }, y: rowY(firstRow) });
        if (mid.length === 0 && firstRow === v.row) seg.keys.push(`in:${v.node.id}:L`);
      }
    } else if (firstRow === u.row) {
      u.ports.add('R');
      wps.push({ x: { t: 'right', n: u }, y: { t: 'cy', n: u } });
    } else {
      const down = order(firstRow) > order(u.row);
      const side: Side = down ? 'B' : 'T';
      const portKey = `p:${u.node.id}:${side}`;
      if (isGateway(u.node.type) && columnClear(u.col, u.row, firstRow, portKey, true)) {
        reserveColumn(u.col, u.row, firstRow, portKey, true);
        u.ports.add(side);
        wps.push({ x: { t: 'cx', n: u }, y: { t: down ? 'bottom' : 'top', n: u } });
        wps.push({ x: { t: 'cx', n: u }, y: rowY(firstRow) });
      } else {
        u.ports.add('R');
        const seg = channelRun(u.col, { t: 'cy', n: u }, rowY(firstRow), [`out:${u.node.id}:R`]);
        wps.push({ x: { t: 'right', n: u }, y: { t: 'cy', n: u } });
        wps.push({ x: { t: 'chan', seg }, y: { t: 'cy', n: u } });
        wps.push({ x: { t: 'chan', seg }, y: rowY(firstRow) });
        if (mid.length === 0) seg.keys.push(`in:${v.node.id}:L`);
        // Several flows leave this port: label this one where it arrives instead.
        if ((outCount.get(u) ?? 0) > 1) labelAt = 'last';
      }
    }

    // Arrive at the target.
    if (firstRow === v.row) {
      v.ports.add('L');
      wps.push({ x: { t: 'left', n: v }, y: { t: 'cy', n: v } });
    } else {
      const fromBelow = order(firstRow) > order(v.row);
      const side: Side = fromBelow ? 'B' : 'T';
      const portKey = `q:${v.node.id}:${side}`;
      if (isGateway(v.node.type) && columnClear(v.col, v.row, firstRow, portKey, true)) {
        reserveColumn(v.col, v.row, firstRow, portKey, true);
        v.ports.add(side);
        wps.push({ x: { t: 'cx', n: v }, y: rowY(firstRow) });
        wps.push({ x: { t: 'cx', n: v }, y: { t: fromBelow ? 'bottom' : 'top', n: v } });
      } else {
        v.ports.add('L');
        const seg = channelRun(v.col - 1, rowY(firstRow), { t: 'cy', n: v }, [`in:${v.node.id}:L`]);
        wps.push({ x: { t: 'chan', seg }, y: rowY(firstRow) });
        wps.push({ x: { t: 'chan', seg }, y: { t: 'cy', n: v } });
        wps.push({ x: { t: 'left', n: v }, y: { t: 'cy', n: v } });
      }
    }
    return { edge, wps, labelAt };
  };

  const routeBack = (edge: LEdge): Route => {
    const { src: u, dst: v, via } = edge;
    const key = `e:${edge.flow.id}`;
    const cols = span(v.col, u.col);
    const lower = order(u.row) >= order(v.row) ? u.row : v.row;
    const below = laneRows[lower.lane].slice(rowIndex(lower) + 1);
    const passage = below.find((row) => cols.every((c) => free(row, c, key))) ?? newRow(lower.lane);

    const wps: Waypoint[] = [];
    const srcKey = via ? `b:${via.node.id}` : `p:${u.node.id}:B`;
    if (columnClear(u.col, u.row, passage, srcKey, false)) {
      reserveColumn(u.col, u.row, passage, srcKey, false);
      if (via) {
        wps.push({ x: { t: 'bx', b: via }, y: { t: 'bbottom', b: via } });
        wps.push({ x: { t: 'bx', b: via }, y: rowY(passage) });
      } else {
        u.ports.add('B');
        wps.push({ x: { t: 'cx', n: u }, y: { t: 'bottom', n: u } });
        wps.push({ x: { t: 'cx', n: u }, y: rowY(passage) });
      }
    } else if (via) {
      const seg = channelRun(u.col, { t: 'bjog', b: via }, rowY(passage), [`out:${via.node.id}`]);
      wps.push({ x: { t: 'bx', b: via }, y: { t: 'bbottom', b: via } });
      wps.push({ x: { t: 'bx', b: via }, y: { t: 'bjog', b: via } });
      wps.push({ x: { t: 'chan', seg }, y: { t: 'bjog', b: via } });
      wps.push({ x: { t: 'chan', seg }, y: rowY(passage) });
    } else {
      u.ports.add('R');
      const seg = channelRun(u.col, { t: 'cy', n: u }, rowY(passage), [`out:${u.node.id}:R`]);
      wps.push({ x: { t: 'right', n: u }, y: { t: 'cy', n: u } });
      wps.push({ x: { t: 'chan', seg }, y: { t: 'cy', n: u } });
      wps.push({ x: { t: 'chan', seg }, y: rowY(passage) });
    }
    for (const c of cols) passage.cells.set(c, key);

    const dstKey = `q:${v.node.id}:B`;
    if (columnClear(v.col, v.row, passage, dstKey, false)) {
      reserveColumn(v.col, v.row, passage, dstKey, false);
      v.ports.add('B');
      wps.push({ x: { t: 'cx', n: v }, y: rowY(passage) });
      wps.push({ x: { t: 'cx', n: v }, y: { t: 'bottom', n: v } });
    } else {
      v.ports.add('L');
      const seg = channelRun(v.col - 1, rowY(passage), { t: 'cy', n: v }, [`in:${v.node.id}:L`]);
      wps.push({ x: { t: 'chan', seg }, y: rowY(passage) });
      wps.push({ x: { t: 'chan', seg }, y: { t: 'cy', n: v } });
      wps.push({ x: { t: 'left', n: v }, y: { t: 'cy', n: v } });
    }
    return { edge, wps, labelAt: 'first' };
  };

  // Short, straight flows claim their cells first.
  const routingOrder = [...ledges].sort((a, b) => {
    if (a.back !== b.back) return a.back ? 1 : -1;
    const spanA = Math.abs(a.dst.col - a.src.col);
    const spanB = Math.abs(b.dst.col - b.src.col);
    if (spanA !== spanB) return spanA - spanB;
    const straightA = a.src.row === a.dst.row ? 0 : 1;
    const straightB = b.src.row === b.dst.row ? 0 : 1;
    return straightA - straightB || a.src.col - b.src.col;
  });
  for (const edge of routingOrder) routes.push(edge.back ? routeBack(edge) : routeForward(edge));

  // ── Labels that sit outside their shape ─────────────────────────────────
  const outerLabel = new Map<LNode, string[]>();
  for (const n of lnodes) {
    if (isActivity(n.node.type) || !n.node.name) continue;
    outerLabel.set(
      n,
      wrapText(n.node.name, {
        fontSize: M.labelFont,
        maxWidth: isGateway(n.node.type) ? 112 : 96,
        maxLines: isGateway(n.node.type) ? 2 : 3,
      }),
    );
  }
  const flowLabel = new Map<Route, string[]>();
  for (const route of routes) {
    if (!route.edge.flow.label) continue;
    flowLabel.set(route, wrapText(route.edge.flow.label, { fontSize: M.labelFont, maxWidth: 104, maxLines: 2 }));
  }

  // ── Vertical geometry ───────────────────────────────────────────────────
  for (const row of allRows()) {
    if (!row.hasNode) {
      row.h = M.passageRow;
      continue;
    }
    let extent = 0;
    for (const n of lnodes) {
      if (n.row !== row) continue;
      const label = outerLabel.get(n);
      const labelHeight = label ? label.length * M.labelLine + 6 : 0;
      let half = n.h / 2;
      if (isActivity(n.node.type)) half += n.boundary.length > 0 ? M.boundarySize / 2 + BOUNDARY_JOG + 6 : 10;
      else half += Math.max(labelHeight, 8);
      extent = Math.max(extent, half);
    }
    row.h = Math.max(M.rowMin, Math.ceil(extent * 2 + 12));
  }

  // External pools go above or below, whichever side their partners are on.
  const rowsFlat = allRows();
  const above: { id: string; name: string }[] = [];
  const belowExt: { id: string; name: string }[] = [];
  const externalSide = new Map<string, 'above' | 'below'>();
  model.externals.forEach((ext) => {
    const partners = model.messageFlows
      .filter((m) => m.from === ext.id || m.to === ext.id)
      .map((m) => byId.get(m.from === ext.id ? m.to : m.from))
      .filter((n): n is LNode => !!n);
    const position =
      partners.length > 0 && rowsFlat.length > 1
        ? partners.reduce((sum, n) => sum + rowsFlat.indexOf(n.row), 0) / partners.length / (rowsFlat.length - 1)
        : 0;
    const side = position > 0.5 ? 'below' : 'above';
    externalSide.set(ext.id, side);
    (side === 'above' ? above : belowExt).push(ext);
  });

  const poolTop = M.margin + above.length * (M.externalHeight + M.externalGap);
  let cursorY = poolTop;
  const laneBoxes: { y: number; h: number }[] = [];
  laneRows.forEach((rows) => {
    const top = cursorY;
    for (const row of rows) {
      row.y = cursorY;
      cursorY += row.h;
    }
    laneBoxes.push({ y: top, h: cursorY - top });
  });
  const poolBottom = cursorY;
  for (const n of lnodes) {
    n.y = n.row.y + (n.row.h - n.h) / 2;
    for (const b of n.boundary) b.cy = n.y + n.h;
  }

  const resolveY = (spec: YSpec): number => {
    switch (spec.t) {
      case 'row':
        return spec.row.y + spec.row.h / 2;
      case 'top':
        return spec.n.y;
      case 'bottom':
        return spec.n.y + spec.n.h;
      case 'cy':
        return spec.n.y + spec.n.h / 2;
      case 'bbottom':
        return spec.b.cy + M.boundarySize / 2;
      case 'bjog':
        return spec.b.cy + M.boundarySize / 2 + BOUNDARY_JOG;
    }
  };

  // ── Tracks inside channels ──────────────────────────────────────────────
  // Channel k lies between column k and k+1; -1 and columnCount-1 are the edges.
  const trackCount = new Map<number, number>();
  for (let channel = -1; channel < columnCount; channel++) {
    const segs = vsegs.filter((s) => s.channel === channel);
    if (segs.length === 0) continue;

    // Runs that share a source or target port belong to one bundle.
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      let root = k;
      while (parent.get(root) !== root) root = parent.get(root)!;
      parent.set(k, root);
      return root;
    };
    segs.forEach((seg, i) => {
      const self = `#${i}`;
      parent.set(self, self);
      for (const key of seg.keys) {
        if (!parent.has(key)) parent.set(key, key);
        parent.set(find(self), find(key));
      }
    });
    const bundles = new Map<string, { segs: VSeg[]; lo: number; hi: number }>();
    segs.forEach((seg, i) => {
      const root = find(`#${i}`);
      const a = resolveY(seg.y1);
      const b = resolveY(seg.y2);
      const bundle = bundles.get(root) ?? { segs: [], lo: Infinity, hi: -Infinity };
      bundle.segs.push(seg);
      bundle.lo = Math.min(bundle.lo, a, b);
      bundle.hi = Math.max(bundle.hi, a, b);
      bundles.set(root, bundle);
    });

    // Interval colouring: bundles whose spans overlap need different tracks.
    const sorted = [...bundles.values()].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    const trackEnd: number[] = [];
    const trackOf = new Map<(typeof sorted)[number], number>();
    for (const bundle of sorted) {
      let t = trackEnd.findIndex((end) => end < bundle.lo - 4);
      if (t < 0) t = trackEnd.length;
      trackEnd[t] = bundle.hi;
      trackOf.set(bundle, t);
    }

    // Order the tracks left to right so that as few lines cross as possible.
    const count = trackEnd.length;
    let best = span(0, count - 1);
    if (count > 1 && count <= 6) {
      const crossings = (perm: number[]): number => {
        let total = 0;
        for (const a of sorted) {
          for (const b of sorted) {
            if (a === b) continue;
            const xa = perm[trackOf.get(a)!];
            const xb = perm[trackOf.get(b)!];
            if (xa >= xb) continue;
            // a is left of b: a's exits and b's entries cross the other's run.
            for (const seg of a.segs) {
              const exit = resolveY(seg.y2);
              if (exit > b.lo && exit < b.hi) total++;
            }
            for (const seg of b.segs) {
              const entry = resolveY(seg.y1);
              if (entry > a.lo && entry < a.hi) total++;
            }
          }
        }
        return total;
      };
      let bestScore = Infinity;
      const permute = (perm: number[], rest: number[]): void => {
        if (rest.length === 0) {
          const score = crossings(perm);
          if (score < bestScore) {
            bestScore = score;
            best = [...perm];
          }
          return;
        }
        for (let i = 0; i < rest.length; i++) {
          permute([...perm, rest[i]], [...rest.slice(0, i), ...rest.slice(i + 1)]);
        }
      };
      permute([], span(0, count - 1));
    }
    for (const bundle of sorted) {
      for (const seg of bundle.segs) seg.track = best[trackOf.get(bundle)!];
    }
    trackCount.set(channel, count);
  }

  // ── Horizontal geometry ─────────────────────────────────────────────────
  const colWidth = span(0, columnCount - 1).map((c) =>
    lnodes.filter((n) => n.col === c).reduce<number>((max, n) => Math.max(max, n.w), M.eventSize),
  );
  const channelWidth = new Map<number, number>();
  for (let channel = -1; channel < columnCount; channel++) {
    const tracks = trackCount.get(channel) ?? 0;
    const edge = channel === -1 || channel === columnCount - 1;
    channelWidth.set(channel, Math.max(edge ? M.edgeChannel : M.channelMin, (tracks + 1) * M.trackGap + 20));
  }
  // Flow labels start next to their source: the channel after it must hold them.
  for (const [route, lines] of flowLabel) {
    if (route.edge.back) continue;
    const u = route.edge.src;
    const fromCorner = route.wps[0].x.t === 'cx' || route.wps[0].x.t === 'bx';
    const needed = blockWidth(lines, M.labelFont) + 18 - (fromCorner ? colWidth[u.col] / 2 - 8 : 0);
    channelWidth.set(u.col, Math.max(channelWidth.get(u.col)!, Math.ceil(needed)));
  }
  // Labels under events and over gateways must not run into the neighbours.
  for (const [n, lines] of outerLabel) {
    const overhang = Math.ceil((blockWidth(lines, M.labelFont) - colWidth[n.col]) / 2) + 8;
    if (overhang <= 0) continue;
    for (const channel of [n.col - 1, n.col]) {
      channelWidth.set(channel, Math.max(channelWidth.get(channel)!, overhang + 20));
    }
  }

  // A gateway whose top and bottom corners are both in use carries its name
  // to the upper left, above the incoming flow.
  for (const [n, lines] of outerLabel) {
    if (!isGateway(n.node.type) || !n.ports.has('T') || !n.ports.has('B')) continue;
    const needed = Math.ceil(blockWidth(lines, M.labelFont) + 12 + 10 - colWidth[n.col] / 2);
    channelWidth.set(n.col - 1, Math.max(channelWidth.get(n.col - 1)!, needed));
  }

  const contentLeft = M.margin + M.poolHeader + M.laneHeader;
  const colX: number[] = [];
  let cursorX = contentLeft + channelWidth.get(-1)!;
  for (let c = 0; c < columnCount; c++) {
    colX[c] = cursorX;
    cursorX += colWidth[c] + channelWidth.get(c)!;
  }
  const contentRight = cursorX;

  for (const n of lnodes) {
    n.x = colX[n.col] + (colWidth[n.col] - n.w) / 2;
    for (const b of n.boundary) b.cx = n.x + n.w - 26 - b.slot * (M.boundarySize + 6);
  }
  const channelLeft = (channel: number): number =>
    channel < 0 ? contentLeft : colX[channel] + colWidth[channel];
  for (const seg of vsegs) {
    const count = trackCount.get(seg.channel) ?? 1;
    seg.x = channelLeft(seg.channel) + (channelWidth.get(seg.channel)! * (seg.track + 1)) / (count + 1);
  }

  const resolveX = (spec: XSpec): number => {
    switch (spec.t) {
      case 'left':
        return spec.n.x;
      case 'right':
        return spec.n.x + spec.n.w;
      case 'cx':
        return spec.n.x + spec.n.w / 2;
      case 'bx':
        return spec.b.cx;
      case 'chan':
        return spec.seg.x;
    }
  };

  // ── Materialise ─────────────────────────────────────────────────────────
  const simplify = (points: Point[]): Point[] => {
    const out: Point[] = [];
    for (const p of points) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
      const prev = out[out.length - 2];
      if (
        prev &&
        last &&
        ((Math.abs(prev.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01) ||
          (Math.abs(prev.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01))
      ) {
        out[out.length - 1] = p;
      } else {
        out.push(p);
      }
    }
    return out;
  };
  const round = (value: number): number => Math.round(value * 100) / 100;
  const textBlock = (lines: string[], x: number, y: number, anchor: Anchor, bold = false): TextBlock => ({
    lines,
    x: round(x),
    y: round(y),
    anchor,
    fontSize: M.labelFont,
    lineHeight: M.labelLine,
    width: Math.ceil(blockWidth(lines, M.labelFont, bold)),
    height: lines.length * M.labelLine,
  });

  const edges: EdgeLayout[] = [];
  for (const route of routes) {
    const points = simplify(route.wps.map((wp) => ({ x: round(resolveX(wp.x)), y: round(resolveY(wp.y)) })));
    let label: TextBlock | null = null;
    const lines = flowLabel.get(route);
    if (lines && points.length >= 2) {
      const horizontal: number[] = [];
      for (let i = 0; i < points.length - 1; i++) {
        if (points[i].y === points[i + 1].y && points[i].x !== points[i + 1].x) horizontal.push(i);
      }
      const height = lines.length * M.labelLine;
      if (horizontal.length === 0) {
        // Purely vertical flow: put the label beside its first stretch.
        label = textBlock(lines, points[0].x + 6, Math.min(points[0].y, points[1].y) + 6, 'start');
      } else if (route.labelAt === 'last') {
        const i = horizontal[horizontal.length - 1];
        const rightward = points[i + 1].x > points[i].x;
        label = textBlock(lines, points[i + 1].x + (rightward ? -8 : 8), points[i].y - 4 - height, rightward ? 'end' : 'start');
      } else {
        const i = horizontal[0];
        const rightward = points[i + 1].x > points[i].x;
        // Leave room for the default-flow slash drawn at the start of the line.
        const gap = (i === 0 ? 6 : 8) + (route.edge.flow.isDefault ? 12 : 0);
        label = textBlock(lines, points[i].x + (rightward ? gap : -gap), points[i].y - 4 - height, rightward ? 'start' : 'end');
      }
    }
    edges.push({
      id: route.edge.flow.id,
      kind: 'sequence',
      from: route.edge.flow.from,
      to: route.edge.flow.to,
      points,
      label,
      isDefault: route.edge.flow.isDefault,
    });
  }

  const nodes: Record<string, NodeLayout> = {};
  for (const n of lnodes) {
    let label: TextBlock | null = null;
    const cx = n.x + n.w / 2;
    if (isActivity(n.node.type)) {
      if (n.lines.length > 0) {
        const height = n.lines.length * M.nodeLine;
        const marker = n.node.loop !== 'none' || n.node.type === 'subProcess' ? 7 : 0;
        label = {
          lines: n.lines,
          x: round(cx),
          y: round(n.y + (n.h - height) / 2 - marker),
          anchor: 'middle',
          fontSize: M.nodeFont,
          lineHeight: M.nodeLine,
          width: Math.ceil(blockWidth(n.lines, M.nodeFont)),
          height,
        };
      }
    } else {
      const lines = outerLabel.get(n);
      if (lines) {
        const height = lines.length * M.labelLine;
        const top = n.y - 5 - height;
        const bottom = n.y + n.h + 5;
        if (isGateway(n.node.type)) {
          if (!n.ports.has('T')) label = textBlock(lines, cx, top, 'middle');
          else if (!n.ports.has('B')) label = textBlock(lines, cx, bottom, 'middle');
          else label = textBlock(lines, cx - 12, n.y + 6 - height, 'end');
        } else {
          label = n.ports.has('B') && !n.ports.has('T') ? textBlock(lines, cx, top, 'middle') : textBlock(lines, cx, bottom, 'middle');
        }
      }
    }
    nodes[n.node.id] = { id: n.node.id, x: round(n.x), y: round(n.y), width: n.w, height: n.h, label };
    for (const b of n.boundary) {
      // The name goes below the activity's edge, to the left of the event.
      const lines = b.node.name
        ? wrapText(b.node.name, { fontSize: M.labelFont, maxWidth: 84, maxLines: 2 })
        : [];
      nodes[b.node.id] = {
        id: b.node.id,
        x: round(b.cx - M.boundarySize / 2),
        y: round(b.cy - M.boundarySize / 2),
        width: M.boundarySize,
        height: M.boundarySize,
        label: lines.length > 0 ? textBlock(lines, b.cx - M.boundarySize / 2 - 4, b.cy + 3, 'end') : null,
      };
    }
  }

  // ── Pool, lanes, external pools ─────────────────────────────────────────
  const poolX = M.margin;
  const poolWidth = Math.max(contentRight - poolX, 420);
  const bandLabel = (name: string, length: number): string[] =>
    wrapText(name, { fontSize: M.bandFont, maxWidth: Math.max(40, length - 16), maxLines: 2, bold: true });

  const pool: BandLayout = {
    id: 'pool',
    name: model.pool || model.name,
    x: poolX,
    y: poolTop,
    width: poolWidth,
    height: poolBottom - poolTop,
    headerWidth: M.poolHeader,
    labelLines: bandLabel(model.pool || model.name, poolBottom - poolTop),
  };
  const lanes: BandLayout[] = model.lanes.map((lane, i) => ({
    id: lane.id,
    name: lane.name,
    x: poolX + M.poolHeader,
    y: laneBoxes[i].y,
    width: poolWidth - M.poolHeader,
    height: laneBoxes[i].h,
    headerWidth: M.laneHeader,
    labelLines: bandLabel(lane.name, laneBoxes[i].h),
  }));

  const externals: BandLayout[] = [];
  const externalBox = new Map<string, BandLayout>();
  const addExternal = (ext: { id: string; name: string }, y: number): void => {
    const band: BandLayout = {
      id: ext.id,
      name: ext.name,
      x: poolX,
      y,
      width: poolWidth,
      height: M.externalHeight,
      headerWidth: 0,
      labelLines: wrapText(ext.name, { fontSize: M.bandFont, maxWidth: poolWidth - 40, maxLines: 2, bold: true }),
    };
    externals.push(band);
    externalBox.set(ext.id, band);
  };
  above.forEach((ext, i) => addExternal(ext, M.margin + i * (M.externalHeight + M.externalGap)));
  belowExt.forEach((ext, i) =>
    addExternal(ext, poolBottom + M.externalGap + i * (M.externalHeight + M.externalGap)),
  );

  // ── Message flows ───────────────────────────────────────────────────────
  for (const message of model.messageFlows) {
    const outbound = byId.has(message.from);
    const n = byId.get(outbound ? message.from : message.to);
    const band = externalBox.get(outbound ? message.to : message.from);
    if (!n || !band) continue;
    const up = externalSide.get(band.id) === 'above';
    const offset = isActivity(n.node.type) ? (outbound ? -18 : 18) : 0;
    const x = round(n.x + n.w / 2 + offset);
    const nodeY = up ? n.y : n.y + n.h;
    const bandY = up ? band.y + band.height : band.y;

    const rows = allRows();
    const at = rows.indexOf(n.row);
    const blocked = (up ? rows.slice(0, at) : rows.slice(at + 1)).some((row) =>
      row.cells.get(n.col)?.startsWith('n:'),
    );
    let points: Point[];
    if (!blocked) {
      points = [
        { x, y: round(nodeY) },
        { x, y: round(bandY) },
      ];
    } else {
      // Step sideways into the channel so the line does not cross a shape.
      const stripY = round(up ? n.row.y + 7 : n.row.y + n.row.h - 7);
      const sideX = round(colX[n.col] - 12);
      points = [
        { x, y: round(nodeY) },
        { x, y: stripY },
        { x: sideX, y: stripY },
        { x: sideX, y: round(bandY) },
      ];
    }
    if (!outbound) points.reverse();

    let label: TextBlock | null = null;
    if (message.label) {
      const lines = wrapText(message.label, { fontSize: M.labelFont, maxWidth: 120, maxLines: 2 });
      const end = up ? bandY + 8 : bandY - 8 - lines.length * M.labelLine;
      const anchorX = points[outbound ? points.length - 1 : 0].x + 6;
      label = textBlock(lines, anchorX, end, 'start');
    }
    edges.push({ id: message.id, kind: 'message', from: message.from, to: message.to, points, label, isDefault: false });
  }

  const bottom =
    belowExt.length > 0 ? poolBottom + belowExt.length * (M.externalHeight + M.externalGap) : poolBottom;
  return {
    width: Math.ceil(poolX + poolWidth + M.margin),
    height: Math.ceil(bottom + M.margin),
    pool,
    lanes,
    externals,
    nodes,
    edges,
  };
}
