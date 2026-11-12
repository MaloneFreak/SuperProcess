/**
 * Turns a report into a format-neutral document: an ordered list of blocks
 * (headings, text, tables, findings, the process map). The on-screen viewer
 * and the Word, PDF, HTML and Markdown writers all render this one structure,
 * so a report reads the same wherever it ends up.
 */
import type { TFunction } from 'i18next';
import { computeStats } from '../model/stats';
import { isActivity, type ProcessModel } from '../model/types';
import type { Highlight } from '../render/svg';
import type { FindingSeverity, Report } from './types';

export type Block =
  | { t: 'heading'; level: 1 | 2; text: string }
  | { t: 'paragraph'; text: string; muted?: boolean }
  | { t: 'bullets'; items: string[] }
  | { t: 'table'; columns: string[]; rows: string[][]; weights: number[] }
  | { t: 'score'; value: number; label: string; rationale: string; outOf: string }
  | {
      t: 'finding';
      id: string;
      title: string;
      severity: FindingSeverity;
      severityLabel: string;
      fields: [string, string][];
    }
  | { t: 'diagram'; caption: string };

export interface ReportDocument {
  title: string;
  /** Rows shown under the title: process, focus, date. */
  meta: [string, string][];
  blocks: Block[];
  disclaimer: string;
  language: string;
}

export const SEVERITY_COLOR: Record<FindingSeverity, string> = {
  critical: '#b91c1c',
  high: '#ea580c',
  medium: '#ca8a04',
  low: '#2563eb',
};

/** Splits plain text into paragraphs and bullet lists ("- " lines). */
export function textBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let bullets: string[] = [];
  const flush = (): void => {
    if (bullets.length > 0) blocks.push({ t: 'bullets', items: bullets });
    bullets = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) bullets.push(bullet[1]);
    else {
      flush();
      blocks.push({ t: 'paragraph', text: line });
    }
  }
  flush();
  return blocks;
}

/** Relative column widths from how much text each column holds. */
export function columnWeights(columns: string[], rows: string[][]): number[] {
  const raw = columns.map((column, i) => {
    const lengths = rows.map((row) => Math.min((row[i] ?? '').length, 90));
    const average = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
    return Math.max(6, Math.min(48, Math.max(column.length, average)));
  });
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((value) => value / total);
}

function table(columns: string[], rows: string[][]): Block {
  return { t: 'table', columns, rows, weights: columnWeights(columns, rows) };
}

export function formatDate(iso: string, language: string): string {
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'long' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** Which steps to highlight on the process map, and how. */
export function findingHighlights(report: Report): Record<string, Highlight> {
  const rank: FindingSeverity[] = ['low', 'medium', 'high', 'critical'];
  const worst = new Map<string, FindingSeverity>();
  const count = new Map<string, number>();
  for (const finding of report.content.findings) {
    for (const step of finding.steps) {
      count.set(step, (count.get(step) ?? 0) + 1);
      const current = worst.get(step);
      if (!current || rank.indexOf(finding.severity) > rank.indexOf(current)) worst.set(step, finding.severity);
    }
  }
  const highlights: Record<string, Highlight> = {};
  for (const [step, severity] of worst) {
    highlights[step] = { color: SEVERITY_COLOR[severity], badge: String(count.get(step)) };
  }
  return highlights;
}

export function buildReportDocument(report: Report, model: ProcessModel, focusName: string, t: TFunction): ReportDocument {
  const { content } = report;
  const blocks: Block[] = [];
  const nodeName = new Map(model.nodes.map((node) => [node.id, node.name || node.id]));
  const laneName = new Map(model.lanes.map((lane) => [lane.id, lane.name]));
  const level = (value: string): string => t(`report.${value}`);
  const heading = (text: string, depth: 1 | 2 = 1): void => {
    blocks.push({ t: 'heading', level: depth, text });
  };

  if (content.executiveSummary) {
    heading(t('report.executiveSummary'));
    blocks.push(...textBlocks(content.executiveSummary));
  }

  heading(t('report.score'));
  blocks.push({
    t: 'score',
    value: content.score.value,
    label: content.score.label,
    rationale: content.score.rationale,
    outOf: t('report.scoreOutOf'),
  });
  if (content.dimensions.length > 0) {
    blocks.push(
      table(
        [t('report.dimension'), t('report.scoreColumn'), t('report.comment')],
        content.dimensions.map((d) => [d.name, String(d.score), d.comment]),
      ),
    );
  }

  if (content.metrics.length > 0) {
    heading(t('report.keyFigures'), 2);
    blocks.push(
      table(
        [t('report.figure'), t('report.value'), t('report.basis')],
        content.metrics.map((m) => [m.label, m.value, m.note]),
      ),
    );
  }

  const stats = computeStats(model);
  heading(t('report.processFacts'), 2);
  blocks.push(
    table(
      [t('report.figure'), t('report.value')],
      [
        [t('report.factActivities'), String(stats.activities)],
        [t('report.factDecisions'), String(stats.decisions)],
        [t('report.factLanes'), String(stats.lanes)],
        [t('report.factHandoffs'), String(stats.handoffs)],
        [t('report.factLoops'), String(stats.loops)],
        [t('report.factHuman'), String(stats.humanSteps)],
        [t('report.factAutomated'), String(stats.automatedSteps)],
        [t('report.factSystems'), stats.systems.length > 0 ? `${stats.systems.length} (${stats.systems.join(', ')})` : '0'],
        [t('report.factExternal'), String(stats.messageExchanges)],
      ],
    ),
  );

  heading(t('report.processMap'));
  blocks.push({ t: 'diagram', caption: content.findings.some((f) => f.steps.length > 0) ? t('report.mapCaption') : '' });

  if (content.findings.length > 0) {
    heading(t('report.findings'));
    for (const finding of content.findings) {
      const fields: [string, string][] = [];
      if (finding.category) fields.push([t('report.category'), finding.category]);
      if (finding.steps.length > 0) {
        fields.push([t('report.steps'), finding.steps.map((step) => nodeName.get(step) ?? step).join(' · ')]);
      }
      if (finding.description) fields.push([t('report.findings'), finding.description]);
      if (finding.evidence) fields.push([t('report.evidence'), finding.evidence]);
      if (finding.impact) fields.push([t('report.impact'), finding.impact]);
      if (finding.recommendation) fields.push([t('report.recommendation'), finding.recommendation]);
      blocks.push({
        t: 'finding',
        id: finding.id,
        title: finding.title,
        severity: finding.severity,
        severityLabel: level(finding.severity),
        fields,
      });
    }
  }

  for (const section of content.sections) {
    if (section.heading) heading(section.heading);
    if (section.body) blocks.push(...textBlocks(section.body));
    if (section.table.columns.length > 0) blocks.push(table(section.table.columns, section.table.rows));
  }

  if (content.actions.length > 0) {
    heading(t('report.actionPlan'));
    blocks.push(
      table(
        [t('report.action'), t('report.priority'), t('report.effort'), t('report.impact'), t('report.horizon'), t('report.addresses')],
        content.actions.map((action) => [
          action.description ? `${action.title}. ${action.description}` : action.title,
          level(action.priority),
          level(action.effort),
          level(action.impact),
          level(action.horizon),
          action.findings.join(', '),
        ]),
      ),
    );
  }

  if (content.openQuestions.length > 0) {
    heading(t('report.openQuestions'));
    blocks.push({ t: 'bullets', items: [...content.openQuestions] });
  }
  if (content.limitations) {
    heading(t('report.limitations'));
    blocks.push(...textBlocks(content.limitations));
  }

  const activities = model.nodes.filter((node) => isActivity(node.type));
  if (activities.length > 0) {
    heading(t('report.appendix'));
    blocks.push(
      table(
        [t('report.step'), t('report.lane'), t('report.type'), t('report.systems'), t('report.duration')],
        activities.map((node) => [
          node.name || node.id,
          laneName.get(node.lane) ?? '',
          t(`nodeType.${node.type}`),
          node.systems.join(', '),
          node.duration,
        ]),
      ),
    );
  }

  const date = formatDate(report.createdAt, report.language);
  return {
    title: content.title || focusName,
    meta: [
      [t('report.process'), model.name],
      [t('report.focus'), focusName],
      [t('report.date'), date],
    ],
    blocks,
    disclaimer: t('report.disclaimer', { model: report.model, date }),
    language: report.language,
  };
}

// ── Markdown ────────────────────────────────────────────────────────────────

const cellMd = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n+/g, '<br>');

/** `imageName` is the file name of the process map saved next to the Markdown file, if any. */
export function toMarkdown(doc: ReportDocument, imageName?: string): string {
  const out: string[] = [`# ${doc.title}`, ''];
  for (const [label, value] of doc.meta) out.push(`**${label}:** ${value}  `);
  out.push('');
  for (const block of doc.blocks) {
    switch (block.t) {
      case 'heading':
        out.push(`${'#'.repeat(block.level + 1)} ${block.text}`, '');
        break;
      case 'paragraph':
        out.push(block.text, '');
        break;
      case 'bullets':
        out.push(...block.items.map((item) => `- ${item}`), '');
        break;
      case 'score':
        out.push(`**${block.value} ${block.outOf}${block.label ? ` — ${block.label}` : ''}**`, '');
        if (block.rationale) out.push(block.rationale, '');
        break;
      case 'table':
        out.push(`| ${block.columns.map(cellMd).join(' | ')} |`);
        out.push(`| ${block.columns.map(() => '---').join(' | ')} |`);
        for (const row of block.rows) out.push(`| ${row.map(cellMd).join(' | ')} |`);
        out.push('');
        break;
      case 'finding':
        out.push(`### ${block.id} · ${block.title} (${block.severityLabel})`, '');
        for (const [label, value] of block.fields) out.push(`- **${label}:** ${value.replace(/\n+/g, ' ')}`);
        out.push('');
        break;
      case 'diagram':
        if (imageName) {
          out.push(`![](${imageName})`, '');
          if (block.caption) out.push(`_${block.caption}_`, '');
        } else {
          // No image to point at: drop the heading that introduced the map.
          const last = out.length - 2;
          if (last >= 0 && out[last].startsWith('#')) out.splice(last, 2);
        }
        break;
    }
  }
  out.push('---', '', `_${doc.disclaimer}_`, '');
  return out.join('\n');
}

// ── HTML ────────────────────────────────────────────────────────────────────

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const br = (text: string): string => esc(text).replace(/\n/g, '<br>');

function tableHtml(columns: string[], rows: string[][], weights: number[]): string {
  const cols = weights.map((weight) => `<col style="width:${(weight * 100).toFixed(1)}%">`).join('');
  const head = columns.map((column) => `<th>${esc(column)}</th>`).join('');
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${br(cell)}</td>`).join('')}</tr>`).join('');
  return `<div class="scroll"><table><colgroup>${cols}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Body markup shared by the standalone HTML file and the in-app viewer. */
export function blocksToHtml(doc: ReportDocument, diagramSvg: string): string {
  const out: string[] = [];
  for (const block of doc.blocks) {
    switch (block.t) {
      case 'heading':
        out.push(`<h${block.level + 1}>${esc(block.text)}</h${block.level + 1}>`);
        break;
      case 'paragraph':
        out.push(`<p>${esc(block.text)}</p>`);
        break;
      case 'bullets':
        out.push(`<ul>${block.items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`);
        break;
      case 'score': {
        const tone = block.value >= 75 ? 'good' : block.value >= 50 ? 'fair' : 'poor';
        out.push(
          `<div class="score ${tone}"><div class="score-value">${block.value}<span>${esc(block.outOf)}</span></div>` +
            `<div class="score-text"><strong>${esc(block.label)}</strong><div class="bar"><i style="width:${block.value}%"></i></div>` +
            `<p>${esc(block.rationale)}</p></div></div>`,
        );
        break;
      }
      case 'table':
        out.push(tableHtml(block.columns, block.rows, block.weights));
        break;
      case 'finding':
        out.push(
          `<section class="finding" style="--tone:${SEVERITY_COLOR[block.severity]}">` +
            `<header><span class="tag">${esc(block.severityLabel)}</span><span class="fid">${esc(block.id)}</span><h4>${esc(block.title)}</h4></header>` +
            `<dl>${block.fields.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${br(value)}</dd>`).join('')}</dl></section>`,
        );
        break;
      case 'diagram':
        out.push(`<figure class="map"><div class="scroll">${diagramSvg}</div>${block.caption ? `<figcaption>${esc(block.caption)}</figcaption>` : ''}</figure>`);
        break;
    }
  }
  return out.join('\n');
}

export const REPORT_CSS = `
.report{font:15px/1.6 Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--r-fg);}
.report h1{font-size:28px;line-height:1.2;margin:0 0 12px;letter-spacing:-.01em}
.report h2{font-size:20px;margin:36px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--r-line)}
.report h3{font-size:16px;margin:26px 0 8px}
.report h4{font-size:15px;margin:0;display:inline}
.report p{margin:0 0 12px}
.report ul{margin:0 0 12px;padding-left:22px;list-style:disc}
.report li{margin:3px 0}
.report .meta{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;margin:0 0 8px;color:var(--r-muted);font-size:14px}
.report .meta b{color:var(--r-fg);font-weight:600}
.report .scroll{overflow-x:auto}
.report table{border-collapse:collapse;width:100%;margin:0 0 16px;font-size:13.5px;table-layout:fixed}
.report th,.report td{border:1px solid var(--r-line);padding:7px 9px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.report th{background:var(--r-soft);font-weight:600}
.report .score{display:flex;gap:20px;align-items:center;margin:0 0 16px;padding:16px 18px;border:1px solid var(--r-line);border-radius:12px;background:var(--r-soft)}
.report .score-value{font-size:44px;font-weight:700;line-height:1;white-space:nowrap}
.report .score-value span{font-size:13px;font-weight:500;color:var(--r-muted);margin-left:6px}
.report .score-text{flex:1;min-width:0}
.report .score-text p{margin:8px 0 0;color:var(--r-muted)}
.report .bar{height:8px;border-radius:99px;background:var(--r-line);margin-top:8px;overflow:hidden}
.report .bar i{display:block;height:100%;border-radius:99px;background:currentColor}
.report .score.good .bar,.report .score.good .score-value{color:#15803d}
.report .score.fair .bar,.report .score.fair .score-value{color:#b45309}
.report .score.poor .bar,.report .score.poor .score-value{color:#c2271f}
.report .finding{border:1px solid var(--r-line);border-left:4px solid var(--tone);border-radius:10px;padding:12px 16px;margin:0 0 12px;break-inside:avoid}
.report .finding header{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}
.report .tag{background:var(--tone);color:#fff;font-size:11.5px;font-weight:700;padding:2px 9px;border-radius:99px;text-transform:uppercase;letter-spacing:.03em}
.report .fid{color:var(--r-muted);font-size:13px;font-weight:600}
.report dl{display:grid;grid-template-columns:minmax(110px,max-content) 1fr;gap:5px 16px;margin:0;font-size:14px}
.report dt{color:var(--r-muted);font-weight:600}
.report dd{margin:0}
.report .map{margin:0 0 16px}
.report .map svg{max-width:none;height:auto;border:1px solid var(--r-line);border-radius:10px}
.report figcaption{color:var(--r-muted);font-size:13px;margin-top:6px}
.report .disclaimer{margin-top:36px;padding-top:12px;border-top:1px solid var(--r-line);color:var(--r-muted);font-size:12.5px}
`;

/** A self-contained HTML file that prints well. */
export function toHtml(doc: ReportDocument, diagramSvg: string): string {
  const meta = doc.meta.map(([label, value]) => `<b>${esc(label)}</b><span>${esc(value)}</span>`).join('');
  return `<!doctype html>
<html lang="${esc(doc.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.title)}</title>
<style>
:root{--r-fg:#141925;--r-muted:#56607a;--r-line:#dfe3ec;--r-soft:#f5f6fa}
body{margin:0;background:#fff}
main{max-width:960px;margin:0 auto;padding:48px 28px 64px}
${REPORT_CSS}
.report .map svg{width:100%}
@media print{main{padding:0;max-width:none}.report h2{break-after:avoid}.report table{font-size:11.5px}}
@page{margin:16mm}
</style>
</head>
<body>
<main class="report">
<h1>${esc(doc.title)}</h1>
<div class="meta">${meta}</div>
${blocksToHtml(doc, diagramSvg)}
<p class="disclaimer">${esc(doc.disclaimer)}</p>
</main>
</body>
</html>
`;
}
