/**
 * Reads a diagrams.net / draw.io file (.drawio, .xml) into a diagram sketch.
 * Handles both plain and compressed (deflate + base64) diagram pages.
 */
import { inflateSync, strFromU8 } from 'fflate';
import { children, clean, descendants, htmlToText, parseXml } from './xml';
import type { DiagramSketch, SketchPage, SketchShape } from './vsdx';

interface Cell {
  id: string;
  parent: string;
  value: string;
  style: string;
  vertex: boolean;
  edge: boolean;
  source: string;
  target: string;
  x: number;
  y: number;
  w: number;
  h: number;
  props: Record<string, string>;
}

function styleValue(style: string, key: string): string | undefined {
  const match = style.match(new RegExp(`(?:^|;)${key}=([^;]*)`));
  return match?.[1];
}

function guessKind(style: string): string {
  const shape = styleValue(style, 'shape') ?? '';
  if (/swimlane/.test(style) || /swimlane|pool/.test(shape)) return 'container';
  if (/bpmn\.gateway|rhombus/.test(shape + style)) return 'gateway';
  if (/bpmn\.event/.test(shape)) {
    const outline = styleValue(style, 'outline');
    if (outline === 'standard') return 'startEvent';
    if (outline === 'end') return 'endEvent';
    return 'intermediateEvent';
  }
  if (/bpmn\.task|bpmn\.shape/.test(shape)) return styleValue(style, 'isLoopSub') === '1' ? 'subProcess' : 'task';
  if (/ellipse|terminator|startState|endState/.test(style)) return 'event';
  if (/document|cylinder|datastore|data2|note/.test(shape + style)) return /note/.test(shape + style) ? 'note' : 'data';
  if (/^text;|;text;/.test(style) || style.startsWith('text')) return 'note';
  if (/process|rounded=1|rect/.test(shape + style) || style === '' || /whiteSpace=wrap/.test(style)) return 'task';
  return 'shape';
}

/** draw.io stores a page either as XML or as URL-encoded, deflated, base64 text. */
function pageModel(diagram: Element): Element | undefined {
  const direct = children(diagram, 'mxGraphModel')[0];
  if (direct) return direct;
  const packed = clean(diagram.textContent);
  if (!packed) return undefined;
  const binary = atob(packed);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const xml = decodeURIComponent(strFromU8(inflateSync(bytes)));
  return parseXml(xml).documentElement;
}

function readPage(model: Element): Omit<SketchPage, 'name'> {
  const cells = new Map<string, Cell>();
  for (const element of descendants(model, 'mxCell')) {
    // <object>/<UserObject> wrappers carry the id, label and custom data.
    const wrapper = element.parentElement && /^(object|UserObject)$/.test(element.parentElement.localName) ? element.parentElement : null;
    const geometry = children(element, 'mxGeometry')[0];
    const props: Record<string, string> = {};
    if (wrapper) {
      for (const attr of Array.from(wrapper.attributes)) {
        if (!['id', 'label', 'placeholders', 'tooltip'].includes(attr.name) && attr.value) props[attr.name] = attr.value.slice(0, 200);
      }
    }
    const id = wrapper?.getAttribute('id') ?? element.getAttribute('id') ?? '';
    cells.set(id, {
      id,
      parent: element.getAttribute('parent') ?? '',
      value: clean(htmlToText(wrapper?.getAttribute('label') ?? element.getAttribute('value') ?? '')),
      style: element.getAttribute('style') ?? '',
      vertex: element.getAttribute('vertex') === '1',
      edge: element.getAttribute('edge') === '1',
      source: element.getAttribute('source') ?? '',
      target: element.getAttribute('target') ?? '',
      x: Number(geometry?.getAttribute('x') ?? 0) || 0,
      y: Number(geometry?.getAttribute('y') ?? 0) || 0,
      w: Number(geometry?.getAttribute('width') ?? 0) || 0,
      h: Number(geometry?.getAttribute('height') ?? 0) || 0,
      props,
    });
  }

  const absolute = (cell: Cell): { x: number; y: number } => {
    let x = cell.x;
    let y = cell.y;
    for (let parent = cells.get(cell.parent), guard = 0; parent && guard < 50; parent = cells.get(parent.parent), guard++) {
      if (parent.vertex) {
        x += parent.x;
        y += parent.y;
      }
    }
    return { x, y };
  };

  const vertices = [...cells.values()].filter((c) => c.vertex && !c.style.includes('edgeLabel'));
  const containers = vertices.filter((c) => guessKind(c.style) === 'container');
  const containerIds = new Set(containers.map((c) => c.id));
  const containerPath = (cell: Cell): string => {
    const names: string[] = [];
    for (let parent = cells.get(cell.parent), guard = 0; parent && guard < 50; parent = cells.get(parent.parent), guard++) {
      if (containerIds.has(parent.id) && parent.value) names.unshift(parent.value);
    }
    if (names.length > 0) return names.join(' / ');
    // Not nested: fall back to geometry.
    const { x, y } = absolute(cell);
    const cx = x + cell.w / 2;
    const cy = y + cell.h / 2;
    return containers
      .filter((c) => {
        const p = absolute(c);
        return c.id !== cell.id && cx >= p.x && cx <= p.x + c.w && cy >= p.y && cy <= p.y + c.h;
      })
      .sort((a, b) => b.w * b.h - a.w * a.h)
      .map((c) => c.value)
      .filter(Boolean)
      .join(' / ');
  };

  // An edge can be attached to a child (e.g. a boundary event icon): keep the cell itself.
  const edges = [...cells.values()].filter((c) => c.edge);
  const edgeLabels = new Map<string, string>();
  for (const cell of cells.values()) {
    if (cell.vertex && cell.style.includes('edgeLabel') && cell.value) {
      edgeLabels.set(cell.parent, [edgeLabels.get(cell.parent), cell.value].filter(Boolean).join(' '));
    }
  }
  const connected = new Set(edges.flatMap((e) => [e.source, e.target]));

  const shapes: SketchShape[] = [];
  const notes: string[] = [];
  for (const cell of vertices) {
    if (containerIds.has(cell.id)) continue;
    const kind = guessKind(cell.style);
    if (!cell.value && !connected.has(cell.id)) continue;
    if (kind === 'note' && !connected.has(cell.id)) {
      if (cell.value) notes.push(cell.value);
      continue;
    }
    const { x, y } = absolute(cell);
    const shape = styleValue(cell.style, 'shape');
    const marker = styleValue(cell.style, 'taskMarker') ?? styleValue(cell.style, 'symbol') ?? styleValue(cell.style, 'gwType');
    shapes.push({
      id: cell.id,
      kind,
      stencil: [shape, marker].filter((part) => part && part !== 'general' && part !== 'none').join(' '),
      text: cell.value,
      container: containerPath(cell),
      x: Math.round(x + cell.w / 2),
      y: Math.round(y + cell.h / 2),
      ...(Object.keys(cell.props).length > 0 ? { props: cell.props } : {}),
    });
  }
  shapes.sort((a, b) => a.x - b.x || a.y - b.y);
  const known = new Set(shapes.map((s) => s.id));

  return {
    containers: containers.map((c) => {
      const parent = cells.get(c.parent);
      return {
        id: c.id,
        label: c.value,
        kind: parent && containerIds.has(parent.id) ? 'lane' : containers.some((o) => o.parent === c.id) ? 'pool' : 'lane',
        ...(parent && containerIds.has(parent.id) ? { parent: parent.id } : {}),
      };
    }),
    shapes,
    connections: edges
      .filter((e) => known.has(e.source) && known.has(e.target) && e.source !== e.target)
      .map((e) => ({
        from: e.source,
        to: e.target,
        label: [e.value, edgeLabels.get(e.id)].filter(Boolean).join(' ') || undefined,
        kind: e.style.includes('dashed=1') ? ('message' as const) : ('sequence' as const),
      })),
    notes,
  };
}

export function importDrawio(source: string): DiagramSketch {
  const root = parseXml(source).documentElement;
  const pages: SketchPage[] = [];
  if (root.localName === 'mxGraphModel') {
    pages.push({ name: 'Page-1', ...readPage(root) });
  } else if (root.localName === 'mxfile') {
    for (const diagram of children(root, 'diagram')) {
      const model = pageModel(diagram);
      if (!model) continue;
      const page = readPage(model);
      if (page.shapes.length > 0 || page.notes.length > 0) {
        pages.push({ name: diagram.getAttribute('name') ?? `Page-${pages.length + 1}`, ...page });
      }
    }
  } else {
    throw new Error('Not a draw.io file.');
  }
  if (pages.length === 0) throw new Error('No shapes with text were found in this draw.io file.');
  return { format: 'drawio', pages };
}
