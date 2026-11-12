/** Report data model and the lenient normaliser for AI-written report content. */

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type FindingSeverity = (typeof SEVERITIES)[number];

export const LEVELS = ['low', 'medium', 'high'] as const;
export type Level = (typeof LEVELS)[number];

export const HORIZONS = ['quickWin', 'shortTerm', 'mediumTerm', 'longTerm'] as const;
export type Horizon = (typeof HORIZONS)[number];

export interface ReportFinding {
  id: string;
  title: string;
  severity: FindingSeverity;
  category: string;
  /** Ids of the process nodes the finding refers to. */
  steps: string[];
  description: string;
  evidence: string;
  impact: string;
  recommendation: string;
}

export interface ReportTable {
  columns: string[];
  rows: string[][];
}

export interface ReportSection {
  heading: string;
  body: string;
  table: ReportTable;
}

export interface ReportAction {
  title: string;
  description: string;
  priority: Level;
  effort: Level;
  impact: Level;
  horizon: Horizon;
  /** Ids of the findings this action addresses. */
  findings: string[];
}

export interface ReportContent {
  title: string;
  executiveSummary: string;
  score: { value: number; label: string; rationale: string };
  dimensions: { name: string; score: number; comment: string }[];
  metrics: { label: string; value: string; note: string }[];
  findings: ReportFinding[];
  sections: ReportSection[];
  actions: ReportAction[];
  openQuestions: string[];
  limitations: string;
}

export interface Report {
  id: string;
  focusId: string;
  /** Extra instructions the user gave for this report (the whole brief for a custom focus). */
  instructions: string;
  /** BCP-47 code of the language the report is written in. */
  language: string;
  createdAt: string;
  /** The AI model that wrote it. */
  model: string;
  content: ReportContent;
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function text(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(text).filter(Boolean).map((line) => `- ${line}`).join('\n');
  return '';
}

function texts(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  return list(value).map(text).filter(Boolean);
}

function score(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(parsed)) return 0;
  // Some models answer on a 0–10 or 1–5 scale despite the instructions.
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], aliases: Record<string, T>, fallback: T): T {
  const key = text(value).toLowerCase().replace(/[^a-z]/g, '');
  const direct = allowed.find((option) => option.toLowerCase() === key);
  return direct ?? aliases[key] ?? fallback;
}

const SEVERITY_ALIASES: Record<string, FindingSeverity> = {
  severe: 'critical',
  blocker: 'critical',
  veryhigh: 'critical',
  major: 'high',
  moderate: 'medium',
  minor: 'low',
  info: 'low',
  informational: 'low',
};
const LEVEL_ALIASES: Record<string, Level> = { minor: 'low', small: 'low', moderate: 'medium', major: 'high', large: 'high', critical: 'high' };
const HORIZON_ALIASES: Record<string, Horizon> = {
  quickwin: 'quickWin',
  quickwins: 'quickWin',
  immediate: 'quickWin',
  now: 'quickWin',
  short: 'shortTerm',
  shortterm: 'shortTerm',
  medium: 'mediumTerm',
  mediumterm: 'mediumTerm',
  midterm: 'mediumTerm',
  long: 'longTerm',
  longterm: 'longTerm',
};

/**
 * Coerces AI output into a ReportContent. `nodeIds` is the set of valid step
 * ids; references to anything else are dropped.
 */
export function normalizeReport(input: unknown, nodeIds: ReadonlySet<string>): ReportContent {
  const raw = isRecord(input) ? (isRecord(input.report) ? input.report : input) : {};

  const findings: ReportFinding[] = [];
  const usedIds = new Set<string>();
  for (const entry of list(raw.findings)) {
    if (!isRecord(entry)) continue;
    const title = text(entry.title ?? entry.name);
    const description = text(entry.description ?? entry.detail);
    if (!title && !description) continue;
    let id = text(entry.id) || `F${findings.length + 1}`;
    while (usedIds.has(id)) id = `${id}_`;
    usedIds.add(id);
    findings.push({
      id,
      title: title || description.slice(0, 80),
      severity: oneOf(entry.severity, SEVERITIES, SEVERITY_ALIASES, 'medium'),
      category: text(entry.category),
      steps: texts(entry.steps ?? entry.relatedSteps ?? entry.nodes).filter((step) => nodeIds.has(step)),
      description,
      evidence: text(entry.evidence),
      impact: text(entry.impact),
      recommendation: text(entry.recommendation),
    });
  }
  const order: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const sections: ReportSection[] = [];
  for (const entry of list(raw.sections)) {
    if (!isRecord(entry)) continue;
    const table = isRecord(entry.table) ? entry.table : {};
    const columns = texts(table.columns ?? table.headers);
    const rows = list(table.rows)
      .map((row) => (Array.isArray(row) ? row.map(text) : isRecord(row) ? columns.map((column) => text(row[column])) : []))
      .filter((row) => row.some(Boolean))
      // Pad or trim so every row has one cell per column.
      .map((row) => columns.map((_, i) => row[i] ?? ''));
    const heading = text(entry.heading ?? entry.title);
    const body = text(entry.body ?? entry.content ?? entry.text);
    if (!heading && !body && rows.length === 0) continue;
    sections.push({ heading, body, table: columns.length > 0 && rows.length > 0 ? { columns, rows } : { columns: [], rows: [] } });
  }

  const actions: ReportAction[] = [];
  for (const entry of list(raw.actions ?? raw.actionPlan ?? raw.recommendations)) {
    if (!isRecord(entry)) continue;
    const title = text(entry.title ?? entry.action);
    if (!title) continue;
    actions.push({
      title,
      description: text(entry.description),
      priority: oneOf(entry.priority, LEVELS, LEVEL_ALIASES, 'medium'),
      effort: oneOf(entry.effort, LEVELS, LEVEL_ALIASES, 'medium'),
      impact: oneOf(entry.impact, LEVELS, LEVEL_ALIASES, 'medium'),
      horizon: oneOf(entry.horizon, HORIZONS, HORIZON_ALIASES, 'shortTerm'),
      findings: texts(entry.findings ?? entry.relatedFindings).filter((id) => usedIds.has(id)),
    });
  }

  const rawScore = isRecord(raw.score) ? raw.score : { value: raw.score };
  return {
    title: text(raw.title),
    executiveSummary: text(raw.executiveSummary ?? raw.summary),
    score: { value: score(rawScore.value), label: text(rawScore.label), rationale: text(rawScore.rationale) },
    dimensions: list(raw.dimensions)
      .filter(isRecord)
      .map((d) => ({ name: text(d.name), score: score(d.score ?? d.value), comment: text(d.comment ?? d.rationale) }))
      .filter((d) => d.name),
    metrics: list(raw.metrics)
      .filter(isRecord)
      .map((m) => ({ label: text(m.label ?? m.name), value: text(m.value), note: text(m.note) }))
      .filter((m) => m.label && m.value),
    findings,
    sections,
    actions,
    openQuestions: texts(raw.openQuestions ?? raw.questions),
    limitations: text(raw.limitations),
  };
}
