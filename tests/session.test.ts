import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Analysis } from '../src/state/history';

// An in-memory stand-in for the IndexedDB store, slow enough to expose races.
const db = new Map<string, Analysis>();
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
vi.mock('../src/state/history', () => ({
  loadAnalysis: async (id: string) => {
    await pause();
    return db.get(id);
  },
  saveAnalysis: async (analysis: Analysis) => {
    await pause();
    db.set(analysis.id, analysis);
  },
  deleteAnalysis: async (id: string) => {
    db.delete(id);
  },
  listAnalyses: async () => [],
}));

const { parseRoute, updateAnalysis, useSession } = await import('../src/state/session');
const { sampleModel } = await import('../src/samples/sample');

const analysis = (): Analysis => ({
  id: 'a1',
  createdAt: '2026-01-01T00:00:00Z',
  title: 'Test',
  sources: [],
  userNotes: '',
  format: 'vsdx',
  model: sampleModel('en'),
  repairs: [],
  aiModel: 'm',
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
  reports: [],
});

const report = (id: string): Analysis['reports'][number] => ({
  id,
  focusId: 'cost',
  instructions: '',
  language: 'en',
  createdAt: '2026-01-01T00:00:00Z',
  model: 'm',
  content: {
    title: id,
    executiveSummary: '',
    score: { value: 50, label: '', rationale: '' },
    dimensions: [],
    metrics: [],
    findings: [],
    sections: [],
    actions: [],
    openQuestions: [],
    limitations: '',
  },
});

describe('session', () => {
  beforeEach(() => {
    db.clear();
    db.set('a1', analysis());
    useSession.setState({ current: null });
  });

  it('keeps every report when several finish at the same moment', async () => {
    const append = (id: string): Promise<void> => updateAnalysis('a1', (latest) => ({ ...latest, reports: [...latest.reports, report(id)] }));
    await Promise.all([append('r1'), append('r2'), append('r3')]);
    expect(db.get('a1')?.reports.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('keeps every report when the analysis is the one on screen', async () => {
    useSession.setState({ current: db.get('a1')! });
    await Promise.all(['r1', 'r2'].map((id) => updateAnalysis('a1', (latest) => ({ ...latest, reports: [...latest.reports, report(id)] }))));
    expect(useSession.getState().current?.reports).toHaveLength(2);
    expect(db.get('a1')?.reports).toHaveLength(2);
  });

  it('continues after a failed update', async () => {
    await expect(
      updateAnalysis('a1', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await updateAnalysis('a1', (latest) => ({ ...latest, title: 'Renamed' }));
    expect(db.get('a1')?.title).toBe('Renamed');
  });

  it('parses routes', () => {
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#/settings')).toEqual({ name: 'settings' });
    expect(parseRoute('#/analysis/abc%20d')).toEqual({ name: 'analysis', id: 'abc d' });
    expect(parseRoute('#/nonsense')).toEqual({ name: 'home' });
  });
});
