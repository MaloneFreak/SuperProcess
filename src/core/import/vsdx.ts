/**
 * Reads a Microsoft Visio drawing (.vsdx / .vsdm) into a diagram sketch:
 * which shapes exist, what they say, which stencil they come from, which
 * swimlane they sit in and how they are connected.
 *
 * Visio files rarely carry BPMN semantics (most process maps are drawn with
 * the basic or cross-functional flowchart stencils), so the sketch keeps the
 * raw evidence and a best-guess kind for each shape. The AI turns that into a
 * proper BPMN model.
 */
import { strFromU8, unzipSync } from 'fflate';
import { child, children, clean, parseXml } from './xml';

export interface SketchShape {
  id: string;
  /** Best guess: task, gateway, startEvent, endEvent, event, subProcess, data, shape. */
  kind: string;
  /** Name of the stencil master or shape style the shape was drawn with. */
  stencil: string;
  text: string;
  /** Label path of the swimlane(s) the shape sits in, outermost first. */
  container: string;
  /** Position of the shape centre from the top-left of the page. */
  x: number;
  y: number;
  props?: Record<string, string>;
}

export interface SketchPage {
  name: string;
  containers: { id: string; label: string; kind: string; parent?: string }[];
  shapes: SketchShape[];
  connections: { from: string; to: string; label?: string; kind: 'sequence' | 'message' | 'association' }[];
  notes: string[];
}

export interface DiagramSketch {
  format: 'visio' | 'drawio';
  pages: SketchPage[];
}

interface Master {
  name: string;
  shapes: Map<string, Element>;
  top?: Element;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Entity {
  id: string;
  element: Element;
  inherited?: Element;
  stencil: string;
  text: string;
  box: Rect;
  oneD: boolean;
  begin?: { x: number; y: number };
  end?: { x: number; y: number };
  props: Record<string, string>;
  container: boolean;
}

const CONTAINER_RE = /swimlane|swim lane|pool|\blane\b|cff container|functional band|container/i;
const CONNECTOR_RE = /connector|sequence flow|message flow|association|\bflow\b|\bline\b|\barrow\b/i;
const NOISE_VALUES = new Set(['', 'none', 'false', 'no', '0', 'unspecified', 'standard']);

function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const part of target.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return parts.join('/');
}

function relsOf(files: Record<string, Uint8Array>, part: string): Map<string, string> {
  const slash = part.lastIndexOf('/');
  const relPath = `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
  const map = new Map<string, string>();
  const data = files[relPath];
  if (!data) return map;
  for (const rel of children(parseXml(strFromU8(data)).documentElement, 'Relationship')) {
    map.set(rel.getAttribute('Id') ?? '', resolvePath(part, rel.getAttribute('Target') ?? ''));
  }
  return map;
}

function relId(element: Element | undefined): string {
  if (!element) return '';
  for (const attr of Array.from(element.attributes)) if (attr.localName === 'id') return attr.value;
  return '';
}

function cellOf(element: Element | undefined, name: string): string | undefined {
  if (!element) return undefined;
  for (const cell of children(element, 'Cell')) if (cell.getAttribute('N') === name) return cell.getAttribute('V') ?? undefined;
  return undefined;
}

function sectionRows(element: Element | undefined, section: string): Element[] {
  if (!element) return [];
  const found = children(element, 'Section').find((s) => s.getAttribute('N') === section);
  return found ? children(found, 'Row') : [];
}

function ownText(element: Element): string {
  return clean(child(element, 'Text')?.textContent);
}

function allTexts(element: Element): string[] {
  const texts: string[] = [];
  const visit = (shape: Element): void => {
    const text = ownText(shape);
    if (text) texts.push(text);
    for (const group of children(shape, 'Shapes')) for (const inner of children(group, 'Shape')) visit(inner);
  };
  visit(element);
  return texts;
}

function distanceToRect(point: { x: number; y: number }, rect: Rect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.w));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

function guessKind(stencil: string, props: Record<string, string>): string {
  const name = stencil.toLowerCase();
  const hint = Object.values(props).join(' ').toLowerCase();
  if (/participant|external/.test(name)) return 'external';
  if (/gateway|decision|diamond/.test(name)) return 'gateway';
  if (/start event|^start$/.test(name)) return 'startEvent';
  if (/end event|^end$/.test(name)) return 'endEvent';
  if (/intermediate/.test(name)) return 'intermediateEvent';
  if (/event|terminator|start\/end/.test(name)) return /\bend\b/.test(hint) ? 'endEvent' : /\bstart\b/.test(hint) ? 'startEvent' : 'event';
  if (/sub-?process|predefined/.test(name)) return 'subProcess';
  if (/task|process|activity|step|action|rectangle/.test(name)) return 'task';
  if (/document|data|database|stored|file/.test(name)) return 'data';
  if (/annotation|callout|note|comment|title|text/.test(name)) return 'note';
  return 'shape';
}

function readPage(pageDoc: Document, masters: Map<string, Master>, pageHeight: number): Omit<SketchPage, 'name'> {
  const entities: Entity[] = [];
  const topOf = new Map<string, string>();
  const number = (value: string | undefined): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const visit = (shape: Element, origin: { x: number; y: number }, context: Master | undefined, owner?: string): void => {
    const id = shape.getAttribute('ID') ?? '';
    const masterId = shape.getAttribute('Master');
    const master = masterId ? masters.get(masterId) : context;
    const inherited = masterId ? master?.top : master?.shapes.get(shape.getAttribute('MasterShape') ?? '');
    const get = (name: string): string | undefined => cellOf(shape, name) ?? cellOf(inherited, name);

    const w = number(get('Width'));
    const h = number(get('Height'));
    const x = origin.x + number(get('PinX')) - number(get('LocPinX') ?? String(w / 2));
    const y = origin.y + number(get('PinY')) - number(get('LocPinY') ?? String(h / 2));
    const inner = children(shape, 'Shapes').flatMap((group) => children(group, 'Shape'));

    if (owner) {
      topOf.set(id, owner);
      for (const sub of inner) visit(sub, { x, y }, master, owner);
      return;
    }

    // A plain user-made group (no stencil, no name, no text of its own) is
    // transparent: its members are the real shapes.
    const isPlainGroup =
      shape.getAttribute('Type') === 'Group' &&
      !masterId &&
      !shape.getAttribute('NameU') &&
      !ownText(shape) &&
      inner.length > 0;
    if (isPlainGroup) {
      for (const sub of inner) visit(sub, { x, y }, undefined);
      return;
    }

    topOf.set(id, id);
    for (const sub of inner) visit(sub, { x, y }, master, id);

    const props: Record<string, string> = {};
    for (const source of [inherited, shape]) {
      for (const row of sectionRows(source, 'Property')) {
        const key = row.getAttribute('N') ?? '';
        const value = clean(cellOf(row, 'Value'));
        if (!key) continue;
        if (NOISE_VALUES.has(value.toLowerCase())) delete props[key];
        else if (value.length <= 200) props[key] = value;
      }
    }
    const structure = [inherited, shape]
      .flatMap((source) => sectionRows(source, 'User'))
      .filter((row) => row.getAttribute('N') === 'msvStructureType')
      .map((row) => cellOf(row, 'Value'))
      .pop();

    const stencil = (master?.name ?? shape.getAttribute('NameU') ?? shape.getAttribute('Name') ?? '').replace(/\.\d+$/, '');
    const beginX = get('BeginX');
    const endX = get('EndX');
    const texts = allTexts(shape);
    entities.push({
      id,
      element: shape,
      inherited,
      stencil,
      text: ownText(shape) || texts.join(' / '),
      box: { x, y, w, h },
      oneD: beginX !== undefined && endX !== undefined,
      begin: beginX !== undefined ? { x: number(beginX), y: number(get('BeginY')) } : undefined,
      end: endX !== undefined ? { x: number(endX), y: number(get('EndY')) } : undefined,
      props,
      container: structure === 'Container' || CONTAINER_RE.test(stencil),
    });
  };

  const shapesRoot = child(pageDoc.documentElement, 'Shapes');
  for (const shape of shapesRoot ? children(shapesRoot, 'Shape') : []) visit(shape, { x: 0, y: 0 }, undefined);

  // Glue information: which shape each connector end is attached to.
  const glued = new Map<string, { from?: string; to?: string }>();
  const connectsRoot = child(pageDoc.documentElement, 'Connects');
  for (const connect of connectsRoot ? children(connectsRoot, 'Connect') : []) {
    const connector = topOf.get(connect.getAttribute('FromSheet') ?? '') ?? '';
    const target = topOf.get(connect.getAttribute('ToSheet') ?? '') ?? '';
    if (!connector || !target) continue;
    const entry = glued.get(connector) ?? {};
    const fromCell = connect.getAttribute('FromCell') ?? '';
    if (fromCell.startsWith('Begin')) entry.from = target;
    else if (fromCell.startsWith('End')) entry.to = target;
    glued.set(connector, entry);
  }

  const isConnector = (e: Entity): boolean => glued.has(e.id) || e.oneD || CONNECTOR_RE.test(e.stencil);
  const containers = entities.filter((e) => e.container && !isConnector(e));
  const connectors = entities.filter((e) => !e.container && isConnector(e));
  const plain = entities.filter((e) => !e.container && !isConnector(e));

  const area = (rect: Rect): number => rect.w * rect.h;
  const containerLabel = new Map(containers.map((c) => [c.id, c.text || c.stencil]));
  const enclosing = (rect: Rect, self?: string): Entity[] => {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    return containers
      .filter((c) => c.id !== self && cx >= c.box.x && cx <= c.box.x + c.box.w && cy >= c.box.y && cy <= c.box.y + c.box.h)
      .filter((c) => !self || area(c.box) > area(rect))
      .sort((a, b) => area(b.box) - area(a.box));
  };

  const round = (value: number): number => Math.round(value * 10) / 10;
  const shapes: SketchShape[] = [];
  const notes: string[] = [];
  const connected = new Set<string>();
  const connections: SketchPage['connections'] = [];

  const nodeLike = plain.filter((e) => e.text || guessKind(e.stencil, e.props) !== 'shape');
  for (const connector of connectors) {
    const ends = glued.get(connector.id) ?? {};
    const nearest = (point?: { x: number; y: number }): string | undefined => {
      if (!point) return undefined;
      let best: { id: string; distance: number } | undefined;
      for (const candidate of nodeLike) {
        const distance = distanceToRect(point, candidate.box);
        if (distance <= 0.2 && (!best || distance < best.distance)) best = { id: candidate.id, distance };
      }
      return best?.id;
    };
    let from = ends.from ?? nearest(connector.begin);
    let to = ends.to ?? nearest(connector.end);
    if (!from || !to || from === to) continue;
    // An arrowhead only at the beginning means the line was drawn backwards.
    const beginArrow = Number(cellOf(connector.element, 'BeginArrow') ?? '0');
    const endArrow = cellOf(connector.element, 'EndArrow');
    if (beginArrow > 0 && endArrow === '0') [from, to] = [to, from];
    const name = connector.stencil.toLowerCase();
    connections.push({
      from: `s${from}`,
      to: `s${to}`,
      label: connector.text || undefined,
      kind: name.includes('message') ? 'message' : name.includes('association') ? 'association' : 'sequence',
    });
    connected.add(from);
    connected.add(to);
  }

  for (const entity of nodeLike) {
    const kind = guessKind(entity.stencil, entity.props);
    if (!entity.text && !connected.has(entity.id)) continue;
    if (kind === 'note' && !connected.has(entity.id)) {
      if (entity.text) notes.push(entity.text);
      continue;
    }
    const path = enclosing(entity.box)
      .map((c) => containerLabel.get(c.id) ?? '')
      .filter(Boolean);
    shapes.push({
      id: `s${entity.id}`,
      kind,
      stencil: entity.stencil,
      text: entity.text,
      container: path.join(' / '),
      x: round(entity.box.x + entity.box.w / 2),
      y: round(pageHeight - (entity.box.y + entity.box.h / 2)),
      ...(Object.keys(entity.props).length > 0 ? { props: entity.props } : {}),
    });
  }
  shapes.sort((a, b) => a.x - b.x || a.y - b.y);

  // A container that holds other containers is a pool; everything else is a lane.
  const parentOf = new Map(containers.map((c) => [c.id, enclosing(c.box, c.id).pop()?.id]));
  const hasChildren = new Set([...parentOf.values()].filter(Boolean));
  return {
    containers: containers.map((c) => {
      const parent = parentOf.get(c.id);
      return {
        id: `c${c.id}`,
        label: containerLabel.get(c.id) ?? '',
        kind: !parent && hasChildren.has(c.id) ? 'pool' : 'lane',
        ...(parent ? { parent: `c${parent}` } : {}),
      };
    }),
    shapes,
    connections,
    notes,
  };
}

export function importVsdx(bytes: Uint8Array): DiagramSketch {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (file) => /\.(xml|rels)$/i.test(file.name) });
  } catch {
    throw new Error('This file is not a .vsdx drawing. Older .vsd files must be saved as .vsdx in Visio first.');
  }
  const pagesPath = 'visio/pages/pages.xml';
  if (!files[pagesPath]) throw new Error('This file is not a Visio drawing (no pages found).');

  const masters = new Map<string, Master>();
  const mastersPath = 'visio/masters/masters.xml';
  if (files[mastersPath]) {
    const rels = relsOf(files, mastersPath);
    for (const master of children(parseXml(strFromU8(files[mastersPath])).documentElement, 'Master')) {
      const info: Master = { name: master.getAttribute('NameU') ?? master.getAttribute('Name') ?? '', shapes: new Map() };
      const part = files[rels.get(relId(child(master, 'Rel'))) ?? ''];
      if (part) {
        const index = (shape: Element): void => {
          info.shapes.set(shape.getAttribute('ID') ?? '', shape);
          for (const group of children(shape, 'Shapes')) for (const inner of children(group, 'Shape')) index(inner);
        };
        const root = child(parseXml(strFromU8(part)).documentElement, 'Shapes');
        const tops = root ? children(root, 'Shape') : [];
        tops.forEach(index);
        info.top = tops[0];
      }
      masters.set(master.getAttribute('ID') ?? '', info);
    }
  }

  const rels = relsOf(files, pagesPath);
  const pages: SketchPage[] = [];
  for (const page of children(parseXml(strFromU8(files[pagesPath])).documentElement, 'Page')) {
    if (page.getAttribute('Background') === '1') continue;
    const part = files[rels.get(relId(child(page, 'Rel'))) ?? ''];
    if (!part) continue;
    const height = Number(cellOf(child(page, 'PageSheet'), 'PageHeight') ?? '0') || 0;
    const content = readPage(parseXml(strFromU8(part)), masters, height);
    if (content.shapes.length === 0 && content.notes.length === 0) continue;
    pages.push({ name: page.getAttribute('Name') ?? page.getAttribute('NameU') ?? `Page ${pages.length + 1}`, ...content });
  }
  if (pages.length === 0) throw new Error('No shapes with text were found in this Visio drawing.');
  return { format: 'visio', pages };
}
