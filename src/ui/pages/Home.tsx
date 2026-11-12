/** The start screen: add files, choose the output, analyze; history below. */
import { ArrowRight, CircleAlert, CloudUpload, FileText, MessageSquareText, Play, Sparkles, Trash2, Workflow, X } from 'lucide-react';
import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isConfigured } from '../../ai/registry';
import type { DiagramFormat } from '../../core/export';
import { ACCEPTED_EXTENSIONS, ingest, type SourceDocument } from '../../core/import';
import { formatDate } from '../../core/report/document';
import { cx } from '../../lib/util';
import { sampleTranscript } from '../../samples/sample';
import { navigate, openSample, removeAnalysis, startAnalysis, useSession } from '../../state/session';
import { DIAGRAM_FORMATS, useSettings } from '../../state/settings';
import { fileErrorText } from '../errors';
import { Badge, Button, Card, Field, IconButton, Notice, Spinner, Textarea } from '../components/ui';

const KIND_ICON = { transcript: MessageSquareText, diagram: Workflow, document: FileText };

function FormatPicker({ value, onChange }: { value: DiagramFormat; onChange: (format: DiagramFormat) => void }): ReactNode {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t('home.outputLabel')} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {DIAGRAM_FORMATS.map((format) => {
        const active = format === value;
        return (
          <button
            key={format}
            type="button"
            role="radio"
            aria-checked={active}
            data-format={format}
            onClick={() => onChange(format)}
            className={cx(
              'rounded-xl border px-3 py-2.5 text-left transition-colors',
              active ? 'border-accent bg-accent-soft' : 'border-line-strong bg-panel hover:bg-panel2',
            )}
          >
            <span className={cx('block text-sm font-semibold', active && 'text-accent')}>{t(`format.${format}`)}</span>
            <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{t(`format.${format}Hint`)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function HomePage(): ReactNode {
  const { t } = useTranslation();
  const settings = useSettings();
  const history = useSession((state) => state.history);
  const [sources, setSources] = useState<SourceDocument[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [reading, setReading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ready = isConfigured(settings.ai);

  const addFiles = async (files: File[]): Promise<void> => {
    setReading((count) => count + files.length);
    for (const file of files) {
      try {
        const source = await ingest(file.name, new Uint8Array(await file.arrayBuffer()));
        setSources((current) => [...current.filter((item) => item.name !== source.name), source]);
      } catch (error) {
        setErrors((current) => [...current, fileErrorText(t, file.name, error)]);
      } finally {
        setReading((count) => count - 1);
      }
    }
  };

  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="mb-6">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight">{t('home.title')}</h1>
        <p className="mt-1.5 max-w-2xl text-[15px] text-muted">{t('home.subtitle')}</p>
      </div>

      {!ready && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-accent/30 bg-accent-soft px-5 py-4" data-testid="demo-banner">
          <Sparkles size={20} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">{t('home.demoTitle')}</div>
            <div className="text-[13px] text-muted">{t('home.demoText')}</div>
          </div>
          <Button onClick={() => void openSample()} icon={<Play size={15} />} data-testid="open-sample">
            {t('home.openSample')}
          </Button>
          <Button variant="primary" onClick={() => navigate({ name: 'settings' })}>
            {t('home.connectAi')}
          </Button>
        </div>
      )}

      <Card className="p-5 sm:p-6">
        <div
          role="button"
          tabIndex={0}
          data-testid="dropzone"
          onClick={() => input.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') input.current?.click();
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cx(
            'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-9 text-center transition-colors',
            dragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-panel2 hover:border-accent/60',
          )}
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent">
            <CloudUpload size={24} />
          </span>
          <div className="mt-3 text-[15px] font-medium">{dragging ? t('home.dropActive') : t('home.dropTitle')}</div>
          <div className="mt-1 max-w-lg text-xs leading-relaxed text-muted">{t('home.dropHint')}</div>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            accept={ACCEPTED_EXTENSIONS.join(',')}
            data-testid="file-input"
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
        </div>

        {(sources.length > 0 || reading > 0) && (
          <ul className="mt-4 space-y-2" data-testid="file-list">
            {sources.map((source) => {
              const Icon = KIND_ICON[source.kind];
              return (
                <li key={source.name} className="flex items-center gap-3 rounded-xl border border-line bg-panel px-3.5 py-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                    <Icon size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{source.name}</div>
                    <div className="text-xs text-muted">
                      {t(`home.kind${source.kind[0].toUpperCase()}${source.kind.slice(1)}`)} · {source.format}
                    </div>
                  </div>
                  <IconButton label={t('common.remove')} onClick={() => setSources(sources.filter((item) => item !== source))}>
                    <X size={16} />
                  </IconButton>
                </li>
              );
            })}
            {reading > 0 && (
              <li className="flex items-center gap-2 px-1 text-[13px] text-muted">
                <Spinner size={15} /> {t('home.reading')}
              </li>
            )}
          </ul>
        )}

        {errors.length > 0 && (
          <div className="mt-3 space-y-2">
            {errors.map((error, i) => (
              <Notice key={`${error}${i}`} tone="warn" icon={<CircleAlert size={16} className="text-warn" />}>
                <div className="flex items-start gap-2">
                  <span className="flex-1" data-testid="file-error">
                    {error}
                  </span>
                  <button type="button" aria-label={t('common.close')} onClick={() => setErrors(errors.filter((_, index) => index !== i))} className="text-muted hover:text-fg">
                    <X size={15} />
                  </button>
                </div>
              </Notice>
            ))}
          </div>
        )}

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <Field label={t('home.notesLabel')} optional={t('common.optional')}>
            <Textarea rows={5} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t('home.notesPlaceholder')} className="min-h-[132px]" />
          </Field>
          <div>
            <div className="mb-1.5 text-[13px] font-medium">{t('home.outputLabel')}</div>
            <FormatPicker value={settings.diagramFormat} onChange={(format) => settings.update({ diagramFormat: format })} />
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <button
            type="button"
            className="text-[13px] font-medium text-accent hover:underline"
            data-testid="use-sample"
            onClick={() => {
              const sample = sampleTranscript(settings.uiLanguage);
              setSources((current) => [...current.filter((item) => item.name !== sample.name), sample]);
            }}
          >
            {t('home.trySample')}
          </button>
          <div className="flex-1" />
          {!ready && <span className="text-xs text-muted">{t('home.analyzeNeedsAi')}</span>}
          <Button
            variant="primary"
            size="lg"
            disabled={!ready || sources.length === 0 || reading > 0}
            onClick={() => void startAnalysis({ sources, notes, format: settings.diagramFormat })}
            icon={<ArrowRight size={18} />}
            data-testid="analyze"
          >
            {t('home.analyze')}
          </Button>
        </div>
      </Card>

      <section className="mt-10">
        <h2 className="mb-3 text-lg font-semibold">{t('home.historyTitle')}</h2>
        {history.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center text-[13.5px] text-muted">{t('home.historyEmpty')}</p>
        ) : (
          <ul className="space-y-2" data-testid="history">
            {history.map((entry) => (
              <li key={entry.id} className="group flex items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3 shadow-card transition-colors hover:border-accent/50">
                <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => navigate({ name: 'analysis', id: entry.id })}>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <Workflow size={19} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{entry.title}</span>
                      {entry.sample && <Badge tone="accent">{t('home.sample')}</Badge>}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {formatDate(entry.createdAt, settings.uiLanguage)} · {t('home.historySteps', { count: entry.steps })}
                      {entry.reports > 0 && ` · ${t('home.historyReports', { count: entry.reports })}`} · {entry.files.join(', ')}
                    </span>
                  </span>
                </button>
                <Badge>{t(`format.${entry.format}`)}</Badge>
                <IconButton
                  label={t('common.delete')}
                  onClick={() => {
                    if (confirm(t('home.historyDelete'))) void removeAnalysis(entry.id);
                  }}
                >
                  <Trash2 size={16} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
