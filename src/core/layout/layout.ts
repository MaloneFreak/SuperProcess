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
 * External partners are collapsed pools above and below the process. Each one
 * spans only the stretch it exchanges messages with; they are spread over the
 * two sides and over rows so that a message flow does not have to run through
 * a pool that is not its own, and message labels pick the free side of their
 * line.
 *
 * The result is plain geometry (boxes, polylines, text blocks) that every
 * exporter consumes unchanged, which is what keeps the Visio, BPMN, draw.io
 * and image outputs identical.
 */
import { isActivity, isEvent, isGateway, type Flow, type ProcessModel, type ProcessNode } from '../model/types';
import { blockWidth, measureText, wrapText } from './text';

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
  /**
   * Collapsed pools only: how far the name sits from the middle of the band,
   * so that it clears a message flow that has to cross the band.
   */
  labelOffset?: number;
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

/** Task types that carry an icon in their top-left corner. */
const ICON_TASKS: ReadonlySet<string> = new Set([
  'userTask',
  'manualTask',
  'serviceTask',
  'scriptTask',
  'businessRuleTask',
  'sendTask',
  'receiveTask',
]);
const ICON_CLEARANCE = 24;

/** True when the first line of the label is wide enough to run into the type icon. */
function clashesWithIcon(node: ProcessNode, lines: string[]): boolean {
  if (!ICON_TASKS.has(node.type) || lines.length === 0) return false;
  return measureText(lines[0], METRICS.nodeFont) > METRICS.taskWidth - 2 * 27;
}

function nodeSize(node: ProcessNode): { w: number; h: number; lines: string[] } {
  if (isEvent(node.type)) return { w: METRICS.eventSize, h: METRICS.eventSize, lines: [] };
  if (isGateway(node.type)) return { w: METRICS.gatewaySize, h: METRICS.gatewaySize, lines: [] };
  const lines = wrapText(node.name, {
    fontSize: METRICS.nodeFont,
    maxWidth: METRICS.taskWidth - 16,
    maxLines: 6,
  });
  const marker = node.loop !== 'none' || node.type === 'subProcess' ? 14 : 0;
  const text = lines.length * METRICS.nodeLine;
  // Keep the label clear of the icon: it either fits beside it or starts below it.
  const needed = clashesWithIcon(node, lines) ? ICON_CLEARANCE + text + 8 + marker : text + 26 + marker;
  return { w: METRICS.taskWidth, h: Math.max(METRICS.taskHeight, needed), lines };
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

  const rowsFlat = allRows();

  // The pool starts at the top margin for now. It moves down once the external
  // pools above it are placed, which needs the horizontal geometry first.
  let poolTop = M.margin;
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
  let poolBottom = cursorY;
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

  // ── External pools ──────────────────────────────────────────────────────
  // Each one spans only the stretch it exchanges messages with. Pools that do
  // not overlap share a row and narrow ones sit nearest the process, so that a
  // message flow rarely has to run through a pool that is not its own.
  const round = (value: number): number => Math.round(value * 100) / 100;
  const poolX = M.margin;
  const poolWidth = Math.max(contentRight - poolX, 420);
  const externalLabel = (name: string, width: number): string[] =>
    wrapText(name, { fontSize: M.bandFont, maxWidth: Math.max(40, width - 24), maxLines: 3, bold: true });

  interface ExternalPlan {
    ext: { id: string; name: string };
    side: 'above' | 'below';
    flows: MessagePlan[];
    lo: number;
    hi: number;
    /** 0 is the row next to the process. */
    row: number;
    labelOffset: number;
    /** Set when the name has to squeeze in beside a flow that crosses the pool. */
    labelLines?: string[];
  }
  interface MessagePlan {
    message: ProcessModel['messageFlows'][number];
    n: LNode;
    band: ExternalPlan;
    outbound: boolean;
    up: boolean;
    /** Where the line leaves or enters the step. */
    x: number;
    /** Where it meets the external pool. */
    attachX: number;
    /** Another step is in the way: the line sidesteps into the channel. */
    blocked: boolean;
    /** Which of the sidestep levels beside the step this flow turns on. */
    level: number;
  }

  const externalPlans = new Map<string, ExternalPlan>();
  for (const ext of model.externals) {
    externalPlans.set(ext.id, {
      ext,
      side: 'above',
      flows: [],
      lo: poolX,
      hi: poolX + poolWidth,
      row: 0,
      labelOffset: 0,
    });
  }
  const bands = [...externalPlans.values()];
  const blockedOn = (n: LNode, up: boolean): boolean => {
    const at = rowsFlat.indexOf(n.row);
    return (up ? rowsFlat.slice(0, at) : rowsFlat.slice(at + 1)).some((row) => row.cells.get(n.col)?.startsWith('n:'));
  };
  /** The steps a pool exchanges messages with, one entry per message flow. */
  const partnerSteps = new Map(
    bands.map((band) => [
      band,
      model.messageFlows
        .filter((message) => message.from === band.ext.id || message.to === band.ext.id)
        .map((message) => byId.get(message.from === band.ext.id ? message.to : message.from))
        .filter((n): n is LNode => !!n),
    ]),
  );
  /** The same as positions along the process. */
  const partners = new Map(bands.map((band) => [band, partnerSteps.get(band)!.map((n) => n.x + n.w / 2)]));
  // Two pools whose message flows alternate along the process cannot both stay
  // clear of each other on the same side.
  const alternate = (a: number[], b: number[]): boolean => {
    const within = (xs: number[], others: number[]): boolean => {
      const lo = Math.min(...others);
      const hi = Math.max(...others);
      return xs.some((x) => x > lo && x < hi);
    };
    return a.length > 0 && b.length > 0 && within(a, b) && within(b, a);
  };

  // Above or below the process? Each pool would like the side its partners are
  // nearer to. But two pools that alternate belong on opposite sides, a step
  // should not carry more than two message flows on one side, and a flow should
  // not have to sidestep another step. With a handful of pools every
  // combination can be tried; the first pool listed stays on top when it can.
  const sideCost = (above: boolean[]): number => {
    let cost = 0;
    const perStep = new Map<string, number>();
    bands.forEach((band, i) => {
      const steps = partnerSteps.get(band)!;
      if (steps.length > 0 && rowsFlat.length > 1) {
        const position = steps.reduce((sum, n) => sum + rowsFlat.indexOf(n.row), 0) / steps.length / (rowsFlat.length - 1);
        cost += 5 * (above[i] ? position : 1 - position);
      }
      if (!above[i]) cost += 0.01 * (bands.length - i);
      for (const n of steps) {
        if (blockedOn(n, above[i])) cost += 10;
        const key = `${n.node.id}:${above[i]}`;
        perStep.set(key, (perStep.get(key) ?? 0) + 1);
      }
      for (let j = 0; j < i; j++) {
        if (above[i] !== above[j]) continue;
        const other = bands[j];
        if (alternate(partners.get(band)!, partners.get(other)!)) cost += 1000;
        if (steps.some((n) => partnerSteps.get(other)!.includes(n))) cost += 2;
      }
    });
    for (const count of perStep.values()) cost += 100 * Math.max(0, count - 2);
    return cost;
  };
  let sidesAbove = bands.map((band) => {
    const steps = partnerSteps.get(band)!;
    if (steps.length === 0 || rowsFlat.length < 2) return true;
    return steps.reduce((sum, n) => sum + rowsFlat.indexOf(n.row), 0) / steps.length / (rowsFlat.length - 1) <= 0.5;
  });
  if (bands.length <= 8) {
    let best = sideCost(sidesAbove);
    for (let mask = 0; mask < 1 << bands.length; mask++) {
      const candidate = bands.map((_, i) => (mask & (1 << i)) === 0);
      const score = sideCost(candidate);
      if (score < best) {
        best = score;
        sidesAbove = candidate;
      }
    }
  }
  bands.forEach((band, i) => {
    band.side = sidesAbove[i] ? 'above' : 'below';
  });

  const messagePlans: MessagePlan[] = [];
  for (const message of model.messageFlows) {
    const outbound = byId.has(message.from);
    const n = byId.get(outbound ? message.from : message.to);
    const band = externalPlans.get(outbound ? message.to : message.from);
    if (!n || !band) continue;
    const up = band.side === 'above';
    const plan: MessagePlan = { message, n, band, outbound, up, x: 0, attachX: 0, blocked: blockedOn(n, up), level: 0 };
    band.flows.push(plan);
    messagePlans.push(plan);
  }

  // Flows that share a side of a step spread over its width, so that no two of
  // them run on the same line. A pool that reaches to the left of the step gets
  // the left of it and one that reaches to the right the right, with the wider
  // pool (which ends up further out) on the inside: that way its flow passes
  // beside the narrower pool instead of through it.
  const sharing = new Map<string, MessagePlan[]>();
  for (const plan of messagePlans) {
    const key = `${plan.n.node.id}:${plan.up ? 'up' : 'down'}`;
    sharing.set(key, [...(sharing.get(key) ?? []), plan]);
  }
  for (const group of sharing.values()) {
    const n = group[0].n;
    const centre = n.x + n.w / 2;
    const reach = (plan: MessagePlan): { side: number; width: number } => {
      const xs = partners.get(plan.band)!;
      const lo = Math.min(...xs);
      const hi = Math.max(...xs);
      // A pool with this step as its only partner is the narrowest of all: it
      // goes to the outside, like a pool that reaches no further than here.
      const side = hi - lo < 1 ? 2 : hi <= centre + 0.5 ? -1 : lo >= centre - 0.5 ? 1 : 0;
      return { side, width: hi - lo };
    };
    group.sort((a, b) => {
      const ra = reach(a);
      const rb = reach(b);
      if (ra.side !== rb.side) return ra.side - rb.side;
      if (ra.width !== rb.width) {
        if (ra.side === -1) return ra.width - rb.width;
        if (ra.side === 1) return rb.width - ra.width;
      }
      return Number(b.outbound) - Number(a.outbound);
    });
    const activity = isActivity(n.node.type);
    if (group.length === 1) {
      group[0].x = round(centre + (activity ? (group[0].outbound ? -18 : 18) : 0));
    } else {
      const step = activity ? Math.min(36, 84 / (group.length - 1)) : Math.min(16, 20 / (group.length - 1));
      group.forEach((plan, i) => {
        plan.x = round(centre + (i - (group.length - 1) / 2) * step);
      });
    }
    // Blocked flows turn on separate levels: the rightmost one furthest from the step.
    group
      .filter((plan) => plan.blocked)
      .sort((a, b) => b.x - a.x)
      .forEach((plan, i) => {
        plan.level = Math.min(i, 2);
      });
  }

  // A blocked flow runs along the channel before its column. Each gets a line
  // of its own there, clear of the sequence flows that use the channel. Flows
  // from steps nearer their pool take the lines nearer the column, which keeps
  // the sidesteps from crossing one another.
  const sidesteps = new Map<number, number[]>();
  const blockedPlans = messagePlans
    .filter((plan) => plan.blocked)
    .sort((a, b) => {
      if (a.n.col !== b.n.col) return a.n.col - b.n.col;
      if (a.up !== b.up) return a.up ? -1 : 1;
      const rowA = rowsFlat.indexOf(a.n.row);
      const rowB = rowsFlat.indexOf(b.n.row);
      if (rowA !== rowB) return a.up ? rowA - rowB : rowB - rowA;
      return b.x - a.x;
    });
  for (const plan of blockedPlans) {
    const channel = plan.n.col - 1;
    const taken = sidesteps.get(channel) ?? [];
    const tracks = vsegs.filter((seg) => seg.channel === channel).map((seg) => seg.x);
    const leftmost = channelLeft(channel) + 6;
    const first = colX[plan.n.col] - 12;
    let x = first;
    while (x >= leftmost && (tracks.some((t) => Math.abs(t - x) < 7) || taken.some((t) => Math.abs(t - x) < 8))) x -= 2;
    // No free line left in the channel: share one rather than leave it.
    if (x < leftmost) x = Math.max(leftmost, first - 8 * taken.length);
    taken.push(x);
    sidesteps.set(channel, taken);
    plan.attachX = round(x);
  }
  for (const plan of messagePlans) if (!plan.blocked) plan.attachX = plan.x;

  const EXT_PAD = 44; // from the outermost message flow to the edge of the pool
  const EXT_PAD_MIN = 16; // the same where a neighbour needs the room
  const EXT_GAP = 24; // between two pools in the same row
  const EXT_CLEAR = 10; // between a pool and a flow that passes beside it
  for (const band of bands) {
    if (band.flows.length === 0) continue; // nothing to line up with: full width
    const xs = band.flows.map((flow) => flow.attachX);
    const nameWidth = Math.ceil(blockWidth([band.ext.name], M.bandFont, true));
    const minWidth = Math.min(260, Math.max(168, nameWidth + 40));
    let lo = Math.min(...xs) - EXT_PAD;
    let hi = Math.max(...xs) + EXT_PAD;
    if (hi - lo < minWidth) {
      const centre = (lo + hi) / 2;
      lo = centre - minWidth / 2;
      hi = centre + minWidth / 2;
    }
    if (lo < poolX) {
      hi += poolX - lo;
      lo = poolX;
    }
    if (hi > poolX + poolWidth) {
      lo -= hi - (poolX + poolWidth);
      hi = poolX + poolWidth;
    }
    band.lo = Math.round(Math.max(poolX, lo));
    band.hi = Math.round(hi);
  }

  const externalRows = { above: 0, below: 0 };
  for (const side of ['above', 'below'] as const) {
    const rows: ExternalPlan[][] = [];
    const ordered = bands
      .filter((band) => band.side === side)
      .sort(
        (a, b) =>
          Number(a.flows.length === 0) - Number(b.flows.length === 0) || a.hi - a.lo - (b.hi - b.lo) || a.lo - b.lo,
      );
    for (const band of ordered) {
      let r = rows.findIndex((row) =>
        row.every((other) => band.hi + EXT_GAP <= other.lo || other.hi + EXT_GAP <= band.lo),
      );
      if (r < 0) r = rows.push([]) - 1;
      rows[r].push(band);
      band.row = r;
    }
    externalRows[side] = rows.length;
  }

  // A flow to a pool further out passes the rows before it. Where it would
  // clip the padding of a nearer pool, that pool gives way.
  const passing = (band: ExternalPlan): number[] =>
    messagePlans
      .filter((flow) => flow.band !== band && flow.band.side === band.side && flow.band.row > band.row)
      .map((flow) => flow.attachX);
  for (const band of bands) {
    if (band.flows.length === 0) continue;
    const xs = band.flows.map((flow) => flow.attachX);
    const coreLo = Math.min(...xs) - EXT_PAD_MIN;
    const coreHi = Math.max(...xs) + EXT_PAD_MIN;
    let lo = band.lo;
    let hi = band.hi;
    for (const x of passing(band)) {
      if (x >= coreHi + EXT_CLEAR) hi = Math.min(hi, x - EXT_CLEAR);
      else if (x <= coreLo - EXT_CLEAR) lo = Math.max(lo, x + EXT_CLEAR);
    }
    if (hi - lo >= 96) {
      band.lo = Math.round(lo);
      band.hi = Math.round(hi);
    }
  }
  // A flow that still crosses a pool must at least not strike through its name:
  // the name moves into a gap between the crossing lines, wrapped tighter if
  // that is what it takes.
  for (const band of bands) {
    const crossing = passing(band)
      .filter((x) => x > band.lo && x < band.hi)
      .sort((a, b) => a - b);
    if (crossing.length === 0) continue;
    const centre = (band.lo + band.hi) / 2;
    const stops = [band.lo + 4, ...crossing, band.hi - 4];
    const place = (lines: string[]): number | null => {
      const half = blockWidth(lines, M.bandFont, true) / 2 + 8;
      let best: number | null = null;
      for (let i = 0; i < stops.length - 1; i++) {
        const from = stops[i] + half;
        const to = stops[i + 1] - half;
        if (from > to) continue;
        const candidate = Math.min(to, Math.max(from, centre));
        if (best === null || Math.abs(candidate - centre) < Math.abs(best - centre)) best = candidate;
      }
      return best;
    };
    let best = place(externalLabel(band.ext.name, band.hi - band.lo));
    if (best === null) {
      const widest = Math.max(...stops.slice(1).map((stop, i) => stop - stops[i]));
      if (widest >= 60) {
        band.labelLines = wrapText(band.ext.name, { fontSize: M.bandFont, maxWidth: widest - 20, maxLines: 3, bold: true });
        best = place(band.labelLines);
      }
    }
    if (best !== null) band.labelOffset = Math.round(best - centre);
  }

  // Now the pool can move down to make room for the rows above it.
  const externalPitch = M.externalHeight + M.externalGap;
  const shiftY = externalRows.above * externalPitch;
  if (shiftY > 0) {
    for (const row of allRows()) row.y += shiftY;
    for (const n of lnodes) {
      n.y += shiftY;
      for (const b of n.boundary) b.cy += shiftY;
    }
    for (const box of laneBoxes) box.y += shiftY;
    poolTop += shiftY;
    poolBottom += shiftY;
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
        const centred = n.y + (n.h - height) / 2 - marker;
        const top = clashesWithIcon(n.node, n.lines) ? Math.max(centred, n.y + ICON_CLEARANCE) : centred;
        label = {
          lines: n.lines,
          x: round(cx),
          y: round(top),
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
  for (const ext of model.externals) {
    const plan = externalPlans.get(ext.id)!;
    const width = plan.hi - plan.lo;
    const band: BandLayout = {
      id: ext.id,
      name: ext.name,
      x: plan.lo,
      y:
        plan.side === 'above'
          ? poolTop - (plan.row + 1) * externalPitch
          : poolBottom + M.externalGap + plan.row * externalPitch,
      width,
      height: M.externalHeight,
      headerWidth: 0,
      labelLines: plan.labelLines ?? externalLabel(ext.name, width),
    };
    if (plan.labelOffset !== 0) band.labelOffset = plan.labelOffset;
    externals.push(band);
    externalBox.set(ext.id, band);
  }

  // ── Message flows ───────────────────────────────────────────────────────
  // A label sits beside its line, just outside the external pool, in the gap
  // between its line and the next one. Per strip (the space between one row of
  // pools and the next) the labels pick their sides together, so that as few of
  // them as possible have to be wrapped tighter to fit.
  const canvasRight = poolX + poolWidth + M.margin;
  const LABEL_GAP = 9; // between a line and its label: clear of the arrowhead
  const messageLabel = new Map<MessagePlan, TextBlock>();
  const strips = new Map<string, MessagePlan[]>();
  for (const plan of messagePlans) {
    if (!plan.message.label) continue;
    const key = `${plan.band.side}:${plan.band.row}`;
    strips.set(key, [...(strips.get(key) ?? []), plan]);
  }
  for (const labelled of strips.values()) {
    labelled.sort((a, b) => a.attachX - b.attachX);
    const { side, row } = labelled[0].band;
    // Every message flow that runs through this strip, pools further out included.
    const lines = [
      ...new Set(
        messagePlans.filter((plan) => plan.band.side === side && plan.band.row >= row).map((plan) => plan.attachX),
      ),
    ].sort((a, b) => a - b);
    const xs = labelled.map((plan) => plan.attachX);
    const texts = labelled.map((plan) =>
      wrapText(plan.message.label, { fontSize: M.labelFont, maxWidth: 120, maxLines: 2 }),
    );
    const widths = texts.map((text) => Math.ceil(blockWidth(text, M.labelFont)));
    // Below the width of its longest word a label has to break words.
    const wordWidths = labelled.map((plan, i) =>
      Math.min(
        widths[i],
        Math.ceil(Math.max(...plan.message.label.split(/\s+/).map((word) => measureText(word, M.labelFont)))),
      ),
    );
    const nextLine = (x: number): number | undefined => lines.find((line) => line > x);
    // How far a label may reach on either side of its line.
    const rightLimit = xs.map((x) => (nextLine(x) ?? canvasRight + 1) - 5);
    const leftLimit = xs.map((x) => ([...lines].reverse().find((line) => line < x) ?? -1) + 5);
    // Two labels meet in one gap when the left line's goes right and the right line's goes left.
    const meets = (i: number, right: boolean[]): boolean =>
      i + 1 < xs.length && right[i] && !right[i + 1] && nextLine(xs[i]) === xs[i + 1];
    /** The width each label may take; where two meet they share the gap by need. */
    const allot = (right: boolean[]): number[] => {
      const allowed = xs.map((x, i) => (right[i] ? rightLimit[i] - (x + LABEL_GAP) : x - LABEL_GAP - leftLimit[i]));
      for (let i = 0; i < xs.length; i++) {
        if (!meets(i, right)) continue;
        const j = i + 1;
        const room = xs[j] - xs[i] - 2 * LABEL_GAP - 6;
        if (widths[i] + widths[j] <= room) continue;
        const least = wordWidths[i] + wordWidths[j];
        let share: number;
        if (least <= room) {
          const spare = widths[i] - wordWidths[i] + (widths[j] - wordWidths[j]);
          share = wordWidths[i] + (spare > 0 ? ((room - least) * (widths[i] - wordWidths[i])) / spare : (room - least) / 2);
        } else {
          share = (room * wordWidths[i]) / least;
        }
        allowed[i] = Math.min(allowed[i], Math.floor(share));
        allowed[j] = Math.min(allowed[j], Math.floor(room - share));
      }
      return allowed;
    };
    const fit = (i: number, width: number): string[] =>
      width >= widths[i]
        ? texts[i]
        : wrapText(labelled[i].message.label, { fontSize: M.labelFont, maxWidth: width, maxLines: 3 });
    /** 0 when every label fits as it is; overlapping a neighbour costs most. */
    const cost = (right: boolean[]): number => {
      const allowed = allot(right);
      let total = 0;
      for (let i = 0; i < xs.length; i++) {
        if (!right[i]) total += 0.001;
        if (allowed[i] >= widths[i]) continue;
        if (allowed[i] < 30) total += 100;
        else if (allowed[i] < wordWidths[i] || fit(i, allowed[i]).at(-1)?.endsWith('…')) total += 10;
        else total += 1;
      }
      return total;
    };
    let sides = xs.map(() => true);
    if (xs.length <= 8) {
      let best = cost(sides);
      for (let mask = 1; mask < 1 << xs.length && best > 0; mask++) {
        const candidate = xs.map((_, i) => (mask & (1 << i)) === 0);
        const score = cost(candidate);
        if (score < best) {
          best = score;
          sides = candidate;
        }
      }
    } else {
      // Too many to try every combination: each takes the side with more room.
      sides = xs.map((x, i) => rightLimit[i] - (x + LABEL_GAP) >= x - LABEL_GAP - leftLimit[i]);
    }

    const allowed = allot(sides);
    labelled.forEach((plan, i) => {
      // Less than a short word of room: the label overlaps its neighbour rather
      // than vanish. It must still stay on the drawing.
      const text = allowed[i] >= 30 ? fit(i, allowed[i]) : texts[i];
      const width = Math.ceil(blockWidth(text, M.labelFont));
      let right = sides[i];
      if (right && xs[i] + LABEL_GAP + width > canvasRight - 4) right = false;
      else if (!right && xs[i] - LABEL_GAP - width < 4) right = true;
      const box = externalBox.get(plan.band.ext.id)!;
      const edgeY = plan.up ? box.y + box.height : box.y;
      const gap = text.length > 2 ? 4 : 8;
      const top = plan.up ? edgeY + gap : edgeY - gap - text.length * M.labelLine;
      messageLabel.set(plan, textBlock(text, right ? xs[i] + LABEL_GAP : xs[i] - LABEL_GAP, top, right ? 'start' : 'end'));
    });
  }

  for (const plan of messagePlans) {
    const { n, up, x } = plan;
    const box = externalBox.get(plan.band.ext.id)!;
    const nodeY = round(up ? n.y : n.y + n.h);
    const bandY = round(up ? box.y + box.height : box.y);
    let points: Point[];
    if (!plan.blocked) {
      points = [
        { x, y: nodeY },
        { x, y: bandY },
      ];
    } else {
      // Step sideways into the channel so the line does not cross a shape.
      const inset = 6 + plan.level * 5;
      const stripY = round(up ? n.row.y + inset : n.row.y + n.row.h - inset);
      points = [
        { x, y: nodeY },
        { x, y: stripY },
        { x: plan.attachX, y: stripY },
        { x: plan.attachX, y: bandY },
      ];
    }
    if (!plan.outbound) points.reverse();
    edges.push({
      id: plan.message.id,
      kind: 'message',
      from: plan.message.from,
      to: plan.message.to,
      points,
      label: messageLabel.get(plan) ?? null,
      isDefault: false,
    });
  }

  const bottom = poolBottom + externalRows.below * externalPitch;
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
