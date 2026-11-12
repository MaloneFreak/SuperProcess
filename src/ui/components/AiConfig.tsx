/** The AI connection form, used by the first-run setup and by Settings. */
import { Check, CircleAlert, Cloud, Cpu, Download, ExternalLink, Eye, KeyRound, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { OllamaProvider, detectOllama } from '../../ai/providers/ollama';
import { LOCAL_MODELS, createProvider, defaultConfig, isConfigured, providerInfo, suggestModel } from '../../ai/registry';
import type { Effort, ModelInfo, ProviderConfig, ProviderId } from '../../ai/types';
import { cx, formatBytes } from '../../lib/util';
import { toFailure, type Failure } from '../../state/session';
import { useSettings } from '../../state/settings';
import { failureText } from '../errors';
import { Badge, Button, Field, Notice, ProgressBar, Select, Spinner, TextInput } from './ui';

const CLOUD: ProviderId[] = ['anthropic', 'openai', 'gemini', 'openrouter', 'custom'];
const LOCAL: ProviderId[] = ['ollama', 'lmstudio'];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh'];
const CUSTOM_MODEL = '__custom__';

type TestState = { status: 'idle' } | { status: 'busy' } | { status: 'ok'; model: string } | { status: 'error'; failure: Failure };

function ModeCard({ active, icon, title, text, onClick }: { active: boolean; icon: ReactNode; title: string; text: string; onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'flex flex-1 items-start gap-3 rounded-xl border p-4 text-left transition-colors',
        active ? 'border-accent bg-accent-soft' : 'border-line-strong bg-panel hover:bg-panel2',
      )}
    >
      <span className={cx('mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', active ? 'bg-accent text-accent-fg' : 'bg-panel2 text-muted')}>{icon}</span>
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-[13px] leading-snug text-muted">{text}</span>
      </span>
    </button>
  );
}

export function AiConfig({ value, onChange }: { value: ProviderConfig; onChange: (config: ProviderConfig) => void }): ReactNode {
  const { t } = useTranslation();
  const remembered = useSettings((state) => state.aiByProvider);
  const info = providerInfo(value.provider);
  // The demo placeholder is shown as "cloud, nothing chosen yet".
  const mode: 'cloud' | 'local' = info.kind === 'local' ? 'local' : 'cloud';
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [showKey, setShowKey] = useState(false);
  const [customModel, setCustomModel] = useState(false);

  const patch = (change: Partial<ProviderConfig>): void => {
    setTest({ status: 'idle' });
    onChange({ ...value, ...change });
  };
  const choose = (provider: ProviderId): void => {
    setTest({ status: 'idle' });
    setModels([]);
    setCustomModel(false);
    onChange(remembered[provider] ?? defaultConfig(provider));
  };

  const loadModels = async (): Promise<void> => {
    setLoading(true);
    setTest({ status: 'idle' });
    try {
      const list = await createProvider({ ...value, model: value.model || 'x' }).listModels();
      setModels(list);
      if (!value.model && list.length > 0) onChange({ ...value, model: suggestModel(list.map((m) => m.id)) });
    } catch (error) {
      setTest({ status: 'error', failure: toFailure(error) });
    } finally {
      setLoading(false);
    }
  };

  const runTest = async (): Promise<void> => {
    setTest({ status: 'busy' });
    try {
      await createProvider(value).test();
      setTest({ status: 'ok', model: value.model });
    } catch (error) {
      setTest({ status: 'error', failure: toFailure(error) });
    }
  };

  const active = value.provider === 'demo' ? 'anthropic' : value.provider;
  const tabs = mode === 'cloud' ? CLOUD : LOCAL;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row">
        <ModeCard active={mode === 'cloud'} icon={<Cloud size={18} />} title={t('ai.cloud')} text={t('ai.cloudText')} onClick={() => mode !== 'cloud' && choose('anthropic')} />
        <ModeCard active={mode === 'local'} icon={<Cpu size={18} />} title={t('ai.local')} text={t('ai.localText')} onClick={() => mode !== 'local' && choose('ollama')} />
      </div>

      <div>
        <div className="mb-1.5 text-[13px] font-medium">{t('ai.provider')}</div>
        <div className="flex flex-wrap gap-2">
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => choose(id)}
              aria-pressed={active === id}
              className={cx(
                'h-9 rounded-lg border px-3.5 text-[13px] font-medium transition-colors',
                active === id ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong text-muted hover:bg-panel2 hover:text-fg',
              )}
            >
              {providerInfo(id).name}
            </button>
          ))}
        </div>
      </div>

      {value.provider === 'ollama' ? (
        <OllamaSetup value={value} patch={patch} />
      ) : (
        <div className="space-y-4">
          {info.editableUrl && (
            <Field label={t('ai.baseUrl')} hint={value.provider === 'lmstudio' ? t('ai.lmstudioHint') : value.provider === 'custom' ? t('ai.customHint') : undefined}>
              <TextInput value={value.baseUrl} placeholder="https://…/v1" onChange={(e) => patch({ baseUrl: e.target.value.trim() })} spellCheck={false} />
            </Field>
          )}

          {(info.needsKey || value.provider === 'custom') && (
            <Field
              label={t('ai.apiKey')}
              optional={info.needsKey ? undefined : t('common.optional')}
              hint={
                <>
                  {t('ai.keyStored', { provider: info.name })}{' '}
                  {info.keyUrl && (
                    <a className="inline-flex items-center gap-1 font-medium text-accent hover:underline" href={info.keyUrl} target="_blank" rel="noreferrer">
                      {t('ai.getKey')} <ExternalLink size={12} />
                    </a>
                  )}
                </>
              }
            >
              <div className="relative">
                <KeyRound size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
                <TextInput
                  type={showKey ? 'text' : 'password'}
                  value={value.apiKey}
                  placeholder={t('ai.apiKeyPlaceholder')}
                  onChange={(e) => patch({ apiKey: e.target.value.trim() })}
                  className="pr-10 pl-9 font-mono"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" aria-label={t('ai.showKey')} title={t('ai.showKey')} onClick={() => setShowKey(!showKey)} className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1.5 text-faint hover:text-fg">
                  <Eye size={15} />
                </button>
              </div>
            </Field>
          )}

          <Field label={t('ai.model')}>
            {info.models.length > 0 && !customModel ? (
              <Select
                value={info.models.some((m) => m.id === value.model) ? value.model : CUSTOM_MODEL}
                onChange={(e) => {
                  if (e.target.value === CUSTOM_MODEL) setCustomModel(true);
                  else patch({ model: e.target.value });
                }}
              >
                {info.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id} — {t(`ai.hint${model.hint[0].toUpperCase()}${model.hint.slice(1)}`)}
                  </option>
                ))}
                <option value={CUSTOM_MODEL}>{t('ai.modelCustom')}</option>
              </Select>
            ) : (
              <div className="flex gap-2">
                {models.length > 0 ? (
                  <Select value={value.model} onChange={(e) => patch({ model: e.target.value })}>
                    {!models.some((m) => m.id === value.model) && <option value={value.model}>{value.model || '—'}</option>}
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <TextInput value={value.model} placeholder={t('ai.modelPlaceholder')} onChange={(e) => patch({ model: e.target.value.trim() })} spellCheck={false} className="font-mono" />
                )}
                {info.models.length === 0 && (
                  <Button onClick={loadModels} busy={loading} disabled={(info.needsKey && !value.apiKey) || !value.baseUrl} icon={<RefreshCw size={15} />}>
                    {loading ? t('ai.loadingModels') : t('ai.loadModels')}
                  </Button>
                )}
              </div>
            )}
          </Field>

          {value.provider === 'anthropic' && (
            <Field label={t('ai.effort')} hint={t('ai.effortHint')}>
              <Select value={value.effort} onChange={(e) => patch({ effort: e.target.value as Effort })}>
                {EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {t(`ai.effort${effort[0].toUpperCase()}${effort.slice(1)}`)}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {(info.kind === 'local' || value.provider === 'custom') && <ContextField value={value} patch={patch} />}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={runTest} busy={test.status === 'busy'} disabled={!isConfigured(value)}>
          {test.status === 'busy' ? t('ai.testing') : t('ai.test')}
        </Button>
        {test.status === 'ok' && (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ok" data-testid="ai-test-ok">
            <Check size={16} /> {t('ai.testOk', { model: test.model })}
          </span>
        )}
      </div>
      {test.status === 'error' && (
        <Notice tone="bad" icon={<CircleAlert size={16} className="text-bad" />}>
          {failureText(t, test.failure, value.model, info.kind === 'local')}
        </Notice>
      )}
    </div>
  );
}

function ContextField({ value, patch }: { value: ProviderConfig; patch: (change: Partial<ProviderConfig>) => void }): ReactNode {
  const { t } = useTranslation();
  return (
    <Field label={t('ai.context')} hint={t('ai.contextHint')}>
      <Select value={String(value.contextTokens)} onChange={(e) => patch({ contextTokens: Number(e.target.value) })}>
        {[8192, 16384, 32768, 65536, 131072].map((size) => (
          <option key={size} value={size}>
            {size.toLocaleString()}
          </option>
        ))}
        {![8192, 16384, 32768, 65536, 131072].includes(value.contextTokens) && <option value={value.contextTokens}>{value.contextTokens.toLocaleString()}</option>}
      </Select>
    </Field>
  );
}

function OllamaSetup({ value, patch }: { value: ProviderConfig; patch: (change: Partial<ProviderConfig>) => void }): ReactNode {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null | undefined>(undefined);
  const [installed, setInstalled] = useState<ModelInfo[]>([]);
  const [pulling, setPulling] = useState<{ model: string; fraction?: number } | null>(null);
  const [pullError, setPullError] = useState<Failure | null>(null);
  const [other, setOther] = useState('');
  const abort = useRef<AbortController | null>(null);
  const latest = useRef(value);
  latest.current = value;

  const refresh = useCallback(async (baseUrl: string): Promise<void> => {
    setVersion(undefined);
    const found = await detectOllama(baseUrl);
    setVersion(found);
    if (!found) {
      setInstalled([]);
      return;
    }
    try {
      const list = await new OllamaProvider({ ...latest.current, baseUrl }).listModels();
      setInstalled(list);
      // Pick an installed model when none is chosen yet.
      if (!latest.current.model && list.length > 0) patchRef.current({ model: list[0].id });
    } catch {
      setInstalled([]);
    }
  }, []);
  const patchRef = useRef(patch);
  patchRef.current = patch;

  useEffect(() => {
    void refresh(value.baseUrl);
    return () => abort.current?.abort();
  }, [refresh, value.baseUrl]);

  const pull = async (model: string): Promise<void> => {
    setPullError(null);
    setPulling({ model });
    abort.current = new AbortController();
    try {
      await new OllamaProvider(value).pull(model, (progress) => setPulling({ model, fraction: progress.fraction }), abort.current.signal);
      await refresh(value.baseUrl);
      patch({ model });
    } catch (error) {
      const failure = toFailure(error);
      if (failure.kind !== 'aborted') setPullError(failure);
    } finally {
      setPulling(null);
    }
  };

  const isInstalled = (id: string): boolean => installed.some((model) => model.id === id || model.id === `${id}:latest`);
  const webOrigin = typeof location !== 'undefined' && location.protocol === 'https:' ? location.origin : null;

  return (
    <div className="space-y-4">
      <Field label={t('ai.baseUrl')}>
        <div className="flex gap-2">
          <TextInput value={value.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value.trim() })} spellCheck={false} />
          <Button onClick={() => refresh(value.baseUrl)} icon={<RefreshCw size={15} />}>
            {t('ai.ollamaRecheck')}
          </Button>
        </div>
      </Field>

      {version === undefined && (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Spinner size={15} /> {t('ai.ollamaChecking')}
        </div>
      )}
      {version === null && (
        <Notice tone="warn" icon={<CircleAlert size={16} className="text-warn" />}>
          <p className="font-medium">{t('ai.ollamaMissing', { url: value.baseUrl })}</p>
          <p className="mt-1 text-muted">{t('ai.ollamaInstallHint')}</p>
          {webOrigin && <p className="mt-1 text-muted">{t('ai.ollamaOrigin', { origin: webOrigin })}</p>}
          <a className="mt-2 inline-flex items-center gap-1 font-medium text-accent hover:underline" href="https://ollama.com/download" target="_blank" rel="noreferrer">
            {t('ai.ollamaInstall')} <ExternalLink size={12} />
          </a>
        </Notice>
      )}
      {version && (
        <>
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-ok">
            <Check size={16} /> {t('ai.ollamaFound', { version })}
          </div>

          <div>
            <div className="mb-1.5 text-[13px] font-medium">{t('ai.installed')}</div>
            {installed.length === 0 ? (
              <p className="text-[13px] text-muted">{t('ai.noModels')}</p>
            ) : (
              <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                {installed.map((model) => (
                  <ModelRow key={model.id} name={model.id} detail={[model.label, model.size ? formatBytes(model.size) : ''].filter(Boolean).join(' · ')}>
                    {value.model === model.id ? (
                      <Badge tone="accent">{t('ai.inUse')}</Badge>
                    ) : (
                      <Button size="sm" onClick={() => patch({ model: model.id })}>
                        {t('ai.use')}
                      </Button>
                    )}
                  </ModelRow>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 text-[13px] font-medium">{t('ai.recommendedModels')}</div>
            <div className="space-y-3">
              {(['light', 'balanced', 'best'] as const).map((tier) => (
                <div key={tier}>
                  <div className="mb-1 text-xs font-medium text-muted">{t(`ai.tier${tier[0].toUpperCase()}${tier.slice(1)}`)}</div>
                  <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                    {LOCAL_MODELS.filter((model) => model.tier === tier).map((model) => (
                      <ModelRow key={model.id} name={model.name} detail={`${model.id} · ${t('ai.modelSize', { size: model.sizeGb })}`} progress={pulling?.model === model.id ? (pulling.fraction ?? 0) : undefined}>
                        {isInstalled(model.id) ? (
                          value.model === model.id ? (
                            <Badge tone="accent">{t('ai.inUse')}</Badge>
                          ) : (
                            <Button size="sm" onClick={() => patch({ model: model.id })}>
                              {t('ai.use')}
                            </Button>
                          )
                        ) : pulling?.model === model.id ? (
                          <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}>
                            {t('ai.downloading', { percent: Math.round((pulling.fraction ?? 0) * 100) })}
                          </Button>
                        ) : (
                          <Button size="sm" disabled={!!pulling} onClick={() => pull(model.id)} icon={<Download size={14} />}>
                            {t('ai.downloadModel')}
                          </Button>
                        )}
                      </ModelRow>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <Field label={t('ai.otherModel')}>
            <div className="flex gap-2">
              <TextInput value={other} placeholder={t('ai.otherModelPlaceholder')} onChange={(e) => setOther(e.target.value.trim())} spellCheck={false} className="font-mono" />
              <Button disabled={!other || !!pulling} busy={pulling?.model === other} onClick={() => pull(other)} icon={<Download size={15} />}>
                {pulling?.model === other ? t('ai.downloading', { percent: Math.round((pulling.fraction ?? 0) * 100) }) : t('ai.downloadModel')}
              </Button>
            </div>
          </Field>
          {pullError && (
            <Notice tone="bad" icon={<CircleAlert size={16} className="text-bad" />}>
              {failureText(t, pullError, pulling?.model ?? other, true)}
            </Notice>
          )}

          <ContextField value={value} patch={patch} />
        </>
      )}
    </div>
  );
}

function ModelRow({ name, detail, progress, children }: { name: string; detail: string; progress?: number; children: ReactNode }): ReactNode {
  return (
    <div className="bg-panel px-3.5 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{name}</div>
          <div className="truncate font-mono text-[11.5px] text-muted">{detail}</div>
        </div>
        {children}
      </div>
      {progress !== undefined && <ProgressBar value={progress} className="mt-2" />}
    </div>
  );
}
