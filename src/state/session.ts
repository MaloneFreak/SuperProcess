/**
 * Runtime state: the current screen, the analysis in progress and the report
 * jobs. Nothing here is persisted; finished work lives in the history store.
 */
import { create } from 'zustand';
import { analyze, runReportJobs, writeReport, type AnalyzeProgress } from '../ai/pipeline';
import { createProvider, isConfigured, providerInfo } from '../ai/registry';
import { AiError, EMPTY_USAGE, isAbort, type AiErrorKind } from '../ai/types';
import type { DiagramFormat } from '../core/export';
import type { SourceDocument } from '../core/import';
import type { Report } from '../core/report/types';
import { newId } from '../lib/util';
import { sampleModel, sampleTranscript } from '../samples/sample';
import { deleteAnalysis, listAnalyses, loadAnalysis, saveAnalysis, type Analysis, type AnalysisSummary } from './history';
import { useSettings } from './settings';

export type Route =
  | { name: 'home' }
  | { name: 'setup' }
  | { name: 'settings' }
  | { name: 'working' }
  | { name: 'analysis'; id: string };

export interface Failure {
  kind: AiErrorKind | 'unknown';
  message: string;
}

export interface Work {
  status: 'running' | 'error';
  stage: 'read' | AnalyzeProgress['stage'] | 'layout';
  progress: AnalyzeProgress | null;
  startedAt: number;
  error?: Failure;
}

export interface ReportJob {
  id: string;
  analysisId: string;
  focusId: string;
  instructions: string;
  language: string;
  status: 'queued' | 'running' | 'error';
  /** Characters written so far, for the progress bar. */
  chars: number;
  error?: Failure;
}

export interface Toast {
  id: string;
  text: string;
  tone: 'ok' | 'error';
}

interface AnalysisRequest {
  sources: SourceDocument[];
  notes: string;
  format: DiagramFormat;
}

interface Session {
  route: Route;
  history: AnalysisSummary[];
  current: Analysis | null;
  work: Work | null;
  reportJobs: ReportJob[];
  toasts: Toast[];
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  if (path.startsWith('analysis/')) return { name: 'analysis', id: decodeURIComponent(path.slice('analysis/'.length)) };
  if (path === 'settings' || path === 'setup' || path === 'working') return { name: path };
  return { name: 'home' };
}

function routeHash(route: Route): string {
  if (route.name === 'home') return '#/';
  if (route.name === 'analysis') return `#/analysis/${encodeURIComponent(route.id)}`;
  return `#/${route.name}`;
}

export const useSession = create<Session>(() => ({
  route: typeof location !== 'undefined' ? parseRoute(location.hash) : { name: 'home' },
  history: [],
  current: null,
  work: null,
  reportJobs: [],
  toasts: [],
}));

const set = useSession.setState;
const get = useSession.getState;

export function navigate(route: Route): void {
  const hash = routeHash(route);
  if (location.hash !== hash) location.hash = hash;
  set({ route });
}

export function toast(text: string, tone: Toast['tone'] = 'ok'): void {
  const id = newId();
  set((state) => ({ toasts: [...state.toasts, { id, text, tone }] }));
  setTimeout(() => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })), tone === 'error' ? 8000 : 3500);
}

export function toFailure(error: unknown): Failure {
  if (error instanceof AiError) return { kind: error.kind, message: error.message };
  return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
}

export async function refreshHistory(): Promise<void> {
  set({ history: await listAnalyses() });
}

export async function openAnalysis(id: string): Promise<void> {
  if (get().current?.id === id) return;
  set({ current: (await loadAnalysis(id)) ?? null });
}

async function persist(analysis: Analysis): Promise<void> {
  await saveAnalysis(analysis);
  set((state) => ({ current: state.current?.id === analysis.id || !state.current ? analysis : state.current }));
  await refreshHistory();
}

/** Applies a change to an analysis, whether or not it is the one on screen. */
export async function updateAnalysis(id: string, change: (analysis: Analysis) => Analysis): Promise<void> {
  const base = get().current?.id === id ? get().current : await loadAnalysis(id);
  if (!base) return;
  const next = change(base);
  await saveAnalysis(next);
  if (get().current?.id === id) set({ current: next });
  await refreshHistory();
}

export async function removeAnalysis(id: string): Promise<void> {
  await deleteAnalysis(id);
  if (get().current?.id === id) set({ current: null });
  await refreshHistory();
}

let controller: AbortController | null = null;
let lastRequest: AnalysisRequest | null = null;

export async function startAnalysis(request: AnalysisRequest): Promise<void> {
  lastRequest = request;
  const settings = useSettings.getState();
  controller = new AbortController();
  const startedAt = Date.now();
  set({ work: { status: 'running', stage: 'read', progress: null, startedAt } });
  navigate({ name: 'working' });

  try {
    if (!isConfigured(settings.ai)) throw new AiError('notConfigured', 'No AI provider is configured.');
    const provider = createProvider(settings.ai);
    const result = await analyze(
      provider,
      { sources: request.sources, userNotes: request.notes, language: settings.outputLanguage },
      (progress) => set({ work: { status: 'running', stage: progress.stage, progress, startedAt } }),
      controller.signal,
    );
    set({ work: { status: 'running', stage: 'layout', progress: null, startedAt } });
    const analysis: Analysis = {
      id: newId(),
      createdAt: new Date().toISOString(),
      title: result.model.name || request.sources[0]?.name || 'Process',
      sources: result.sources,
      userNotes: request.notes,
      format: request.format,
      model: result.model,
      repairs: result.repairs,
      aiModel: result.aiModel,
      usage: result.usage,
      reports: [],
    };
    await saveAnalysis(analysis);
    set({ current: analysis, work: null });
    await refreshHistory();
    navigate({ name: 'analysis', id: analysis.id });
  } catch (error) {
    if (isAbort(error)) {
      set({ work: null });
      navigate({ name: 'home' });
      return;
    }
    set({ work: { status: 'error', stage: get().work?.stage ?? 'read', progress: null, startedAt, error: toFailure(error) } });
  } finally {
    controller = null;
  }
}

export function cancelAnalysis(): void {
  if (controller) controller.abort();
  else {
    set({ work: null });
    navigate({ name: 'home' });
  }
}

export function retryAnalysis(): void {
  if (lastRequest) void startAnalysis(lastRequest);
}

/** Opens the built-in example, creating it in the history on first use. */
export async function openSample(): Promise<void> {
  const language = useSettings.getState().uiLanguage;
  const id = `sample-${language}`;
  let analysis = await loadAnalysis(id);
  if (!analysis) {
    const model = sampleModel(language);
    analysis = {
      id,
      createdAt: new Date().toISOString(),
      title: model.name,
      sources: [sampleTranscript(language)],
      userNotes: '',
      format: useSettings.getState().diagramFormat,
      model,
      repairs: [],
      aiModel: '',
      usage: EMPTY_USAGE,
      reports: [],
      sample: true,
    };
    await persist(analysis);
  }
  set({ current: analysis });
  navigate({ name: 'analysis', id });
}

const reportControllers = new Map<string, AbortController>();

export interface ReportRequest {
  focusId: string;
  instructions: string;
}

/** Queues one report per request and writes them, several at a time. */
export async function startReports(analysisId: string, requests: ReportRequest[], language: string): Promise<void> {
  const settings = useSettings.getState();
  const analysis = get().current?.id === analysisId ? get().current : await loadAnalysis(analysisId);
  if (!analysis || requests.length === 0) return;

  const jobs: ReportJob[] = requests.map((request) => ({
    id: newId(),
    analysisId,
    focusId: request.focusId,
    instructions: request.instructions,
    language,
    status: 'queued',
    chars: 0,
  }));
  set((state) => ({ reportJobs: [...state.reportJobs, ...jobs] }));
  const patch = (id: string, change: Partial<ReportJob>): void =>
    set((state) => ({ reportJobs: state.reportJobs.map((job) => (job.id === id ? { ...job, ...change } : job)) }));

  let provider;
  try {
    if (!isConfigured(settings.ai)) throw new AiError('notConfigured', 'No AI provider is configured.');
    provider = createProvider(settings.ai);
  } catch (error) {
    for (const job of jobs) patch(job.id, { status: 'error', error: toFailure(error) });
    return;
  }

  await runReportJobs(provider, jobs, async (job, onStart) => {
    // The job may have been dismissed while it was waiting.
    if (!get().reportJobs.some((item) => item.id === job.id)) {
      onStart();
      return;
    }
    const abort = new AbortController();
    reportControllers.set(job.id, abort);
    patch(job.id, { status: 'running' });
    try {
      const result = await writeReport(
        provider,
        { model: analysis.model, sources: analysis.sources, userNotes: analysis.userNotes, language },
        { focusId: job.focusId, instructions: job.instructions },
        { signal: abort.signal, onStart, onProgress: (chars) => patch(job.id, { chars }) },
      );
      const report: Report = {
        id: newId(),
        focusId: job.focusId,
        instructions: job.instructions,
        language: result.language,
        createdAt: new Date().toISOString(),
        model: result.aiModel,
        content: result.content,
      };
      await updateAnalysis(analysisId, (latest) => ({ ...latest, reports: [...latest.reports, report] }));
      set((state) => ({ reportJobs: state.reportJobs.filter((item) => item.id !== job.id) }));
    } catch (error) {
      if (isAbort(error)) set((state) => ({ reportJobs: state.reportJobs.filter((item) => item.id !== job.id) }));
      else patch(job.id, { status: 'error', error: toFailure(error) });
    } finally {
      reportControllers.delete(job.id);
    }
  });
}

/** Cancels a running job or removes a waiting or failed one. */
export function dismissReportJob(id: string): void {
  const running = reportControllers.get(id);
  if (running) running.abort();
  else set((state) => ({ reportJobs: state.reportJobs.filter((job) => job.id !== id) }));
}

export async function deleteReport(analysisId: string, reportId: string): Promise<void> {
  await updateAnalysis(analysisId, (analysis) => ({
    ...analysis,
    reports: analysis.reports.filter((report) => report.id !== reportId),
  }));
}

/** Whether the configured AI runs on the user's machine (for error wording). */
export function aiIsLocal(): boolean {
  return providerInfo(useSettings.getState().ai.provider).kind === 'local';
}
