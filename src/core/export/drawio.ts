/**
 * diagrams.net / draw.io (.drawio) writer.
 *
 * Uses draw.io's own BPMN 2.0 stencils, real swimlane containers (steps are
 * children of their lane, lanes of the pool) and edges attached to their
 * shapes, so the file is fully editable there. Lucidchart and Confluence's
 * draw.io app import the same file.
 */
import type { Box, DiagramLayout, EdgeLayout, Point, TextBlock } from '../layout/layout';
import { METRICS } from '../layout/layout';
import type { EventKind, ProcessModel, ProcessNode } from '../model/types';
import { nodeRole } from '../render/graphics';
import { escapeXml } from '../render/svg';
import type { DiagramTheme } from '../render/theme';

const n = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * draw.io labels are HTML stored in an XML attribute: the text is escaped once
 * for HTML and the whole fragment once more for XML.
 */
function htmlAttribute(lines: string[]): string {
  return escapeXml(lines.map(escapeXml).join('<br>'));
}

function style(parts: Record<string, string | number | undefined>, prefix = ''): string {
  return (
    prefix +
    Object.entries(parts)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value};`)
      .join('')
  );
}

const TASK_MARKER: Partial<Record<ProcessNode['type'], string>> = {
  userTask: 'user',
  manualTask: 'manual',
  serviceTask: 'service',
  scriptTask: 'script',
  businessRuleTask: 'businessRule',
  sendTask: 'send',
  receiveTask: 'receive',
};

const EVENT_SYMBOL: Record<EventKind, string> = {
  none: 'general',
  message: 'message',
  timer: 'timer',
  error: 'error',
  escalation: 'escalation',
  conditional: 'conditional',
  signal: 'signal',
  terminate: 'terminate',
};

/** Where an outside label sits relative to its shape, in draw.io's terms. */
function labelPlacement(label: TextBlock | null, box: Box): Record<string, string> {
  if (!label) return { verticalLabelPosition: 'bottom', verticalAlign: 'top', align: 'center' };
  const above = label.y + label.height / 2 < box.y + box.height / 2;
  const vertical = above
    ? { verticalLabelPosition: 'top', verticalAlign: 'bottom' }
    : { verticalLabelPosition: 'bottom', verticalAlign: 'top' };
  if (label.anchor === 'end') return { ...vertical, labelPosition: 'left', align: 'right' };
  if (label.anchor === 'start') return { ...vertical, labelPosition: 'right', align: 'left' };
  return { ...vertical, align: 'center' };
}

function nodeStyle(node: ProcessNode, box: Box & { label: TextBlock | null }, theme: DiagramTheme): string {
  const palette = theme.roles[nodeRole(node)];
  const colors = { fillColor: palette.fill, strokeColor: palette.stroke, fontColor: theme.text };
  const role = nodeRole(node);

  if (role === 'task') {
    return style({
      // draw.io's palette now emits "mxgraph.bpmn.task2", which draws the same
      // at this line width but is missing from older releases (20.2 of 2022
      // shows a bare rectangle for it). Every release knows "task".
      shape: 'mxgraph.bpmn.task',
      whiteSpace: 'wrap',
      rectStyle: 'rounded',
      size: 10,
      html: 1,
      taskMarker: TASK_MARKER[node.type] ?? 'abstract',
      bpmnShapeType: node.type === 'callActivity' ? 'call' : undefined,
      isLoopSub: node.type === 'subProcess' ? 1 : undefined,
      isLoopStandard: node.loop === 'loop' ? 1 : undefined,
      isLoopMultiParallel: node.loop === 'parallel' ? 1 : undefined,
      isLoopMultiSeq: node.loop === 'sequential' ? 1 : undefined,
      fontSize: METRICS.nodeFont,
      ...colors,
    });
  }

  if (role === 'gateway') {
    const inner =
      node.type === 'exclusiveGateway'
        ? { outline: 'none', symbol: 'none', gwType: 'exclusive' }
        : node.type === 'parallelGateway'
          ? { outline: 'none', symbol: 'none', gwType: 'parallel' }
          : node.type === 'inclusiveGateway'
            ? { outline: 'end', symbol: 'general' }
            : { outline: 'catching', symbol: 'multiple' };
    return style({
      shape: 'mxgraph.bpmn.gateway2',
      html: 1,
      perimeter: 'rhombusPerimeter',
      outlineConnect: 0,
      labelBackgroundColor: 'none',
      ...labelPlacement(box.label, box),
      ...inner,
      fontSize: METRICS.labelFont,
      ...colors,
    });
  }

  let outline = 'standard';
  if (node.type === 'endEvent') outline = 'end';
  else if (node.type === 'intermediateCatchEvent') outline = 'catching';
  else if (node.type === 'intermediateThrowEvent') outline = 'throwing';
  else if (node.type === 'boundaryEvent') outline = node.interrupting ? 'boundInt' : 'boundNonint';
  const symbol = node.type === 'endEvent' && node.eventKind === 'none' ? 'terminate2' : EVENT_SYMBOL[node.eventKind];
  return style({
    shape: 'mxgraph.bpmn.event',
    html: 1,
    perimeter: 'ellipsePerimeter',
    outlineConnect: 0,
    aspect: 'fixed',
    labelBackgroundColor: 'none',
    ...labelPlacement(box.label, box),
    outline,
    symbol,
    fontSize: METRICS.labelFont,
    ...colors,
  });
}

function geometry(box: Box, parent?: Box): string {
  const x = box.x - (parent?.x ?? 0);
  const y = box.y - (parent?.y ?? 0);
  return `<mxGeometry x="${n(x)}" y="${n(y)}" width="${n(box.width)}" height="${n(box.height)}" as="geometry"/>`;
}

/** Position of `target` along the polyline (-1 = source, 1 = target) plus the remaining offset. */
function locate(points: Point[], target: Point): { at: number; dx: number; dy: number } {
  let total = 0;
  const lengths: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const length = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    lengths.push(length);
    total += length;
  }
  let best = { distance: Infinity, travelled: 0, x: points[0].x, y: points[0].y };
  let before = 0;
  for (let i = 0; i < lengths.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const t = lengths[i] > 0
      ? Math.max(0, Math.min(1, ((target.x - a.x) * (b.x - a.x) + (target.y - a.y) * (b.y - a.y)) / lengths[i] ** 2))
      : 0;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const distance = Math.hypot(target.x - x, target.y - y);
    if (distance < best.distance) best = { distance, travelled: before + lengths[i] * t, x, y };
    before += lengths[i];
  }
  return { at: total > 0 ? (best.travelled / total) * 2 - 1 : 0, dx: target.x - best.x, dy: target.y - best.y };
}

function relative(point: Point, box: Box | undefined): { x: string; y: string } | null {
  if (!box || box.width === 0 || box.height === 0) return null;
  const clamp = (value: number): number => Math.max(0, Math.min(1, value));
  return { x: n(clamp((point.x - box.x) / box.width)), y: n(clamp((point.y - box.y) / box.height)) };
}

export function exportDrawio(model: ProcessModel, layout: DiagramLayout, theme: DiagramTheme): string {
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  const boxOf = new Map<string, Box>();
  const bandText = { fontStyle: 1, fontSize: METRICS.bandFont, fontColor: theme.band.text };

  for (const ext of layout.externals) {
    boxOf.set(ext.id, ext);
    cells.push(
      `<mxCell id="${escapeXml(ext.id)}" value="${escapeXml(ext.name)}" style="${style({
        rounded: 0,
        whiteSpace: 'wrap',
        html: 1,
        fillColor: theme.external.fill,
        strokeColor: theme.external.stroke,
        ...bandText,
      })}" vertex="1" parent="1">${geometry(ext)}</mxCell>`,
    );
  }

  const swimlane = (fill: string, header: number): string =>
    style(
      {
        html: 1,
        horizontal: 0,
        startSize: header,
        collapsible: 0,
        whiteSpace: 'wrap',
        fillColor: theme.band.header,
        swimlaneFillColor: fill,
        strokeColor: theme.band.stroke,
        ...bandText,
      },
      'swimlane;',
    );

  if (model.nodes.length > 0) {
    cells.push(
      `<mxCell id="sp_pool" value="${escapeXml(layout.pool.name)}" style="${swimlane(theme.band.fill, layout.pool.headerWidth)}" vertex="1" parent="1">${geometry(layout.pool)}</mxCell>`,
    );
    layout.lanes.forEach((lane, i) => {
      cells.push(
        `<mxCell id="${escapeXml(lane.id)}" value="${escapeXml(lane.name)}" style="${swimlane(
          i % 2 === 0 ? theme.band.fill : theme.band.alt,
          lane.headerWidth,
        )}" vertex="1" parent="sp_pool">${geometry(lane, layout.pool)}</mxCell>`,
      );
    });
  }

  const laneBox = new Map(layout.lanes.map((lane) => [lane.id, lane]));
  const data = (label: string, value: string): string => (value ? ` ${label}="${escapeXml(value)}"` : '');
  for (const node of model.nodes) {
    const box = layout.nodes[node.id];
    const lane = laneBox.get(node.lane);
    if (!box || !lane) continue;
    boxOf.set(node.id, box);
    const task = nodeRole(node) === 'task';
    // Outside labels keep the line breaks the layout engine chose.
    const label = htmlAttribute(task ? [node.name] : (box.label?.lines ?? [node.name]));
    cells.push(
      `<object label="${label}" id="${escapeXml(node.id)}"` +
        data('Description', node.description) +
        data('Systems', node.systems.join(', ')) +
        data('Inputs', node.inputs.join(', ')) +
        data('Outputs', node.outputs.join(', ')) +
        data('Duration', node.duration) +
        data('Issues', node.issues.join('; ')) +
        `><mxCell style="${nodeStyle(node, box, theme)}" vertex="1" parent="${escapeXml(node.lane)}">${geometry(box, lane)}</mxCell></object>`,
    );
  }

  const edgeCell = (edge: EdgeLayout): void => {
    const message = edge.kind === 'message';
    const color = message ? theme.message : theme.flow;
    const first = edge.points[0];
    const last = edge.points[edge.points.length - 1];
    const exit = relative(first, boxOf.get(edge.from));
    const entry = relative(last, boxOf.get(edge.to));
    const edgeStyle = style({
      edgeStyle: 'orthogonalEdgeStyle',
      rounded: 1,
      orthogonalLoop: 1,
      jettySize: 'auto',
      html: 1,
      strokeColor: color,
      strokeWidth: 1.5,
      endArrow: 'block',
      endFill: message ? 0 : 1,
      endSize: 6,
      dashed: message ? 1 : undefined,
      dashPattern: message ? '6 4' : undefined,
      startArrow: message ? 'oval' : edge.isDefault ? 'dash' : undefined,
      startFill: message ? 0 : undefined,
      startSize: message ? 7 : edge.isDefault ? 10 : undefined,
      exitX: exit?.x,
      exitY: exit?.y,
      exitDx: exit ? 0 : undefined,
      exitDy: exit ? 0 : undefined,
      entryX: entry?.x,
      entryY: entry?.y,
      entryDx: entry ? 0 : undefined,
      entryDy: entry ? 0 : undefined,
    });
    const waypoints = edge.points
      .slice(1, -1)
      .map((p) => `<mxPoint x="${n(p.x)}" y="${n(p.y)}"/>`)
      .join('');
    const id = escapeXml(edge.id);
    cells.push(
      `<mxCell id="${id}" style="${edgeStyle}" edge="1" parent="1" source="${escapeXml(edge.from)}" target="${escapeXml(edge.to)}">` +
        '<mxGeometry relative="1" as="geometry">' +
        `<mxPoint x="${n(first.x)}" y="${n(first.y)}" as="sourcePoint"/>` +
        `<mxPoint x="${n(last.x)}" y="${n(last.y)}" as="targetPoint"/>` +
        (waypoints ? `<Array as="points">${waypoints}</Array>` : '') +
        '</mxGeometry></mxCell>',
    );
    if (edge.label) {
      const label = edge.label;
      const left = label.anchor === 'middle' ? label.x - label.width / 2 : label.anchor === 'end' ? label.x - label.width : label.x;
      const spot = locate(edge.points, { x: left + label.width / 2, y: label.y + label.height / 2 });
      cells.push(
        `<mxCell id="${id}_label" value="${htmlAttribute(label.lines)}" style="${style(
          {
            html: 1,
            align: 'center',
            verticalAlign: 'middle',
            resizable: 0,
            points: '[]',
            labelBackgroundColor: 'none',
            fontSize: METRICS.labelFont,
            fontColor: message ? theme.message : theme.text,
            fontStyle: message ? 2 : 0,
          },
          'edgeLabel;',
        )}" vertex="1" connectable="0" parent="${id}">` +
          `<mxGeometry x="${n(spot.at)}" relative="1" as="geometry"><mxPoint x="${n(spot.dx)}" y="${n(spot.dy)}" as="offset"/></mxGeometry></mxCell>`,
      );
    }
  };
  for (const edge of layout.edges) edgeCell(edge);

  return (
    '<mxfile host="SuperProcess" agent="SuperProcess" type="device">' +
    `<diagram id="process" name="${escapeXml(model.name || 'Process')}">` +
    `<mxGraphModel dx="1200" dy="800" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="${layout.width}" pageHeight="${layout.height}" math="0" shadow="0">` +
    `<root>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`
  );
}
