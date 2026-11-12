/** Settings: appearance, AI connection, output defaults, data and privacy. */
import { ArrowLeft, Check, ExternalLink, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { OUTPUT_LANGUAGES } from '../../ai/prompts';
import { defaultConfig, isConfigured } from '../../ai/registry';
import type { ProviderConfig } from '../../ai/types';
import type { DiagramFormat, ReportFormat } from '../../core/export';
import { DIAGRAM_STYLES, type DiagramStyle } from '../../core/render/theme';
import { clearHistory } from '../../state/history';
import { navigate, refreshHistory, toast, useSession } from '../../state/session';
import { DIAGRAM_FORMATS, REPORT_FORMATS, useSettings } from '../../state/settings';
import { AiConfig } from '../components/AiConfig';
import { Button, Card, Field, Notice, Select } from '../components/ui';
import { LanguageSelect, ThemeSwitch } from './Setup';

const REPOSITORY = 'https://github.com/MaloneFreak/SuperProcess';

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="mb-4 text-base font-semibold">{title}</h2>
      <div className="space-y-4">{children}</div>
    </Card>
  );
}

export function SettingsPage(): ReactNode {
  const { t } = useTranslation();
  const settings = useSettings();
  const [draft, setDraft] = useState<ProviderConfig>(() => (settings.ai.provider === 'demo' ? defaultConfig('anthropic') : settings.ai));
  const [savedAt, setSavedAt] = useState(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.ai);

  useEffect(() => {
    if (!savedAt) return;
    const timer = setTimeout(() => setSavedAt(0), 2500);
    return () => clearTimeout(timer);
  }, [savedAt]);

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:px-6 sm:py-8">
      <div>
        <button type="button" onClick={() => navigate({ name: 'home' })} className="mb-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-fg">
          <ArrowLeft size={15} /> {t('common.back')}
        </button>
        <h1 className="text-[26px] font-semibold tracking-tight">{t('settings.title')}</h1>
      </div>

      <Section title={t('settings.appearance')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.language')}>
            <LanguageSelect />
          </Field>
          <div>
            <div className="mb-1.5 text-[13px] font-medium">{t('settings.theme')}</div>
            <ThemeSwitch />
          </div>
        </div>
      </Section>

      <Section title={t('settings.ai')}>
        <AiConfig value={draft} onChange={setDraft} />
        <div className="flex items-center gap-3 border-t border-line pt-4">
          <Button
            variant="primary"
            disabled={!isConfigured(draft) || !dirty}
            onClick={() => {
              settings.setAi(draft);
              setSavedAt(Date.now());
            }}
            data-testid="save-ai"
          >
            {t('ai.save')}
          </Button>
          {savedAt > 0 && (
            <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ok">
              <Check size={16} /> {t('ai.saved')}
            </span>
          )}
          {!isConfigured(settings.ai) && !savedAt && <span className="text-[13px] text-muted">{t('ai.notConfigured')}</span>}
        </div>
      </Section>

      <Section title={t('settings.output')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.outputLanguage')}>
            <Select value={settings.outputLanguage} onChange={(e) => settings.update({ outputLanguage: e.target.value })}>
              <option value="auto">{t('settings.outputLanguageAuto')}</option>
              {OUTPUT_LANGUAGES.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('style.label')}>
            <Select value={settings.diagramStyle} onChange={(e) => settings.update({ diagramStyle: e.target.value as DiagramStyle })}>
              {DIAGRAM_STYLES.map((style) => (
                <option key={style} value={style}>
                  {t(`style.${style}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('settings.diagramFormat')}>
            <Select value={settings.diagramFormat} onChange={(e) => settings.update({ diagramFormat: e.target.value as DiagramFormat })}>
              {DIAGRAM_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {t(`format.${format}`)} (.{format})
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('settings.reportFormat')}>
            <Select value={settings.reportFormat} onChange={(e) => settings.update({ reportFormat: e.target.value as ReportFormat })}>
              {REPORT_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {t(`format.${format}`)} (.{format})
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Section>

      <Section title={t('settings.data')}>
        <Notice tone="ok" icon={<ShieldCheck size={17} className="text-ok" />}>
          {t('settings.privacy')}
        </Notice>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="danger"
            onClick={async () => {
              if (!confirm(t('settings.clearConfirm'))) return;
              await clearHistory();
              useSession.setState({ current: null });
              await refreshHistory();
              toast(t('ai.saved'));
            }}
          >
            {t('settings.clearHistory')}
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              if (!confirm(t('settings.resetConfirm'))) return;
              await clearHistory();
              useSession.setState({ current: null, history: [], reportJobs: [] });
              settings.reset();
              navigate({ name: 'setup' });
            }}
          >
            {t('settings.reset')}
          </Button>
          <Button variant="ghost" onClick={() => {
            settings.update({ onboarded: false });
            navigate({ name: 'setup' });
          }}>
            {t('settings.setupAgain')}
          </Button>
        </div>
      </Section>

      <Section title={t('settings.about')}>
        <p className="text-[13.5px] text-muted">
          SuperProcess · {t('settings.version', { version: __APP_VERSION__ })}
        </p>
        <a className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-accent hover:underline" href={REPOSITORY} target="_blank" rel="noreferrer">
          {t('settings.sourceCode')} <ExternalLink size={13} />
        </a>
      </Section>
    </div>
  );
}
