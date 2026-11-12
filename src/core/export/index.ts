/** One entry point for every file the app can save. */
import { strToU8, zipSync } from 'fflate';
import type { TFunction } from 'i18next';
import type { DiagramLayout } from '../layout/layout';
import type { ProcessModel } from '../model/types';
import { buildReportDocument, findingHighlights, toHtml, toMarkdown } from '../report/document';
import type { Report } from '../report/types';
import { renderSvg } from '../render/svg';
import { getTheme, type DiagramStyle } from '../render/theme';
import { exportBpmn } from './bpmn';
import { exportDrawio } from './drawio';
import { exportVsdx } from './vsdx';

export type DiagramFormat = 'vsdx' | 'bpmn' | 'drawio' | 'svg' | 'png' | 'pdf';
export type ReportFormat = 'docx' | 'pdf' | 'html' | 'md';

export interface ExportedFile {
  blob: Blob;
  fileName: string;
}

const MIME: Record<DiagramFormat | ReportFormat, string> = {
  vsdx: 'application/vnd.ms-visio.drawing',
  bpmn: 'application/xml',
  drawio: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html',
  md: 'text/markdown',
};

function fileStem(name: string, fallback: string): string {
  const clean = name
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (clean || fallback).slice(0, 100);
}

export async function exportDiagram(
  format: DiagramFormat,
  model: ProcessModel,
  layout: DiagramLayout,
  style: DiagramStyle,
): Promise<ExportedFile> {
  // Files always use the light palette: they end up on white pages.
  const theme = getTheme(style, false);
  const fileName = `${fileStem(model.name, 'process')}.${format}`;
  const text = (content: string): ExportedFile => ({ blob: new Blob([content], { type: MIME[format] }), fileName });

  switch (format) {
    case 'vsdx':
      return { blob: new Blob([exportVsdx(model, layout, { theme }) as BlobPart], { type: MIME.vsdx }), fileName };
    case 'bpmn':
      return text(exportBpmn(model, layout));
    case 'drawio':
      return text(exportDrawio(model, layout, theme));
    case 'svg':
      return text(renderSvg(model, layout, { theme }));
    case 'png': {
      const { svgToPng } = await import('./raster');
      return { blob: (await svgToPng(renderSvg(model, layout, { theme }), 2)).blob, fileName };
    }
    case 'pdf': {
      const [{ svgToPng }, { diagramToPdf }] = await Promise.all([import('./raster'), import('./pdf')]);
      const image = await svgToPng(renderSvg(model, layout, { theme }), 3);
      return { blob: await diagramToPdf(image.blob, image.width, image.height, model.name), fileName };
    }
  }
}

export async function exportReport(
  format: ReportFormat,
  report: Report,
  model: ProcessModel,
  layout: DiagramLayout,
  style: DiagramStyle,
  focusName: string,
  t: TFunction,
): Promise<ExportedFile> {
  const doc = buildReportDocument(report, model, focusName, t);
  const svg = renderSvg(model, layout, { theme: getTheme(style, false), highlights: findingHighlights(report) });
  const fileName = `${fileStem(`${model.name} - ${focusName}`, 'report')}.${format}`;

  if (format === 'md') return { blob: new Blob([toMarkdown(doc)], { type: MIME.md }), fileName };
  if (format === 'html') {
    // Let the map scale with the page instead of keeping its pixel size.
    const fluid = svg.replace(/^<svg ([^>]*?)width="[\d.]+" height="[\d.]+"/, '<svg $1');
    return { blob: new Blob([toHtml(doc, fluid)], { type: MIME.html }), fileName };
  }
  const { svgToPng } = await import('./raster');
  const image = await svgToPng(svg, 2.5);
  const diagram = { png: image.blob, width: image.width, height: image.height };
  if (format === 'docx') {
    const { reportToDocx } = await import('./docx');
    return { blob: await reportToDocx(doc, diagram), fileName };
  }
  const { reportToPdf } = await import('./pdf');
  return { blob: await reportToPdf(doc, diagram), fileName };
}

/** Bundles files into one ZIP, renaming duplicates. */
export async function zipFiles(files: ExportedFile[]): Promise<Blob> {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    let name = file.fileName;
    for (let n = 2; name in entries; n++) name = file.fileName.replace(/(\.[^.]+)?$/, ` (${n})$1`);
    entries[name] = file.blob.type.startsWith('text/') ? strToU8(await file.blob.text()) : new Uint8Array(await file.blob.arrayBuffer());
  }
  return new Blob([zipSync(entries, { level: 6 }) as BlobPart], { type: 'application/zip' });
}
