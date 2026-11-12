/**
 * Microsoft Visio (.vsdx) writer.
 *
 * A .vsdx file is an Open Packaging Conventions ZIP of XML parts. This module
 * writes one drawing page with:
 *
 *  - the pool, its lanes and any external (black-box) pools,
 *  - one shape per BPMN node, drawn from the same geometry as the on-screen
 *    diagram; icons and markers are sub-shapes of a group so they move, scale
 *    and reformat sensibly in Visio,
 *  - Shape Data on every step (type, lane, systems, inputs, outputs, duration,
 *    issues), so the process facts travel with the drawing,
 *  - connectors that are glued to their shapes: dragging a step in Visio
 *    drags its flows along.
 *
 * Visio measures in inches from the bottom-left corner of the page; the layout
 * engine measures in pixels (96 per inch) from the top-left.
 */
import { strToU8, zipSync } from 'fflate';
import type { BandLayout, Box, DiagramLayout, EdgeLayout, TextBlock } from '../layout/layout';
import { METRICS } from '../layout/layout';
import type { ProcessModel, ProcessNode } from '../model/types';
import { nodeGraphics, nodeRole, type Prim } from '../render/graphics';
import { escapeXml } from '../render/svg';
import type { DiagramTheme, Palette } from '../render/theme';
import { NO_STYLE_SHEET } from './vsdxDefaults';

const PX_PER_INCH = 96;
const FONT = 'Arial';

const VISIO_NS = 'http://schemas.microsoft.com/office/visio/2012/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** Formats a number for a cell value: enough precision, no exponent notation. */
function v(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function cell(name: string, value: string | number, formula?: string, unit?: string): string {
  const text = typeof value === 'number' ? v(value) : escapeXml(value);
  return `<Cell N="${name}" V="${text}"${unit ? ` U="${unit}"` : ''}${formula ? ` F="${escapeXml(formula)}"` : ''}/>`;
}

const inch = (px: number): number => px / PX_PER_INCH;

interface Format {
  lineColor: string;
  lineWeightPx: number;
  dashed?: boolean;
  fill: string | null;
  rounding?: number;
}

function formatCells(format: Format): string {
  const line =
    format.lineWeightPx > 0
      ? cell('LineWeight', inch(format.lineWeightPx)) +
        cell('LineColor', format.lineColor) +
        cell('LinePattern', format.dashed ? 2 : 1)
      : cell('LinePattern', 0);
  const fill = format.fill
    ? cell('FillForegnd', format.fill) + cell('FillBkgnd', format.fill) + cell('FillPattern', 1)
    : cell('FillPattern', 0);
  return line + (format.rounding ? cell('Rounding', inch(format.rounding)) : '') + fill;
}

interface TextFormat {
  color: string;
  sizePx: number;
  bold?: boolean;
  italic?: boolean;
  /** 0 = left, 1 = centre, 2 = right. */
  align?: number;
}

function textSections(format: TextFormat): string {
  const style = (format.bold ? 1 : 0) + (format.italic ? 2 : 0);
  return (
    '<Section N="Character"><Row IX="0">' +
    cell('Font', FONT) +
    cell('Color', format.color) +
    cell('Style', style) +
    cell('Size', inch(format.sizePx)) +
    '</Row></Section>' +
    `<Section N="Paragraph"><Row IX="0">${cell('HorzAlign', format.align ?? 1)}</Row></Section>`
  );
}

const GEOMETRY_FLAGS = (noFill: boolean): string =>
  cell('NoFill', noFill ? 1 : 0) + cell('NoLine', 0) + cell('NoShow', 0) + cell('NoSnap', 0) + cell('NoQuickDrag', 0);

function primBox(prim: Prim): Box {
  if (prim.k === 'ellipse') return { x: prim.cx - prim.rx, y: prim.cy - prim.ry, width: prim.rx * 2, height: prim.ry * 2 };
  if (prim.k === 'rrect') return { x: prim.x, y: prim.y, width: prim.w, height: prim.h };
  const xs = prim.pts.map((p) => p[0]);
  const ys = prim.pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Geometry section for a primitive, relative to its own bounding box. */
function primGeometry(prim: Prim, box: Box): string {
  const noFill = prim.fill === 'none' || (prim.k === 'poly' && !prim.closed);
  let rows = '';
  if (prim.k === 'ellipse') {
    const w = inch(box.width);
    const h = inch(box.height);
    rows =
      '<Row T="Ellipse" IX="1">' +
      cell('X', w / 2, 'Width*0.5') +
      cell('Y', h / 2, 'Height*0.5') +
      cell('A', w, 'Width*1', 'DL') +
      cell('B', h / 2, 'Height*0.5', 'DL') +
      cell('C', w / 2, 'Width*0.5', 'DL') +
      cell('D', h, 'Height*1', 'DL') +
      '</Row>';
  } else {
    const pts: [number, number][] =
      prim.k === 'rrect'
        ? [
            [box.x, box.y],
            [box.x + box.width, box.y],
            [box.x + box.width, box.y + box.height],
            [box.x, box.y + box.height],
          ]
        : [...prim.pts];
    if (prim.k === 'rrect' || prim.closed) pts.push(pts[0]);
    pts.forEach(([x, y], i) => {
      const fx = box.width > 0 ? (x - box.x) / box.width : 0;
      const fy = box.height > 0 ? 1 - (y - box.y) / box.height : 0;
      rows += `<Row T="${i === 0 ? 'RelMoveTo' : 'RelLineTo'}" IX="${i + 1}">${cell('X', fx)}${cell('Y', fy)}</Row>`;
    });
  }
  return `<Section N="Geometry" IX="0">${GEOMETRY_FLAGS(noFill)}${rows}</Section>`;
}

function primFormat(prim: Prim, palette: Palette, theme: DiagramTheme): Format {
  const fill =
    prim.fill === 'shape' ? palette.fill : prim.fill === 'ink' ? palette.stroke : prim.fill === 'paper' ? theme.paper : null;
  return {
    lineColor: prim.paperStroke ? theme.paper : palette.stroke,
    lineWeightPx: prim.sw,
    dashed: prim.dashed,
    fill: prim.k === 'poly' && !prim.closed ? null : fill,
    rounding: prim.k === 'rrect' ? prim.r : undefined,
  };
}

function propertyRow(name: string, label: string, value: string): string {
  const none = 'No Formula';
  return (
    `<Row N="${name}">` +
    cell('Value', value, undefined, 'STR') +
    cell('Prompt', '', none) +
    cell('Label', label) +
    cell('Format', '', none) +
    cell('SortKey', '', none) +
    cell('Type', 0) +
    cell('Invisible', 0, none) +
    cell('Verify', 0, none) +
    cell('DataLinked', 0, none) +
    cell('LangID', 'en-US') +
    cell('Calendar', 0, none) +
    '</Row>'
  );
}

const TYPE_LABEL: Record<string, string> = {
  startEvent: 'Start event',
  endEvent: 'End event',
  intermediateCatchEvent: 'Intermediate event (catching)',
  intermediateThrowEvent: 'Intermediate event (throwing)',
  boundaryEvent: 'Boundary event',
  task: 'Task',
  userTask: 'User task',
  manualTask: 'Manual task',
  serviceTask: 'Service task',
  scriptTask: 'Script task',
  businessRuleTask: 'Business rule task',
  sendTask: 'Send task',
  receiveTask: 'Receive task',
  subProcess: 'Sub-process',
  callActivity: 'Call activity',
  exclusiveGateway: 'Exclusive gateway',
  parallelGateway: 'Parallel gateway',
  inclusiveGateway: 'Inclusive gateway',
  eventBasedGateway: 'Event-based gateway',
};

class PageWriter {
  private nextId = 1;
  private readonly shapes: string[] = [];
  private readonly connects: string[] = [];
  readonly shapeIds = new Map<string, number>();

  constructor(
    private readonly pageHeight: number,
    private readonly theme: DiagramTheme,
  ) {}

  private id(): number {
    return this.nextId++;
  }

  /** Transform cells for a box given in page pixels. */
  private xform(box: Box): string {
    const w = inch(box.width);
    const h = inch(box.height);
    return (
      cell('PinX', inch(box.x) + w / 2) +
      cell('PinY', this.pageHeight - inch(box.y) - h / 2) +
      cell('Width', w) +
      cell('Height', h) +
      cell('LocPinX', w / 2, 'Width*0.5') +
      cell('LocPinY', h / 2, 'Height*0.5') +
      cell('Angle', 0) +
      cell('FlipX', 0) +
      cell('FlipY', 0) +
      cell('ResizeMode', 0)
    );
  }

  /** Places the text block over `label`, which may lie outside the shape. */
  private textXform(label: TextBlock, box: Box): { cells: string; align: number } {
    const pad = 5;
    const left = label.anchor === 'middle' ? label.x - label.width / 2 : label.anchor === 'end' ? label.x - label.width : label.x;
    const width = label.width + pad * 2;
    const height = label.height + 4;
    const centerX = left + label.width / 2;
    const centerY = label.y + label.height / 2;
    const above = centerY < box.y + box.height / 2;
    const w = inch(width);
    const h = inch(height);
    return {
      cells:
        cell('TxtPinX', inch(centerX - box.x)) +
        cell('TxtPinY', inch(box.y + box.height - centerY)) +
        cell('TxtWidth', w) +
        cell('TxtHeight', h) +
        cell('TxtLocPinX', w / 2, 'TxtWidth*0.5') +
        cell('TxtLocPinY', h / 2, 'TxtHeight*0.5') +
        cell('TxtAngle', 0) +
        // Text grows away from the shape if Visio wraps it differently.
        cell('VerticalAlign', above ? 2 : 0),
      align: label.anchor === 'middle' ? 1 : label.anchor === 'end' ? 2 : 0,
    };
  }

  /** Transform cells of a group member, tied to the group so it scales with it. */
  private memberXform(groupId: number, group: Box, member: Box): string {
    const w = inch(member.width);
    const h = inch(member.height);
    const fx = (member.x - group.x + member.width / 2) / group.width;
    const fy = 1 - (member.y - group.y + member.height / 2) / group.height;
    return (
      cell('PinX', inch(group.width) * fx, `Sheet.${groupId}!Width*${v(fx)}`) +
      cell('PinY', inch(group.height) * fy, `Sheet.${groupId}!Height*${v(fy)}`) +
      cell('Width', w, `Sheet.${groupId}!Width*${v(member.width / group.width)}`) +
      cell('Height', h, `Sheet.${groupId}!Height*${v(member.height / group.height)}`) +
      cell('LocPinX', w / 2, 'Width*0.5') +
      cell('LocPinY', h / 2, 'Height*0.5') +
      cell('Angle', 0) +
      cell('FlipX', 0) +
      cell('FlipY', 0) +
      cell('ResizeMode', 0)
    );
  }

  /**
   * A pool, lane or collapsed external pool. Pools and lanes are groups of a
   * body rectangle and a title strip with vertical text, so they move as one.
   */
  band(band: BandLayout, kind: 'Pool' | 'Swimlane' | 'External participant', fill: string, lineWeightPx: number): number {
    const { theme } = this;
    const format: Format = { lineColor: theme.band.stroke, lineWeightPx, fill };
    const rectPrim = (box: Box): Prim => ({ k: 'rrect', x: box.x, y: box.y, w: box.width, h: box.height, r: 0, fill: 'shape', sw: 1 });
    const id = this.id();
    const name = `${kind}.${id}`;

    if (band.headerWidth === 0) {
      // Collapsed pool: the name sits in the middle of the band, or beside a
      // message flow that has to cross it.
      const w = inch(band.width);
      const h = inch(band.height);
      const shift = inch(band.labelOffset ?? 0);
      const textBlock = shift
        ? cell('TxtPinX', w / 2 + shift) +
          cell('TxtPinY', h / 2, 'Height*0.5') +
          cell('TxtWidth', w, 'Width*1') +
          cell('TxtHeight', h, 'Height*1') +
          cell('TxtLocPinX', w / 2, 'TxtWidth*0.5') +
          cell('TxtLocPinY', h / 2, 'TxtHeight*0.5') +
          cell('TxtAngle', 0)
        : '';
      this.shapes.push(
        `<Shape ID="${id}" NameU="${name}" Name="${name}" Type="Shape" LineStyle="3" FillStyle="3" TextStyle="3">` +
          this.xform(band) +
          textBlock +
          formatCells(format) +
          cell('VerticalAlign', 1) +
          cell('ObjType', 4) +
          textSections({ color: theme.band.text, sizePx: METRICS.bandFont, bold: true }) +
          primGeometry(rectPrim(band), band) +
          `<Text>${escapeXml(band.name)}</Text>` +
          '</Shape>',
      );
      return id;
    }

    const header: Box = { x: band.x, y: band.y, width: band.headerWidth, height: band.height };
    const w = inch(header.width);
    const h = inch(header.height);
    const body =
      `<Shape ID="${this.id()}" Type="Shape" LineStyle="3" FillStyle="3" TextStyle="3">` +
      this.memberXform(id, band, band) +
      formatCells(format) +
      cell('ObjType', 4) +
      primGeometry(rectPrim(band), band) +
      '</Shape>';
    const title =
      `<Shape ID="${this.id()}" Type="Shape" LineStyle="3" FillStyle="3" TextStyle="3">` +
      this.memberXform(id, band, header) +
      // Rotate the text block a quarter turn so the title reads bottom to top.
      cell('TxtPinX', w / 2, 'Width*0.5') +
      cell('TxtPinY', h / 2, 'Height*0.5') +
      cell('TxtWidth', h, 'Height*1') +
      cell('TxtHeight', w, 'Width*1') +
      cell('TxtLocPinX', h / 2, 'TxtWidth*0.5') +
      cell('TxtLocPinY', w / 2, 'TxtHeight*0.5') +
      cell('TxtAngle', Math.PI / 2) +
      formatCells({ ...format, fill: theme.band.header }) +
      cell('VerticalAlign', 1) +
      cell('ObjType', 4) +
      textSections({ color: theme.band.text, sizePx: METRICS.bandFont, bold: true }) +
      primGeometry(rectPrim(header), header) +
      `<Text>${escapeXml(band.name)}</Text>` +
      '</Shape>';
    this.shapes.push(
      `<Shape ID="${id}" NameU="${name}" Name="${name}" Type="Group" LineStyle="3" FillStyle="3" TextStyle="3">` +
        this.xform(band) +
        cell('LinePattern', 0) +
        cell('FillPattern', 0) +
        cell('ObjType', 4) +
        `<Shapes>${body}${title}</Shapes>` +
        '</Shape>',
    );
    return id;
  }

  node(node: ProcessNode, box: Box & { label: TextBlock | null }, laneName: string): void {
    const { theme } = this;
    const palette = theme.roles[nodeRole(node)];
    const graphics = nodeGraphics(node, box.width, box.height);
    const id = this.id();
    this.shapeIds.set(node.id, id);

    const isTask = nodeRole(node) === 'task';
    let text = '';
    let textCells = '';
    let align = 1;
    if (node.name && box.label) {
      text = `<Text>${escapeXml(node.name)}</Text>`;
      if (isTask) {
        textCells = cell('VerticalAlign', 1);
      } else {
        const placed = this.textXform(box.label, box);
        textCells = placed.cells;
        align = placed.align;
      }
    }

    const properties =
      '<Section N="Property">' +
      propertyRow('BpmnType', 'BPMN type', TYPE_LABEL[node.type] ?? node.type) +
      propertyRow('Lane', 'Lane', laneName) +
      propertyRow('Description', 'Description', node.description) +
      propertyRow('Systems', 'Systems', node.systems.join(', ')) +
      propertyRow('Inputs', 'Inputs', node.inputs.join(', ')) +
      propertyRow('Outputs', 'Outputs', node.outputs.join(', ')) +
      propertyRow('Duration', 'Duration', node.duration) +
      propertyRow('Issues', 'Issues', node.issues.join('; ')) +
      '</Section>';

    const margin = inch(3);
    const common =
      this.xform(box) +
      textCells +
      formatCells(primFormat(graphics.outline, palette, theme)) +
      cell('LeftMargin', margin) +
      cell('RightMargin', margin) +
      cell('TopMargin', margin) +
      cell('BottomMargin', margin) +
      cell('ObjType', 1);
    const sections =
      textSections({ color: theme.text, sizePx: isTask ? METRICS.nodeFont : METRICS.labelFont, align }) +
      properties +
      primGeometry(graphics.outline, { x: 0, y: 0, width: box.width, height: box.height });

    const name = `${TYPE_LABEL[node.type] ?? 'Step'}.${id}`;
    const local: Box = { x: 0, y: 0, width: box.width, height: box.height };
    if (graphics.decor.length === 0) {
      this.shapes.push(
        `<Shape ID="${id}" NameU="${name}" Name="${name}" Type="Shape" LineStyle="3" FillStyle="3" TextStyle="3">${common}${sections}${text}</Shape>`,
      );
      return;
    }

    // Icons and markers become members of a group whose own geometry is the outline.
    let members = '';
    for (const prim of graphics.decor) {
      const pb = primBox(prim);
      const memberId = this.id();
      members +=
        `<Shape ID="${memberId}" Type="Shape" LineStyle="3" FillStyle="3" TextStyle="3">` +
        this.memberXform(id, local, pb) +
        formatCells(primFormat(prim, palette, theme)) +
        cell('LockFromGroupFormat', 1) +
        primGeometry(prim, pb) +
        '</Shape>';
    }
    this.shapes.push(
      `<Shape ID="${id}" NameU="${name}" Name="${name}" Type="Group" LineStyle="3" FillStyle="3" TextStyle="3">` +
        common +
        cell('SelectMode', 0) +
        sections +
        text +
        `<Shapes>${members}</Shapes>` +
        '</Shape>',
    );
  }

  connector(edge: EdgeLayout): void {
    const { theme } = this;
    const message = edge.kind === 'message';
    const color = message ? theme.message : theme.flow;
    const pts = edge.points.map((p) => ({ x: inch(p.x), y: this.pageHeight - inch(p.y) }));
    if (pts.length < 2) return;
    const begin = pts[0];
    const end = pts[pts.length - 1];
    const id = this.id();
    const from = this.shapeIds.get(edge.from);
    const to = this.shapeIds.get(edge.to);

    const width = end.x - begin.x;
    const height = end.y - begin.y;
    const glueBegin = from !== undefined ? '_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)' : undefined;
    const glueEnd = to !== undefined ? '_WALKGLUE(EndTrigger,BegTrigger,WalkPreference)' : undefined;

    let cells =
      cell('PinX', (begin.x + end.x) / 2, 'GUARD((BeginX+EndX)/2)') +
      cell('PinY', (begin.y + end.y) / 2, 'GUARD((BeginY+EndY)/2)') +
      cell('Width', width, 'GUARD(EndX-BeginX)') +
      cell('Height', height, 'GUARD(EndY-BeginY)') +
      cell('LocPinX', width / 2, 'GUARD(Width*0.5)') +
      cell('LocPinY', height / 2, 'GUARD(Height*0.5)') +
      cell('Angle', 0, 'GUARD(0DA)') +
      cell('FlipX', 0, 'GUARD(FALSE)') +
      cell('FlipY', 0, 'GUARD(FALSE)') +
      cell('ResizeMode', 0) +
      cell('BeginX', begin.x, glueBegin) +
      cell('BeginY', begin.y, glueBegin) +
      cell('EndX', end.x, glueEnd) +
      cell('EndY', end.y, glueEnd);

    let text = '';
    let textFormat = '';
    if (edge.label) {
      const label = edge.label;
      const left = label.anchor === 'middle' ? label.x - label.width / 2 : label.anchor === 'end' ? label.x - label.width : label.x;
      const cx = inch(left + label.width / 2);
      const cy = this.pageHeight - inch(label.y + label.height / 2);
      const w = inch(label.width + 10);
      const h = inch(label.height + 4);
      cells +=
        cell('TxtPinX', cx - begin.x) +
        cell('TxtPinY', cy - begin.y) +
        cell('TxtWidth', w) +
        cell('TxtHeight', h) +
        cell('TxtLocPinX', w / 2, 'TxtWidth*0.5') +
        cell('TxtLocPinY', h / 2, 'TxtHeight*0.5') +
        cell('TxtAngle', 0);
      text = `<Text>${escapeXml(label.lines.join(' '))}</Text>`;
      textFormat = textSections({
        color: message ? theme.message : theme.text,
        sizePx: METRICS.labelFont,
        italic: message,
        align: label.anchor === 'middle' ? 1 : label.anchor === 'end' ? 2 : 0,
      });
    }

    cells +=
      cell('LineWeight', inch(1.5)) +
      cell('LineColor', color) +
      cell('LinePattern', message ? 2 : 1) +
      cell('Rounding', inch(7)) +
      cell('BeginArrow', message ? 20 : 0) +
      cell('EndArrow', message ? 14 : 4) +
      cell('BeginArrowSize', 1) +
      cell('EndArrowSize', 2) +
      cell('FillPattern', 0) +
      cell('LockHeight', 1) +
      cell('LockCalcWH', 1) +
      cell('NoAlignBox', 1) +
      cell('DynFeedback', 2) +
      cell('GlueType', 2) +
      cell('ObjType', 2) +
      cell('NoLiveDynamics', 1) +
      cell('ShapeSplittable', 1) +
      cell('ShapeRouteStyle', 1) +
      cell('ConLineRouteExt', 1);
    if (from !== undefined) cells += cell('BegTrigger', 2, `_XFTRIGGER(Sheet.${from}!EventXFMod)`);
    if (to !== undefined) cells += cell('EndTrigger', 2, `_XFTRIGGER(Sheet.${to}!EventXFMod)`);

    let rows = '';
    pts.forEach((p, i) => {
      rows += `<Row T="${i === 0 ? 'MoveTo' : 'LineTo'}" IX="${i + 1}">${cell('X', p.x - begin.x)}${cell('Y', p.y - begin.y)}</Row>`;
    });

    const name = `${message ? 'Message flow' : 'Sequence flow'}.${id}`;
    this.shapes.push(
      `<Shape ID="${id}" NameU="${name}" Name="${name}" Type="Shape" LineStyle="3" FillStyle="3" TextStyle="3">` +
        cells +
        textFormat +
        `<Section N="Geometry" IX="0">${GEOMETRY_FLAGS(true)}${rows}</Section>` +
        text +
        '</Shape>',
    );
    if (from !== undefined) {
      this.connects.push(`<Connect FromSheet="${id}" FromCell="BeginX" FromPart="9" ToSheet="${from}" ToCell="PinX" ToPart="3"/>`);
    }
    if (to !== undefined) {
      this.connects.push(`<Connect FromSheet="${id}" FromCell="EndX" FromPart="12" ToSheet="${to}" ToCell="PinX" ToPart="3"/>`);
    }
  }

  xml(): string {
    const connects = this.connects.length > 0 ? `<Connects>${this.connects.join('')}</Connects>` : '';
    return (
      `${XML_HEADER}<PageContents xmlns="${VISIO_NS}" xmlns:r="${REL_NS}" xml:space="preserve">` +
      `<Shapes>${this.shapes.join('')}</Shapes>${connects}</PageContents>`
    );
  }
}

function documentXml(): string {
  const derived = (id: number, name: string, extra: string): string =>
    `<StyleSheet ID="${id}" NameU="${name}" IsCustomNameU="1" Name="${name}" IsCustomName="1" LineStyle="0" FillStyle="0" TextStyle="0">` +
    cell('EnableLineProps', 1) +
    cell('EnableFillProps', 1) +
    cell('EnableTextProps', 1) +
    cell('HideForApply', 0) +
    extra +
    '</StyleSheet>';
  return (
    `${XML_HEADER}<VisioDocument xmlns="${VISIO_NS}" xmlns:r="${REL_NS}" xml:space="preserve">` +
    '<DocumentSettings TopPage="0" DefaultTextStyle="3" DefaultLineStyle="3" DefaultFillStyle="3" DefaultGuideStyle="4">' +
    '<GlueSettings>9</GlueSettings><SnapSettings>65847</SnapSettings><SnapExtensions>34</SnapExtensions><SnapAngles/>' +
    '<DynamicGridEnabled>1</DynamicGridEnabled><ProtectStyles>0</ProtectStyles><ProtectShapes>0</ProtectShapes>' +
    '<ProtectMasters>0</ProtectMasters><ProtectBkgnds>0</ProtectBkgnds></DocumentSettings>' +
    '<FaceNames><FaceName NameU="Arial" UnicodeRanges="-536859905 -1073711037 9 0" CharSets="1073742335 -65536" Panose="2 11 6 4 2 2 2 2 2 4" Flags="325"/></FaceNames>' +
    '<StyleSheets>' +
    `<StyleSheet ID="0" NameU="No Style" IsCustomNameU="1" Name="No Style" IsCustomName="1">${NO_STYLE_SHEET}</StyleSheet>` +
    derived(1, 'Text Only', cell('LinePattern', 0) + cell('FillPattern', 0)) +
    derived(2, 'None', cell('LinePattern', 0) + cell('FillPattern', 0)) +
    derived(3, 'Normal', '') +
    derived(4, 'Guide', cell('LineColor', '#7f7f7f') + cell('LinePattern', 23) + cell('FillPattern', 0)) +
    '</StyleSheets>' +
    '<DocumentSheet NameU="TheDoc" IsCustomNameU="1" Name="TheDoc" IsCustomName="1" LineStyle="0" FillStyle="0" TextStyle="0">' +
    cell('OutputFormat', 0) +
    cell('LockPreview', 0) +
    cell('AddMarkup', 0) +
    cell('ViewMarkup', 0) +
    cell('DocLockReplace', 0, undefined, 'BOOL') +
    cell('NoCoauth', 0, undefined, 'BOOL') +
    cell('DocLockDuplicatePage', 0, undefined, 'BOOL') +
    cell('PreviewQuality', 0) +
    cell('PreviewScope', 0) +
    cell('DocLangID', 'en-US') +
    '</DocumentSheet></VisioDocument>'
  );
}

function pagesXml(name: string, width: number, height: number): string {
  // Zoom so the whole drawing is visible in a typical window.
  const scale = Math.max(0.2, Math.min(1, 15 / width, 8 / height));
  return (
    `${XML_HEADER}<Pages xmlns="${VISIO_NS}" xmlns:r="${REL_NS}" xml:space="preserve">` +
    `<Page ID="0" NameU="${escapeXml(name)}" Name="${escapeXml(name)}" ViewScale="${v(scale)}" ViewCenterX="${v(width / 2)}" ViewCenterY="${v(height / 2)}">` +
    '<PageSheet LineStyle="0" FillStyle="0" TextStyle="0">' +
    cell('PageWidth', width) +
    cell('PageHeight', height) +
    cell('ShdwOffsetX', 0.125) +
    cell('ShdwOffsetY', -0.125) +
    cell('PageScale', 1, undefined, 'IN_F') +
    cell('DrawingScale', 1, undefined, 'IN_F') +
    cell('DrawingSizeType', 3) +
    cell('DrawingScaleType', 0) +
    cell('InhibitSnap', 0) +
    cell('PageLockReplace', 0, undefined, 'BOOL') +
    cell('PageLockDuplicate', 0, undefined, 'BOOL') +
    cell('UIVisibility', 0) +
    cell('ShdwType', 0) +
    cell('ShdwObliqueAngle', 0) +
    cell('ShdwScaleFactor', 1) +
    cell('DrawingResizeType', 1) +
    cell('PageShapeSplit', 1) +
    // Print the whole process on a single landscape sheet.
    cell('PrintPageOrientation', 2) +
    cell('OnPage', 1) +
    cell('PagesX', 1) +
    cell('PagesY', 1) +
    '</PageSheet><Rel r:id="rId1"/></Page></Pages>'
  );
}

function rels(entries: [string, string, string][]): string {
  return (
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('') +
    '</Relationships>'
  );
}

export interface VsdxOptions {
  theme: DiagramTheme;
  /** ISO timestamp recorded in the document properties. */
  createdAt?: string;
}

export function exportVsdx(model: ProcessModel, layout: DiagramLayout, options: VsdxOptions): Uint8Array {
  const { theme } = options;
  const pageWidth = inch(layout.width);
  const pageHeight = inch(layout.height);
  const page = new PageWriter(pageHeight, theme);

  for (const ext of layout.externals) {
    page.shapeIds.set(ext.id, page.band(ext, 'External participant', theme.external.fill, 1.4));
  }
  if (model.nodes.length > 0) {
    page.band(layout.pool, 'Pool', theme.band.fill, 1.6);
    layout.lanes.forEach((lane, i) =>
      page.band(lane, 'Swimlane', i % 2 === 0 ? theme.band.fill : theme.band.alt, 1.1),
    );
  }

  // Shapes first so connectors can be glued to them; boundary events last so
  // they sit on top of the activity they are attached to.
  const laneName = new Map(model.lanes.map((lane) => [lane.id, lane.name]));
  const ordered = [...model.nodes].sort(
    (a, b) => Number(a.type === 'boundaryEvent') - Number(b.type === 'boundaryEvent'),
  );
  for (const node of ordered) {
    const box = layout.nodes[node.id];
    if (box) page.node(node, box, laneName.get(node.lane) ?? '');
  }
  for (const edge of layout.edges) page.connector(edge);

  const created = options.createdAt ?? new Date().toISOString();
  const title = escapeXml(model.name || 'Process');
  const visio = 'http://schemas.microsoft.com/visio/2010/relationships';
  const files: Record<string, string> = {
    '[Content_Types].xml':
      `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/>' +
      '<Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>' +
      '<Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>',
    '_rels/.rels': rels([
      ['rId1', `${visio}/document`, 'visio/document.xml'],
      ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
      ['rId3', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', 'docProps/app.xml'],
    ]),
    'docProps/core.xml':
      `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${title}</dc:title><dc:creator>SuperProcess</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified></cp:coreProperties>`,
    'docProps/app.xml':
      `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>SuperProcess</Application><AppVersion>16.0000</AppVersion></Properties>',
    'visio/document.xml': documentXml(),
    'visio/_rels/document.xml.rels': rels([['rId1', `${visio}/pages`, 'pages/pages.xml']]),
    'visio/pages/pages.xml': pagesXml('Process', pageWidth, pageHeight),
    'visio/pages/_rels/pages.xml.rels': rels([['rId1', `${visio}/page`, 'page1.xml']]),
    'visio/pages/page1.xml': page.xml(),
  };

  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) entries[path] = strToU8(content);
  return zipSync(entries, { level: 6 });
}
