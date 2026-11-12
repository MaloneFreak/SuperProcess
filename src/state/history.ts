/**
 * Analyses are stored in IndexedDB on the user's device: a light index for the
 * history list plus one record per analysis with its model, sources and reports.
 */
import { createStore, del, get, set } from 'idb-keyval';
import type { Usage } from '../ai/types';
import type { SourceDocument } from '../core/import';
import type { Repair } from '../core/model/normalize';
import type { ProcessModel } from '../core/model/types';
import { validateModel } from '../core/model/validate';
import type { Report } from '../core/report/types';
import type { DiagramFormat } from './settings';

export interface Analysis {
  id: string;
  createdAt: string;
  title: string;
  /** The material the process was mapped from, as it was sent to the AI. */
  sources: SourceDocument[];
  userNotes: string;
  /** Output format chosen when the analysis was started. */
  format: DiagramFormat;
  model: ProcessModel;
  repairs: Repair[];
  aiModel: string;
  usage: Usage;
  reports: Report[];
  sample?: boolean;
}

export interface AnalysisSummary {
  id: string;
  createdAt: string;
  title: string;
  files: string[];
  format: DiagramFormat;
  steps: number;
  lanes: number;
  reports: number;
  score: number;
  sample?: boolean;
}

const store = createStore('superprocess', 'analyses');
const INDEX_KEY = '__index__';

export function summarize(analysis: Analysis): AnalysisSummary {
  return {
    id: analysis.id,
    createdAt: analysis.createdAt,
    title: analysis.title,
    files: analysis.sources.map((source) => source.name),
    format: analysis.format,
    steps: analysis.model.nodes.length,
    lanes: analysis.model.lanes.length,
    reports: analysis.reports.length,
    score: validateModel(analysis.model).score,
    sample: analysis.sample,
  };
}

export async function listAnalyses(): Promise<AnalysisSummary[]> {
  const index = (await get<AnalysisSummary[]>(INDEX_KEY, store)) ?? [];
  return [...index].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadAnalysis(id: string): Promise<Analysis | undefined> {
  return get<Analysis>(id, store);
}

export async function saveAnalysis(analysis: Analysis): Promise<void> {
  await set(analysis.id, analysis, store);
  const index = (await get<AnalysisSummary[]>(INDEX_KEY, store)) ?? [];
  await set(INDEX_KEY, [summarize(analysis), ...index.filter((entry) => entry.id !== analysis.id)], store);
}

export async function deleteAnalysis(id: string): Promise<void> {
  await del(id, store);
  const index = (await get<AnalysisSummary[]>(INDEX_KEY, store)) ?? [];
  await set(INDEX_KEY, index.filter((entry) => entry.id !== id), store);
}

export async function clearHistory(): Promise<void> {
  const index = (await get<AnalysisSummary[]>(INDEX_KEY, store)) ?? [];
  await Promise.all(index.map((entry) => del(entry.id, store)));
  await set(INDEX_KEY, [], store);
}
