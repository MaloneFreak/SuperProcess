/** Word (.docx) output for reports, loaded on demand. */
import { SEVERITY_COLOR, type ReportDocument } from '../report/document';
import type { DiagramImage } from './pdf';

const FONT = 'Calibri';
const MUTED = '56607A';
const LINE = 'D9DDE7';

export async function reportToDocx(doc: ReportDocument, diagram: DiagramImage): Promise<Blob> {
  const {
    AlignmentType,
    BorderStyle,
    Document,
    Footer,
    HeadingLevel,
    ImageRun,
    Packer,
    PageNumber,
    PageOrientation,
    Paragraph,
    ShadingType,
    Table,
    TableCell,
    TableLayoutType,
    TableRow,
    TextRun,
    WidthType,
  } = await import('docx');

  type Child = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
  const border = { style: BorderStyle.SINGLE, size: 4, color: LINE };
  const borders = { top: border, bottom: border, left: border, right: border };

  /** Paragraphs for text that may contain line breaks. */
  const lines = (text: string, options: { bold?: boolean; color?: string; size?: number } = {}): InstanceType<typeof Paragraph>[] =>
    (text || '').split('\n').map(
      (line) =>
        new Paragraph({
          spacing: { after: 40 },
          children: [new TextRun({ text: line, bold: options.bold, color: options.color, size: options.size ?? 19, font: FONT })],
        }),
    );

  const table = (columns: string[], rows: string[][], weights: number[], fontSize = 18): InstanceType<typeof Table> => {
    const cell = (text: string, weight: number, header: boolean): InstanceType<typeof TableCell> =>
      new TableCell({
        borders,
        width: { size: Math.round(weight * 100), type: WidthType.PERCENTAGE },
        margins: { top: 60, bottom: 60, left: 90, right: 90 },
        shading: header ? { type: ShadingType.CLEAR, fill: 'EEF0F6', color: 'auto' } : undefined,
        children: lines(text, { bold: header, size: fontSize }),
      });
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.FIXED,
      rows: [
        new TableRow({ tableHeader: true, children: columns.map((column, i) => cell(column, weights[i], true)) }),
        ...rows.map((row) => new TableRow({ cantSplit: true, children: columns.map((_, i) => cell(row[i] ?? '', weights[i], false)) })),
      ],
    });
  };

  const gap = (): InstanceType<typeof Paragraph> => new Paragraph({ spacing: { after: 120 }, children: [] });

  const front: Child[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 160 }, children: [new TextRun({ text: doc.title, bold: true, size: 44, font: FONT })] }),
    ...doc.meta.map(
      ([label, value]) =>
        new Paragraph({
          spacing: { after: 30 },
          children: [new TextRun({ text: `${label}: `, bold: true, color: MUTED, size: 20, font: FONT }), new TextRun({ text: value, size: 20, font: FONT })],
        }),
    ),
    gap(),
  ];
  const map: Child[] = [];
  const back: Child[] = [];
  // Everything before the process map, the map itself (on a landscape page), and the rest.
  let target = front;

  for (const block of doc.blocks) {
    switch (block.t) {
      case 'heading': {
        const next = doc.blocks[doc.blocks.indexOf(block) + 1];
        if (next?.t === 'diagram') target = map;
        target.push(
          new Paragraph({
            heading: block.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
            keepNext: true,
            spacing: { before: block.level === 1 ? 320 : 220, after: 120 },
            children: [new TextRun({ text: block.text, bold: true, size: block.level === 1 ? 28 : 23, color: '141925', font: FONT })],
          }),
        );
        break;
      }
      case 'paragraph':
        target.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: block.text, size: 21, font: FONT })] }));
        break;
      case 'bullets':
        for (const item of block.items) {
          target.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 50 }, children: [new TextRun({ text: item, size: 21, font: FONT })] }));
        }
        target.push(gap());
        break;
      case 'score': {
        const color = block.value >= 75 ? '15803D' : block.value >= 50 ? 'B45309' : 'C2271F';
        target.push(
          new Paragraph({
            spacing: { after: 60 },
            children: [
              new TextRun({ text: String(block.value), bold: true, size: 56, color, font: FONT }),
              new TextRun({ text: `  ${block.outOf}`, size: 20, color: MUTED, font: FONT }),
              new TextRun({ text: block.label ? `     ${block.label}` : '', bold: true, size: 24, font: FONT }),
            ],
          }),
        );
        if (block.rationale) {
          target.push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: block.rationale, size: 21, color: MUTED, font: FONT })] }));
        }
        break;
      }
      case 'table':
        target.push(table(block.columns, block.rows, block.weights, block.columns.length > 5 ? 15 : 18), gap());
        break;
      case 'finding': {
        const fill = SEVERITY_COLOR[block.severity].slice(1).toUpperCase();
        target.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            layout: TableLayoutType.FIXED,
            rows: [
              new TableRow({
                cantSplit: true,
                children: [
                  new TableCell({
                    columnSpan: 2,
                    borders,
                    margins: { top: 70, bottom: 70, left: 100, right: 100 },
                    shading: { type: ShadingType.CLEAR, fill, color: 'auto' },
                    children: [
                      new Paragraph({
                        children: [
                          new TextRun({ text: `${block.severityLabel.toUpperCase()}   ${block.id}   `, bold: true, color: 'FFFFFF', size: 17, font: FONT }),
                          new TextRun({ text: block.title, bold: true, color: 'FFFFFF', size: 21, font: FONT }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
              ...block.fields.map(
                ([label, value]) =>
                  new TableRow({
                    children: [
                      new TableCell({ borders, width: { size: 20, type: WidthType.PERCENTAGE }, margins: { top: 60, bottom: 60, left: 100, right: 100 }, children: lines(label, { bold: true, color: MUTED, size: 18 }) }),
                      new TableCell({ borders, width: { size: 80, type: WidthType.PERCENTAGE }, margins: { top: 60, bottom: 60, left: 100, right: 100 }, children: lines(value, { size: 19 }) }),
                    ],
                  }),
              ),
            ],
          }),
          gap(),
        );
        break;
      }
      case 'diagram': {
        // Fit the map into a landscape page (about 9.6 × 5.4 inches of usable area).
        const scale = Math.min(920 / diagram.width, 500 / diagram.height, 1);
        map.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                type: 'png',
                data: new Uint8Array(await diagram.png.arrayBuffer()),
                transformation: { width: Math.round(diagram.width * scale), height: Math.round(diagram.height * scale) },
              }),
            ],
          }),
        );
        if (block.caption) {
          map.push(new Paragraph({ spacing: { before: 100 }, children: [new TextRun({ text: block.caption, size: 18, color: MUTED, font: FONT })] }));
        }
        target = back;
        break;
      }
    }
  }
  back.push(new Paragraph({ spacing: { before: 400 }, children: [new TextRun({ text: doc.disclaimer, size: 16, color: MUTED, italics: true, font: FONT })] }));

  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 16, color: MUTED, font: FONT })],
      }),
    ],
  });
  const margin = { top: 1000, bottom: 1000, left: 1050, right: 1050 };
  const portrait = { page: { margin } };
  const landscape = { page: { margin, size: { orientation: PageOrientation.LANDSCAPE } } };

  const file = new Document({
    creator: 'SuperProcess',
    title: doc.title,
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    sections: [
      { properties: portrait, footers: { default: footer }, children: front },
      ...(map.length > 0 ? [{ properties: landscape, footers: { default: footer }, children: map }] : []),
      { properties: portrait, footers: { default: footer }, children: back },
    ],
  });
  return Packer.toBlob(file);
}
