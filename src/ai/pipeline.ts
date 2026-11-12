/**
 * The analysis pipeline: sources → process model → BPMN check → repair, and
 * model + sources → reports.
 */
import type { SourceDocument } from '../core/import';
import { normalizeModel, type Repair } from '../core/model/normalize';
import { computeStats } from '../core/model/stats';
import type { ProcessModel } from '../core/model/types';
import { validateModel, type RuleCode, type ValidationResult } from '../core/model/validate';
import { findFocus } from '../core/report/focuses';
import { normalizeReport, type ReportContent } from '../core/report/types';
import { estimateTokens, parseJsonLenient } from './json';
import {
  EXTRACTION_PROMPT,
  describeIssue,
  extractionSystem,
  notesRequest,
  repairPrompt,
  reportContext,
  reportPrompt,
  reportSystem,
  sourcesBlock,
} from './prompts';
import { providerInfo } from './registry';
import { PROCESS_SCHEMA, REPORT_SCHEMA } from './schemas';
import { AiError, EMPTY_USAGE, addUsage, isAbort, type AiProvider, type Usage } from './types';

export type AnalyzeStage = 'condense' | 'model' | 'check' | 'repair';

export interface AnalyzeProgress {
  stage: AnalyzeStage;
  /** Characters of the answer generated so far. */
  chars: number;
  /** Process steps seen in the answer so far. */
  nodes: number;
  /** For `condense`: which part of how many is being read. */
  part?: number;
  parts?: number;
}

export interface AnalyzeInput {
  sources: SourceDocument[];
  userNotes: string;
  /** `auto` or a BCP-47 code. */
  language: string;
}

export interface AnalyzeResult {
  model: ProcessModel;
  repairs: Repair[];
  validation: ValidationResult;
  /** The sources as sent to the AI (long transcripts may have been condensed). */
  sources: SourceDocument[];
  usage: Usage;
  aiModel: string;
}

/** Tokens kept free for the instructions and the answer. */
const OVERHEAD_TOKENS = 3_500;
const ANSWER_TOKENS = 8_000;

/** Problems worth a second pass by the model. */
const REPAIRABLE: ReadonlySet<RuleCode> = new Set<RuleCode>([
  'noStartEvent',
  'noEndEvent',
  'startHasIncoming',
  'endHasOutgoing',
  'noIncoming',
  'noOutgoing',
  'unreachable',
  'cannotReachEnd',
  'eventGatewayTargets',
  'boundaryNoOutgoing',
  'superfluousGateway',
  'gatewayMixed',
  'splitFlowsUnlabeled',
  'splitUnnamed',
  'implicitSplit',
  'unnamedActivity',
  'multipleDefaults',
]);

function splitText(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > maxChars) {
      parts.push(current);
      current = '';
    }
    // A single line longer than a part (no line breaks in the file) is cut hard.
    let rest = line;
    while (rest.length > maxChars) {
      parts.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    current += (current ? '\n' : '') + rest;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Makes the sources fit the model's context window. Cloud models take whole
 * meetings at once; small local models get long transcripts condensed into
 * process notes first, part by part. Nothing is ever cut silently.
 */
async function fitSources(
  provider: AiProvider,
  input: AnalyzeInput,
  onProgress: (progress: AnalyzeProgress) => void,
  signal: AbortSignal | undefined,
): Promise<{ sources: SourceDocument[]; usage: Usage }> {
  const budget = provider.config.contextTokens - OVERHEAD_TOKENS - ANSWER_TOKENS;
  const size = (sources: SourceDocument[]): number => estimateTokens(sourcesBlock(sources, input.userNotes));
  if (size(input.sources) <= budget) return { sources: input.sources, usage: EMPTY_USAGE };

  const partChars = Math.floor(Math.max(1_500, budget * 0.55) * 3.2);
  const jobs = input.sources.map((source) => ({
    source,
    // Diagrams are structured data and cannot be summarised.
    parts: source.kind === 'diagram' ? [] : splitText(source.text, partChars),
  }));
  const total = jobs.reduce((sum, job) => sum + job.parts.length, 0);
  let done = 0;
  let usage = EMPTY_USAGE;
  const condensed: SourceDocument[] = [];
  for (const job of jobs) {
    if (job.parts.length === 0) {
      condensed.push(job.source);
      continue;
    }
    const notes: string[] = [];
    for (let i = 0; i < job.parts.length; i++) {
      onProgress({ stage: 'condense', chars: 0, nodes: 0, part: done + 1, parts: total });
      const request = notesRequest(job.source, i + 1, job.parts.length, job.parts[i]);
      const result = await provider.chat({ system: request.system, context: '', prompt: request.prompt, signal });
      notes.push(result.text.trim());
      usage = addUsage(usage, result.usage);
      done++;
    }
    condensed.push({ ...job.source, format: `${job.source.format} (notes)`, text: notes.join('\n\n') });
  }
  if (size(condensed) > budget) {
    throw new AiError('tooLong', 'The material is too long for this model, even after condensing it.');
  }
  return { sources: condensed, usage };
}

function countNodes(text: string): number {
  return (text.match(/"type"\s*:\s*"/g) ?? []).length;
}

export async function analyze(
  provider: AiProvider,
  input: AnalyzeInput,
  onProgress: (progress: AnalyzeProgress) => void = () => {},
  signal?: AbortSignal,
): Promise<AnalyzeResult> {
  const fitted = await fitSources(provider, input, onProgress, signal);
  let usage = fitted.usage;
  const system = extractionSystem(input.language);
  const context = sourcesBlock(fitted.sources, input.userNotes);

  const run = async (stage: AnalyzeStage, prompt: string) => {
    onProgress({ stage, chars: 0, nodes: 0 });
    const result = await provider.chat({
      system,
      context,
      prompt,
      schema: PROCESS_SCHEMA,
      schemaName: 'process_model',
      signal,
      onText: (text) => onProgress({ stage, chars: text.length, nodes: countNodes(text) }),
    });
    usage = addUsage(usage, result.usage);
    const parsed = parseJsonLenient(result.text);
    const normalized = normalizeModel(parsed.value);
    return { ...normalized, truncated: parsed.truncated, aiModel: result.model };
  };

  let best = await run('model', EXTRACTION_PROMPT);
  if (best.model.nodes.length === 0) {
    throw new AiError('invalidOutput', 'The model found no process steps in this material.');
  }
  onProgress({ stage: 'check', chars: 0, nodes: best.model.nodes.length });
  let validation = validateModel(best.model);

  const problems = validation.issues.filter((issue) => REPAIRABLE.has(issue.code)).map(describeIssue);
  if (best.truncated) {
    problems.unshift('The previous answer was cut off before it was complete. Make sure every path reaches an end event.');
  }
  if (problems.length > 0) {
    try {
      const repaired = await run('repair', repairPrompt(best.model, [...new Set(problems)].slice(0, 25)));
      const repairedValidation = validateModel(repaired.model);
      const better =
        repaired.model.nodes.length > 0 &&
        (repairedValidation.counts.error < validation.counts.error ||
          (repairedValidation.counts.error === validation.counts.error && repairedValidation.score >= validation.score));
      // Never trade a complete model for a smaller one that merely validates.
      const complete = repaired.model.nodes.length >= best.model.nodes.length * 0.7;
      if (better && complete) {
        best = { ...repaired, repairs: [...best.repairs, ...repaired.repairs] };
        validation = repairedValidation;
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      // The first model is usable; a failed second pass must not lose it.
    }
  }

  return {
    model: best.model,
    repairs: best.repairs,
    validation,
    sources: fitted.sources,
    usage,
    aiModel: best.aiModel,
  };
}

export interface ReportJob {
  /** A focus id from the catalogue, or `custom`. */
  focusId: string;
  /** Extra instructions; for a custom focus, the brief itself. */
  instructions: string;
}

export interface ReportInput {
  model: ProcessModel;
  sources: SourceDocument[];
  userNotes: string;
  /** `auto` (the model's language) or a BCP-47 code. */
  language: string;
}

export interface ReportResult {
  content: ReportContent;
  usage: Usage;
  aiModel: string;
  language: string;
}

export interface ReportCallbacks {
  onProgress?: (chars: number) => void;
  onStart?: () => void;
  signal?: AbortSignal;
}

export async function writeReport(
  provider: AiProvider,
  input: ReportInput,
  job: ReportJob,
  callbacks: ReportCallbacks = {},
): Promise<ReportResult> {
  const stats = computeStats(input.model);
  const budget = provider.config.contextTokens - OVERHEAD_TOKENS - ANSWER_TOKENS;
  let context = reportContext(input.model, stats, input.sources, input.userNotes);
  let note = '';
  if (estimateTokens(context) > budget) {
    // The model carries the essentials (descriptions, systems, issues per step).
    context = reportContext(input.model, stats, [], input.userNotes);
    note =
      '\n\nThe original sources are too long for this model and are not included. Base the analysis on the process model, and mention this in "limitations".';
    if (estimateTokens(context) > budget) throw new AiError('tooLong', 'The process model is too large for this model.');
  }

  const focus = findFocus(job.focusId) ?? null;
  const language = input.language === 'auto' ? input.model.language || 'en' : input.language;
  const result = await provider.chat({
    system: reportSystem(input.language, input.model.language || 'en'),
    context,
    prompt: reportPrompt(focus, job.instructions) + note,
    schema: REPORT_SCHEMA,
    schemaName: 'process_report',
    signal: callbacks.signal,
    onStart: callbacks.onStart,
    onText: (text) => callbacks.onProgress?.(text.length),
  });
  const parsed = parseJsonLenient(result.text);
  const content = normalizeReport(parsed.value, new Set(input.model.nodes.map((node) => node.id)));
  if (!content.executiveSummary && content.findings.length === 0 && content.sections.length === 0) {
    throw new AiError('invalidOutput', 'The model returned an empty report.');
  }
  return { content, usage: result.usage, aiModel: result.model, language };
}

/**
 * Runs several report jobs. With Claude, the first request is given a head
 * start so it writes the shared sources to the prompt cache; the others then
 * read them from the cache at a fraction of the cost. Local servers handle
 * one request at a time, so their jobs run in sequence.
 */
export async function runReportJobs<T>(
  provider: AiProvider,
  jobs: T[],
  run: (job: T, onStart: () => void) => Promise<void>,
): Promise<void> {
  if (jobs.length === 0) return;
  const kind = providerInfo(provider.config.provider).kind;
  if (kind === 'local') {
    for (const job of jobs) await run(job, () => {});
    return;
  }

  let release: () => void = () => {};
  const warmed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = run(jobs[0], release).finally(release);
  await warmed;

  const queue = jobs.slice(1);
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) await run(job, () => {});
  });
  await Promise.all([first, ...workers]);
}
