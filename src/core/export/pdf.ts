/** PDF output through pdfmake, loaded on demand (it is large). */
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { SEVERITY_COLOR, type ReportDocument } from '../report/document';
import { blobToDataUrl } from './raster';

async function pdfMake(): Promise<typeof import('pdfmake/build/pdfmake')> {
  const [engine, fonts] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')]);
  const instance = (engine as unknown as { default?: typeof engine }).default ?? engine;
  const vfs = (fonts as unknown as { default?: Record<string, string> }).default ?? (fonts as unknown as Record<string, string>);
  instance.addVirtualFileSystem(vfs);
  return instance;
}

const PX_TO_PT = 0.75;

/** The diagram alone, on one page sized to fit it exactly. */
export async function diagramToPdf(png: Blob, width: number, height: number, title: string): Promise<Blob> {
  const engine = await pdfMake();
  const margin = 18;
  const definition: TDocumentDefinitions = {
    pageSize: { width: width * PX_TO_PT + margin * 2, height: height * PX_TO_PT + margin * 2 },
    pageMargins: margin,
    info: { title, creator: 'SuperProcess' },
    content: [{ image: await blobToDataUrl(png), width: width * PX_TO_PT }],
  };
  return engine.createPdf(definition).getBlob();
}

export interface DiagramImage {
  png: Blob;
  width: number;
  height: number;
}

export async function reportToPdf(doc: ReportDocument, diagram: DiagramImage): Promise<Blob> {
  const engine = await pdfMake();
  const image = await blobToDataUrl(diagram.png);
  const line = '#d9dde7';
  const content: Content[] = [
    { text: doc.title, style: 'title' },
    {
      margin: [0, 0, 0, 14],
      table: { widths: ['auto', '*'], body: doc.meta.map(([label, value]) => [{ text: label, bold: true, color: '#56607a' }, value]) },
      layout: 'noBorders',
    },
  ];

  const tableLayout = {
    hLineColor: () => line,
    vLineColor: () => line,
    hLineWidth: () => 0.6,
    vLineWidth: () => 0.6,
    paddingTop: () => 4,
    paddingBottom: () => 4,
  };

  for (const block of doc.blocks) {
    switch (block.t) {
      case 'heading':
        content.push({ text: block.text, style: block.level === 1 ? 'h1' : 'h2', headlineLevel: block.level });
        break;
      case 'paragraph':
        content.push({ text: block.text, margin: [0, 0, 0, 7] });
        break;
      case 'bullets':
        // pdfmake rewrites the arrays it is given, so it always gets copies.
        content.push({ ul: [...block.items], margin: [0, 0, 0, 8] });
        break;
      case 'score': {
        const color = block.value >= 75 ? '#15803d' : block.value >= 50 ? '#b45309' : '#c2271f';
        content.push({
          margin: [0, 0, 0, 10],
          columns: [
            { width: 'auto', noWrap: true, text: [{ text: String(block.value), fontSize: 30, bold: true, color }, { text: `  ${block.outOf}`, color: '#56607a' }] },
            { width: '*', margin: [16, 4, 0, 0], stack: [{ text: block.label, bold: true, fontSize: 12 }, { text: block.rationale, color: '#56607a', margin: [0, 3, 0, 0] }] },
          ],
        });
        break;
      }
      case 'table': {
        const small = block.columns.length > 5;
        content.push({
          margin: [0, 0, 0, 12],
          fontSize: small ? 7.5 : 8.5,
          table: {
            headerRows: 1,
            dontBreakRows: block.rows.length < 40,
            widths: block.weights.map((weight) => `${(weight * 100).toFixed(2)}%`),
            body: [
              block.columns.map((column) => ({ text: column, bold: true, fillColor: '#eef0f6' })),
              ...block.rows.map((row) => row.map((cell) => ({ text: cell }))),
            ],
          },
          layout: tableLayout,
        });
        break;
      }
      case 'finding':
        content.push({
          margin: [0, 0, 0, 10],
          unbreakable: block.fields.reduce((sum, [, value]) => sum + value.length, 0) < 1400,
          table: {
            widths: [78, '*'],
            body: [
              [
                {
                  colSpan: 2,
                  fillColor: SEVERITY_COLOR[block.severity],
                  color: '#ffffff',
                  text: [{ text: `${block.severityLabel.toUpperCase()}   `, bold: true, fontSize: 8 }, { text: `${block.id}  `, fontSize: 8 }, { text: block.title, bold: true }],
                },
                {},
              ],
              ...block.fields.map(([label, value]) => [{ text: label, bold: true, color: '#56607a', fontSize: 8.5 }, { text: value }]),
            ],
          },
          layout: tableLayout,
        });
        break;
      case 'diagram': {
        // A wide map gets a landscape page of its own.
        const landscape = diagram.width / diagram.height > 1.6;
        const available = landscape ? 842 - 96 : 595 - 96;
        const fitHeight = landscape ? 595 - 150 : 842 - 220;
        const scale = Math.min(available / diagram.width, fitHeight / diagram.height, PX_TO_PT);
        const last = content[content.length - 1];
        if (landscape && last && typeof last === 'object' && 'text' in last) {
          Object.assign(last, { pageBreak: 'before', pageOrientation: 'landscape' });
        }
        content.push({ image, width: diagram.width * scale, margin: [0, 4, 0, 6] });
        if (block.caption) content.push({ text: block.caption, color: '#56607a', fontSize: 8.5 });
        if (landscape) content.push({ text: '', pageBreak: 'after', pageOrientation: 'portrait' });
        break;
      }
    }
  }
  content.push({ text: doc.disclaimer, color: '#7a8399', fontSize: 8, margin: [0, 22, 0, 0] });

  const definition: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [48, 52, 48, 52],
    info: { title: doc.title, creator: 'SuperProcess' },
    defaultStyle: { fontSize: 9.5, lineHeight: 1.25, color: '#141925' },
    styles: {
      title: { fontSize: 22, bold: true, margin: [0, 0, 0, 10] },
      h1: { fontSize: 14, bold: true, margin: [0, 16, 0, 7] },
      h2: { fontSize: 11.5, bold: true, margin: [0, 10, 0, 5] },
    },
    footer: (page: number, pages: number) => ({ text: `${page} / ${pages}`, alignment: 'center', fontSize: 8, color: '#8790a5', margin: [0, 18, 0, 0] }),
    // Never leave a heading alone at the bottom of a page.
    pageBreakBefore: (node, queries) => node.headlineLevel !== undefined && queries.getFollowingNodesOnPage().length === 0,
    content,
  };
  return engine.createPdf(definition).getBlob();
}
