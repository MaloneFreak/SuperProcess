/** First-run setup: language and appearance, then the AI connection. */
import { ArrowLeft, ArrowRight, Check, Monitor, Moon, Sun } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { defaultConfig, isConfigured, providerInfo } from '../../ai/registry';
import type { ProviderConfig } from '../../ai/types';
import { cx } from '../../lib/util';
import { navigate } from '../../state/session';
import { UI_LANGUAGES, useSettings, type ThemeMode, type UiLanguage } from '../../state/settings';
import { AiConfig } from '../components/AiConfig';
import { Button, Card, Field, Logo, Segmented, Select } from '../components/ui';

export function ThemeSwitch(): ReactNode {
  const { t } = useTranslation();
  const theme = useSettings((state) => state.theme);
  const update = useSettings((state) => state.update);
  return (
    <Segmented<ThemeMode>
      label={t('settings.theme')}
      value={theme}
      onChange={(value) => update({ theme: value })}
      options={[
        { value: 'system', label: <><Monitor size={14} /> {t('settings.themeSystem')}</> },
        { value: 'light', label: <><Sun size={14} /> {t('settings.themeLight')}</> },
        { value: 'dark', label: <><Moon size={14} /> {t('settings.themeDark')}</> },
      ]}
    />
  );
}

export function LanguageSelect(): ReactNode {
  const language = useSettings((state) => state.uiLanguage);
  const update = useSettings((state) => state.update);
  return (
    <Select value={language} onChange={(e) => update({ uiLanguage: e.target.value as UiLanguage })} data-testid="ui-language">
      {UI_LANGUAGES.map((entry) => (
        <option key={entry.code} value={entry.code}>
          {entry.name}
        </option>
      ))}
    </Select>
  );
}

export function SetupPage(): ReactNode {
  const { t } = useTranslation();
  const settings = useSettings();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<ProviderConfig>(() => (settings.ai.provider === 'demo' ? defaultConfig('anthropic') : settings.ai));
  const [skipped, setSkipped] = useState(false);
  const steps = [t('setup.stepWelcome'), t('setup.stepAi'), t('setup.stepReady')];

  const finish = (): void => {
    if (!skipped) settings.setAi(draft);
    settings.update({ onboarded: true });
    navigate({ name: 'home' });
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-8 sm:py-12">
      <div className="mb-8 flex items-center justify-center gap-2.5">
        <Logo size={34} />
        <span className="text-xl font-semibold tracking-tight">SuperProcess</span>
      </div>

      <ol className="mb-6 flex items-center justify-center gap-2 text-[13px]">
        {steps.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cx(
                'flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold',
                i < step ? 'bg-ok-soft text-ok' : i === step ? 'bg-accent text-accent-fg' : 'bg-panel2 text-faint',
              )}
            >
              {i < step ? <Check size={14} strokeWidth={3} /> : i + 1}
            </span>
            <span className={cx(i === step ? 'font-medium text-fg' : 'text-muted')}>{label}</span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-8 bg-line-strong" />}
          </li>
        ))}
      </ol>

      <Card className="animate-rise p-6 sm:p-8" key={step}>
        {step === 0 && (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{t('setup.welcomeTitle')}</h1>
              <p className="mt-2 leading-relaxed text-muted">{t('setup.welcomeText')}</p>
            </div>
            <Field label={t('setup.language')}>
              <LanguageSelect />
            </Field>
            <div>
              <div className="mb-1.5 text-[13px] font-medium">{t('setup.appearance')}</div>
              <ThemeSwitch />
            </div>
            <div className="flex justify-end pt-2">
              <Button variant="primary" size="lg" onClick={() => setStep(1)} icon={<ArrowRight size={17} />} data-testid="setup-next">
                {t('common.continue')}
              </Button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{t('setup.aiTitle')}</h1>
              <p className="mt-2 leading-relaxed text-muted">{t('setup.aiText')}</p>
            </div>
            <AiConfig value={draft} onChange={setDraft} />
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-5">
              <Button variant="ghost" onClick={() => setStep(0)} icon={<ArrowLeft size={16} />}>
                {t('common.back')}
              </Button>
              <div className="flex-1" />
              <Button
                variant="ghost"
                title={t('setup.skipHint')}
                onClick={() => {
                  setSkipped(true);
                  setStep(2);
                }}
                data-testid="setup-skip"
              >
                {t('setup.skip')}
              </Button>
              <Button
                variant="primary"
                disabled={!isConfigured(draft)}
                onClick={() => {
                  setSkipped(false);
                  setStep(2);
                }}
                icon={<ArrowRight size={16} />}
                data-testid="setup-next"
              >
                {t('common.continue')}
              </Button>
            </div>
            <p className="text-xs text-faint">{t('setup.skipHint')}</p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-ok-soft text-ok">
              <Check size={28} strokeWidth={2.5} />
            </span>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{t('setup.readyTitle')}</h1>
              <p className="mx-auto mt-2 max-w-md leading-relaxed text-muted">
                {skipped ? t('setup.readyTextDemo') : t('setup.readyTextAi', { provider: providerInfo(draft.provider).name })}
              </p>
            </div>
            <div className="flex justify-center gap-2">
              <Button variant="ghost" onClick={() => setStep(1)} icon={<ArrowLeft size={16} />}>
                {t('common.back')}
              </Button>
              <Button variant="primary" size="lg" onClick={finish} data-testid="setup-start">
                {t('setup.start')}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
