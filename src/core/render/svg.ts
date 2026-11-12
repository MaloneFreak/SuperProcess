/**
 * Renders a laid-out process as a standalone SVG document.
 *
 * The output deliberately avoids anything that only browsers understand
 * (markers, CSS, dominant-baseline, paint-order): arrowheads are polygons and
 * text halos are separate elements. The same string is therefore safe to
 * rasterise to PNG, to embed in PDF and DOCX reports and to open in other
 * tools.
 */
import type { BandLayout, DiagramLayout, EdgeLayout, Point, TextBlock } from '../layout/layout';
import { METRICS } from '../layout/layout';
import { blockWidth } from '../layout/text';
import type { ProcessModel, ProcessNode } from '../model/types';
import { nodeGraphics, nodeRole, type Prim } from './graphics';
import type { DiagramTheme, Palette } from './theme';

export interface Highlight {
  color: string;
  /** Short text shown in a badge at the node's corner (e.g. a finding count). */
  badge?: string;
}

export interface RenderOptions {
  theme: DiagramTheme;
  /** Node id → halo, used to map report findings onto the diagram. */
  highlights?: Record<string, Highlight>;
  /** Adds `data-id` attributes and hit areas so the app can react to clicks. */
  interactive?: boolean;
  /** Paint the canvas background (off for a transparent image). */
  background?: boolean;
}

export const DIAGRAM_FONT = "Arial, Helvetica, 'Liberation Sans', sans-serif";

const num = (value: number): string => String(Math.round(value * 100) / 100);

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

interface TextStyle {
  fill: string;
  bold?: boolean;
  italic?: boolean;
  /** Colour of an outline drawn behind the glyphs to keep them legible over lines. */
  halo?: string;
}

function textElement(block: TextBlock, style: TextStyle): string {
  // Labels never intercept clicks: the shape underneath is the click target.
  const attrs =
    `text-anchor="${block.anchor}" font-size="${block.fontSize}" pointer-events="none"` +
    (style.bold ? ' font-weight="bold"' : '') +
    (style.italic ? ' font-style="italic"' : '');
  const spans = block.lines
    .map((line, i) => {
      const y = block.y + i * block.lineHeight + block.lineHeight / 2 + block.fontSize * 0.35;
      return `<tspan x="${num(block.x)}" y="${num(y)}">${escapeXml(line)}</tspan>`;
    })
    .join('');
  const halo = style.halo
    ? `<text ${attrs} fill="none" stroke="${style.halo}" stroke-width="3" stroke-linejoin="round">${spans}</text>`
    : '';
  return `${halo}<text ${attrs} fill="${style.fill}">${spans}</text>`;
}

function primElement(prim: Prim, palette: Palette, theme: DiagramTheme): string {
  const fill =
    prim.fill === 'shape' ? palette.fill : prim.fill === 'ink' ? palette.stroke : prim.fill === 'paper' ? theme.paper : 'none';
  const stroke =
    prim.sw > 0
      ? ` stroke="${prim.paperStroke ? theme.paper : palette.stroke}" stroke-width="${num(prim.sw)}" stroke-linejoin="round"` +
        (prim.dashed ? ' stroke-dasharray="4 2.5"' : '')
      : '';
  if (prim.k === 'ellipse') {
    return `<ellipse cx="${num(prim.cx)}" cy="${num(prim.cy)}" rx="${num(prim.rx)}" ry="${num(prim.ry)}" fill="${fill}"${stroke}/>`;
  }
  if (prim.k === 'rrect') {
    return `<rect x="${num(prim.x)}" y="${num(prim.y)}" width="${num(prim.w)}" height="${num(prim.h)}" rx="${num(prim.r)}" fill="${fill}"${stroke}/>`;
  }
  const points = prim.pts.map(([x, y]) => `${num(x)},${num(y)}`).join(' ');
  return prim.closed
    ? `<polygon points="${points}" fill="${fill}"${stroke}/>`
    : `<polyline points="${points}" fill="none"${stroke} stroke-linecap="round"/>`;
}

function bandElements(band: BandLayout, theme: DiagramTheme, fill: string, strokeWidth: number): string {
  const { x, y, width, height, headerWidth } = band;
  let out = `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" fill="${fill}" stroke="${theme.band.stroke}" stroke-width="${strokeWidth}"/>`;
  if (headerWidth > 0) {
    out += `<rect x="${num(x)}" y="${num(y)}" width="${num(headerWidth)}" height="${num(height)}" fill="${theme.band.header}" stroke="${theme.band.stroke}" stroke-width="${strokeWidth}"/>`;
    const cx = x + headerWidth / 2;
    const cy = y + height / 2;
    band.labelLines.forEach((line, i) => {
      const offset = (i - (band.labelLines.length - 1) / 2) * METRICS.bandLine;
      out +=
        `<text transform="translate(${num(cx + offset + METRICS.bandFont * 0.35)} ${num(cy)}) rotate(-90)" ` +
        `text-anchor="middle" font-size="${METRICS.bandFont}" font-weight="bold" fill="${theme.band.text}">${escapeXml(line)}</text>`;
    });
  }
  return out;
}

/** An orthogonal polyline with softly rounded corners. */
function roundedPath(points: Point[], radius: number): string {
  let d = `M${num(points[0].x)} ${num(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const d1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const d2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r < 0.5) {
      d += ` L${num(cur.x)} ${num(cur.y)}`;
      continue;
    }
    const ax = cur.x + ((prev.x - cur.x) / d1) * r;
    const ay = cur.y + ((prev.y - cur.y) / d1) * r;
    const bx = cur.x + ((next.x - cur.x) / d2) * r;
    const by = cur.y + ((next.y - cur.y) / d2) * r;
    d += ` L${num(ax)} ${num(ay)} Q${num(cur.x)} ${num(cur.y)} ${num(bx)} ${num(by)}`;
  }
  const last = points[points.length - 1];
  return `${d} L${num(last.x)} ${num(last.y)}`;
}

function unit(from: Point, to: Point): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}

function edgeElements(edge: EdgeLayout, theme: DiagramTheme): string {
  const pts = edge.points;
  if (pts.length < 2) return '';
  const message = edge.kind === 'message';
  const color = message ? theme.message : theme.flow;
  const tip = pts[pts.length - 1];
  const dirEnd = unit(pts[pts.length - 2], tip);
  const dirStart = unit(pts[0], pts[1]);

  // The line stops at the arrow's base so its square end never shows past the tip.
  const headLength = message ? 9 : 9.5;
  const headHalf = message ? 4.2 : 4;
  const base = { x: tip.x - dirEnd.x * headLength, y: tip.y - dirEnd.y * headLength };
  const path = [...pts.slice(0, -1), { x: tip.x - dirEnd.x * (headLength - 1), y: tip.y - dirEnd.y * (headLength - 1) }];
  if (message) path[0] = { x: pts[0].x + dirStart.x * 6.4, y: pts[0].y + dirStart.y * 6.4 };

  let out =
    `<path d="${roundedPath(path, 7)}" fill="none" stroke="${color}" stroke-width="1.5"` +
    (message ? ' stroke-dasharray="6 4"' : '') +
    ' stroke-linejoin="round"/>';

  const left = { x: base.x - dirEnd.y * headHalf, y: base.y + dirEnd.x * headHalf };
  const right = { x: base.x + dirEnd.y * headHalf, y: base.y - dirEnd.x * headHalf };
  out +=
    `<polygon points="${num(tip.x)},${num(tip.y)} ${num(left.x)},${num(left.y)} ${num(right.x)},${num(right.y)}" ` +
    (message
      ? `fill="${theme.paper}" stroke="${color}" stroke-width="1.3" stroke-linejoin="round"/>`
      : `fill="${color}" stroke="${color}" stroke-width="1" stroke-linejoin="round"/>`);

  if (message) {
    out += `<circle cx="${num(pts[0].x + dirStart.x * 3.2)}" cy="${num(pts[0].y + dirStart.y * 3.2)}" r="3.2" fill="${theme.paper}" stroke="${color}" stroke-width="1.3"/>`;
  }
  if (edge.isDefault) {
    // BPMN default-flow marker: a short slash across the line near its source.
    // Flows that leave a gateway corner share their first stretch with their
    // siblings, so the marker goes just after the first bend instead.
    const shared = pts.length > 2 && pts[0].x === pts[1].x;
    const origin = shared ? pts[1] : pts[0];
    const dir = shared ? unit(pts[1], pts[2]) : dirStart;
    const mid = { x: origin.x + dir.x * 10, y: origin.y + dir.y * 10 };
    const slash = { x: dir.x * 3 + dir.y * 5, y: dir.y * 3 - dir.x * 5 };
    out += `<line x1="${num(mid.x - slash.x)}" y1="${num(mid.y - slash.y)}" x2="${num(mid.x + slash.x)}" y2="${num(mid.y + slash.y)}" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`;
  }
  return out;
}

function nodeElements(
  node: ProcessNode,
  layout: DiagramLayout,
  options: RenderOptions,
): { shape: string; label: string; badge: string } {
  const box = layout.nodes[node.id];
  if (!box) return { shape: '', label: '', badge: '' };
  const { theme } = options;
  const palette = theme.roles[nodeRole(node)];
  const graphics = nodeGraphics(node, box.width, box.height);
  const highlight = options.highlights?.[node.id];

  let inner = '';
  if (highlight) {
    const pad = 5;
    const round = nodeRole(node) === 'task' ? 14 : Math.max(box.width, box.height);
    inner += `<rect x="${-pad}" y="${-pad}" width="${num(box.width + pad * 2)}" height="${num(box.height + pad * 2)}" rx="${round}" fill="${highlight.color}" fill-opacity="0.22" stroke="${highlight.color}" stroke-width="2"/>`;
  }
  inner += primElement(graphics.outline, palette, theme);
  for (const prim of graphics.decor) inner += primElement(prim, palette, theme);
  if (options.interactive) {
    inner += `<rect x="-4" y="-4" width="${num(box.width + 8)}" height="${num(box.height + 8)}" fill="#000" fill-opacity="0" pointer-events="all"/>`;
  }

  const attrs = options.interactive ? ` class="sp-node" data-id="${escapeXml(node.id)}"` : '';
  const title = options.interactive && node.name ? `<title>${escapeXml(node.name)}</title>` : '';
  const shape = `<g${attrs} transform="translate(${num(box.x)} ${num(box.y)})">${title}${inner}</g>`;

  let label = '';
  if (box.label) {
    const inside = nodeRole(node) === 'task';
    label = textElement(box.label, { fill: theme.text, halo: inside ? undefined : theme.band.fill });
  }

  let badge = '';
  if (highlight?.badge) {
    const bx = box.x + box.width + 1;
    const by = box.y - 1;
    const text = escapeXml(highlight.badge);
    const width = Math.max(18, 10 + highlight.badge.length * 6);
    badge =
      `<rect x="${num(bx - width / 2)}" y="${num(by - 9)}" width="${width}" height="18" rx="9" fill="${highlight.color}" stroke="${theme.band.fill}" stroke-width="1.5"/>` +
      `<text x="${num(bx)}" y="${num(by + 3.8)}" text-anchor="middle" font-size="11" font-weight="bold" fill="#ffffff">${text}</text>`;
  }
  return { shape, label, badge };
}

export function renderSvg(model: ProcessModel, layout: DiagramLayout, options: RenderOptions): string {
  const { theme } = options;
  const parts: string[] = [];

  if (options.background !== false) {
    parts.push(`<rect width="${layout.width}" height="${layout.height}" fill="${theme.background}"/>`);
  }

  for (const ext of layout.externals) {
    parts.push(
      `<rect x="${num(ext.x)}" y="${num(ext.y)}" width="${num(ext.width)}" height="${num(ext.height)}" fill="${theme.external.fill}" stroke="${theme.external.stroke}" stroke-width="1.4"/>`,
    );
    const height = ext.labelLines.length * METRICS.bandLine;
    const centre = ext.x + ext.width / 2 + (ext.labelOffset ?? 0);
    const name = textElement(
      {
        lines: ext.labelLines,
        x: centre,
        y: ext.y + (ext.height - height) / 2,
        anchor: 'middle',
        fontSize: METRICS.bandFont,
        lineHeight: METRICS.bandLine,
        width: 0,
        height,
      },
      { fill: theme.band.text, bold: true },
    );
    // On screen the name of a wide pool follows the part of it that is in view;
    // the viewer needs to know how far it may move.
    parts.push(
      options.interactive
        ? `<g class="sp-band-name" data-x="${num(ext.x)}" data-width="${num(ext.width)}" data-centre="${num(centre)}" data-name-width="${num(blockWidth(ext.labelLines, METRICS.bandFont, true))}">${name}</g>`
        : name,
    );
  }

  if (layout.lanes.length > 0 || model.nodes.length > 0) {
    parts.push(bandElements(layout.pool, theme, theme.band.fill, 1.4));
    layout.lanes.forEach((lane, i) => {
      parts.push(bandElements(lane, theme, i % 2 === 0 ? theme.band.fill : theme.band.alt, 1.1));
    });
    // Redraw the pool outline so lane fills do not thin it.
    const p = layout.pool;
    parts.push(
      `<rect x="${num(p.x)}" y="${num(p.y)}" width="${num(p.width)}" height="${num(p.height)}" fill="none" stroke="${theme.band.stroke}" stroke-width="1.6"/>`,
    );
  }

  for (const edge of layout.edges) parts.push(edgeElements(edge, theme));

  const labels: string[] = [];
  const badges: string[] = [];
  // Boundary events are drawn after their host so they sit on top of its border.
  const ordered = [...model.nodes].sort(
    (a, b) => Number(a.type === 'boundaryEvent') - Number(b.type === 'boundaryEvent'),
  );
  for (const node of ordered) {
    const drawn = nodeElements(node, layout, options);
    parts.push(drawn.shape);
    labels.push(drawn.label);
    badges.push(drawn.badge);
  }
  parts.push(...labels);

  for (const edge of layout.edges) {
    if (!edge.label) continue;
    parts.push(
      textElement(edge.label, {
        fill: edge.kind === 'message' ? theme.message : theme.text,
        italic: edge.kind === 'message',
        halo: theme.band.fill,
      }),
    );
  }
  parts.push(...badges);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" ` +
    `viewBox="0 0 ${layout.width} ${layout.height}" font-family="${DIAGRAM_FONT}">` +
    parts.join('') +
    '</svg>'
  );
}
