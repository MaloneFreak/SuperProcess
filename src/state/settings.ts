/** User preferences, kept in the browser's local storage. */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { defaultConfig } from '../ai/registry';
import type { ProviderConfig, ProviderId } from '../ai/types';
import type { DiagramFormat, ReportFormat } from '../core/export';
import type { DiagramStyle } from '../core/render/theme';

export const UI_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'es', name: 'Español' },
] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number]['code'];

export const DIAGRAM_FORMATS: DiagramFormat[] = ['vsdx', 'bpmn', 'drawio', 'svg', 'png', 'pdf'];
export const REPORT_FORMATS: ReportFormat[] = ['docx', 'pdf', 'html', 'md'];
export type { DiagramFormat, ReportFormat };

export type ThemeMode = 'system' | 'light' | 'dark';

export interface Settings {
  onboarded: boolean;
  uiLanguage: UiLanguage;
  theme: ThemeMode;
  /** The active AI connection. */
  ai: ProviderConfig;
  /** Last configuration used for each provider, so switching back keeps its key. */
  aiByProvider: Partial<Record<ProviderId, ProviderConfig>>;
  /** Language of diagrams and reports: `auto` follows the source material. */
  outputLanguage: string;
  diagramFormat: DiagramFormat;
  reportFormat: ReportFormat;
  diagramStyle: DiagramStyle;
}

interface SettingsStore extends Settings {
  update: (patch: Partial<Settings>) => void;
  setAi: (config: ProviderConfig) => void;
  reset: () => void;
}

export function detectLanguage(): UiLanguage {
  const candidates = typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : [];
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (lower.startsWith('pt')) return 'pt-BR';
    if (lower.startsWith('es')) return 'es';
    if (lower.startsWith('en')) return 'en';
  }
  return 'en';
}

const initial = (): Settings => ({
  onboarded: false,
  uiLanguage: detectLanguage(),
  theme: 'system',
  ai: defaultConfig('demo'),
  aiByProvider: {},
  outputLanguage: 'auto',
  diagramFormat: 'vsdx',
  reportFormat: 'docx',
  diagramStyle: 'color',
});

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...initial(),
      update: (patch) => set(patch),
      setAi: (config) => set((state) => ({ ai: config, aiByProvider: { ...state.aiByProvider, [config.provider]: config } })),
      reset: () => set(initial()),
    }),
    {
      name: 'superprocess.settings',
      version: 1,
      partialize: ({ update: _update, setAi: _setAi, reset: _reset, ...settings }) => settings,
    },
  ),
);

/** Whether the dark palette is in effect for a theme mode. */
export function isDark(mode: ThemeMode): boolean {
  if (mode !== 'system') return mode === 'dark';
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
}
