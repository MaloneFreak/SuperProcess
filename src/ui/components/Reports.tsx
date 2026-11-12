/** Choosing report angles, generating several reports at once, viewing and saving them. */
import { Check, ChevronDown, CircleAlert, Download, Eye, FileText, Sparkles, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { OUTPUT_LANGUAGES } from '../../ai/prompts';
import { isConfigured } from '../../ai/registry';
import { exportReport, zipFiles, type ReportFormat } from '../../core/export';
import type { DiagramLayout } from '../../core/layout/layout';
import { CUSTOM_FOCUS_ID, FOCUSES, FOCUS_CATEGORIES } from '../../core/report/focuses';
import { REPORT_CSS, blocksToHtml, buildReportDocument, findingHighlights, formatDate } from '../../core/report/document';
import type { Report } from '../../core/report/types';
import { renderSvg } from '../../core/render/svg';
import { getTheme } from '../../core/render/theme';
import { translatorFor } from '../../i18n';
import { saveFile, safeFileName } from '../../lib/save';
import { cx } from '../../lib/util';
import type { Analysis } from '../../state/history';
import { aiIsLocal, deleteReport, dismissReportJob, startReports, toast, useSession, type ReportJob } from '../../state/session';
import { REPORT_FORMATS, isDark, useSettings } from '../../state/settings';
import { failureText } from '../errors';
import { Badge, Button, Field, IconButton, Modal, Notice, ProgressBar, Select, Textarea } from './ui';

/** A report runs to roughly this many characters; used to pace the progress bar. */
const EXPECTED_CHARS = 14_000;

function useFocusName(): (focusId: string, language?: string) => string {
  const { t } = useTranslation();
  return (focusId, language) => {
    const tr = language ? translatorFor(language) : t;
    return focusId === CUSTOM_FOCUS_ID ? tr('reports.customName') : tr(`focus.${focusId}.name`);
  };
}

function FocusPicker({ selected, onToggle }: { selected: Set<string>; onToggle: (id: string) => void }): ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const Option = ({ id, name, description }: { id: string; name: string; description: string }): ReactNode => {
    const checked = selected.has(id);
    return (
      <button
        type="button"
        role="option"
        aria-selected={checked}
        data-focus={id}
        onClick={() => onToggle(id)}
        className="flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-panel2"
      >
        <span
          className={cx(
            'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border',
            checked ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong bg-panel',
          )}
        >
          {checked && <Check size={13} strokeWidth={3} />}
        </span>
        <span className="min-w-0">
          <span className="block text-[13.5px] font-medium">{name}</span>
          <span className="block text-xs leading-snug text-muted">{description}</span>
        </span>
      </button>
    );
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="focus-picker"
        onClick={() => setOpen(!open)}
        className="flex h-11 w-full items-center gap-2 rounded-[10px] border border-line-strong bg-panel px-3.5 text-left text-sm hover:bg-panel2"
      >
        <Sparkles size={16} className="shrink-0 text-accent" />
        <span className={cx('min-w-0 flex-1 truncate', selected.size === 0 && 'text-muted')}>
          {selected.size === 0 ? t('reports.choose') : t('reports.selected', { count: selected.size })}
        </span>
        <ChevronDown size={16} className={cx('shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div role="listbox" aria-multiselectable="true" className="absolute z-30 mt-2 max-h-[440px] w-full min-w-[320px] animate-rise overflow-y-auto rounded-xl border border-line bg-panel p-2 shadow-pop">
          {FOCUS_CATEGORIES.map((category) => (
            <div key={category} className="mb-1">
              <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">
                {t(`reports.cat${category[0].toUpperCase()}${category.slice(1)}`)}
              </div>
              {FOCUSES.filter((focus) => focus.category === category).map((focus) => (
                <Option key={focus.id} id={focus.id} name={t(`focus.${focus.id}.name`)} description={t(`focus.${focus.id}.description`)} />
              ))}
            </div>
          ))}
          <div className="mt-1 border-t border-line pt-1">
            <Option id={CUSTOM_FOCUS_ID} name={t('reports.customName')} description={t('reports.customDescription')} />
          </div>
        </div>
      )}
    </div>
  );
}

function JobRow({ job, model }: { job: ReportJob; model: string }): ReactNode {
  const { t } = useTranslation();
  const focusName = useFocusName();
  const failed = job.status === 'error';
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3" data-testid="report-job">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{focusName(job.focusId)}</div>
          <div className={cx('text-xs', failed ? 'text-bad' : 'text-muted')}>
            {failed ? t('reports.failed') : job.status === 'queued' ? t('reports.queued') : t('reports.running')}
          </div>
        </div>
        <IconButton label={t('common.cancel')} onClick={() => dismissReportJob(job.id)}>
          <X size={16} />
        </IconButton>
      </div>
      {failed && job.error ? (
        <p className="mt-2 text-[13px] text-muted">{failureText(t, job.error, model, aiIsLocal())}</p>
      ) : (
        <ProgressBar className="mt-2" value={job.status === 'queued' ? 0 : Math.min(0.95, 0.04 + (job.chars / EXPECTED_CHARS) * 0.9)} />
      )}
    </div>
  );
}

export function ReportsPanel({ analysis, layout }: { analysis: Analysis; layout: DiagramLayout }): ReactNode {
  const { t } = useTranslation();
  const settings = useSettings();
  const focusName = useFocusName();
  const jobs = useSession((state) => state.reportJobs).filter((job) => job.analysisId === analysis.id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [custom, setCustom] = useState('');
  const [instructions, setInstructions] = useState('');
  const [language, setLanguage] = useState('auto');
  const [viewing, setViewing] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const ready = isConfigured(settings.ai);

  const toggle = (id: string): void => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const customMissing = selected.has(CUSTOM_FOCUS_ID) && !custom.trim();

  const generate = (): void => {
    const requests = [...selected].map((focusId) => ({
      focusId,
      instructions: focusId === CUSTOM_FOCUS_ID ? [custom.trim(), instructions.trim()].filter(Boolean).join('\n\n') : instructions.trim(),
    }));
    setSelected(new Set());
    void startReports(analysis.id, requests, language);
  };

  const download = async (report: Report, format: ReportFormat): Promise<void> => {
    setSaving(report.id);
    try {
      const tr = translatorFor(report.language);
      const file = await exportReport(format, report, analysis.model, layout, settings.diagramStyle, focusName(report.focusId, report.language), tr);
      if (await saveFile(file.blob, file.fileName)) toast(t('result.saved', { name: file.fileName }));
    } catch (error) {
      toast(t('error.unknown', { message: error instanceof Error ? error.message : String(error) }), 'error');
    } finally {
      setSaving(null);
    }
  };

  const saveAll = async (): Promise<void> => {
    setSaving('all');
    try {
      const files = [];
      for (const report of analysis.reports) {
        const tr = translatorFor(report.language);
        files.push(await exportReport(settings.reportFormat, report, analysis.model, layout, settings.diagramStyle, focusName(report.focusId, report.language), tr));
      }
      const name = `${safeFileName(analysis.title)} - ${t('reports.title')}.zip`;
      if (await saveFile(await zipFiles(files), name)) toast(t('result.saved', { name }));
    } catch (error) {
      toast(t('error.unknown', { message: error instanceof Error ? error.message : String(error) }), 'error');
    } finally {
      setSaving(null);
    }
  };

  const viewed = analysis.reports.find((report) => report.id === viewing);
  const reports = [...analysis.reports].reverse();

  return (
    <section className="rounded-2xl border border-line bg-panel p-5 shadow-card sm:p-6" data-testid="reports">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{t('reports.title')}</h2>
          <p className="mt-0.5 max-w-3xl text-[13.5px] text-muted">{t('reports.subtitle')}</p>
        </div>
        {analysis.reports.length > 1 && (
          <Button onClick={saveAll} busy={saving === 'all'} icon={<Download size={16} />} data-testid="save-all">
            {t('reports.saveAll')}
          </Button>
        )}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <FocusPicker selected={selected} onToggle={toggle} />
          {selected.size > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {[...selected].map((id) => (
                <button key={id} type="button" onClick={() => toggle(id)} className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-1 pr-2 pl-3 text-xs font-medium text-accent hover:opacity-80">
                  {focusName(id)} <X size={13} />
                </button>
              ))}
            </div>
          )}
          {selected.has(CUSTOM_FOCUS_ID) && (
            <Textarea rows={3} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={t('reports.customPlaceholder')} data-testid="custom-focus" />
          )}
          <Field label={t('reports.instructionsLabel')} optional={t('common.optional')}>
            <Textarea rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={t('reports.instructionsPlaceholder')} />
          </Field>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('reports.languageLabel')}>
              <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="auto">{t('reports.languageAuto')}</option>
                {OUTPUT_LANGUAGES.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('reports.formatLabel')}>
              <Select value={settings.reportFormat} onChange={(e) => settings.update({ reportFormat: e.target.value as ReportFormat })} data-testid="report-format">
                {REPORT_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {t(`format.${format}`)} (.{format})
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button variant="primary" size="lg" className="w-full" disabled={!ready || selected.size === 0 || customMissing} onClick={generate} icon={<Sparkles size={17} />} data-testid="generate-reports">
            {t('reports.generate', { count: Math.max(1, selected.size) })}
          </Button>
          {!ready && (
            <Notice tone="info" icon={<CircleAlert size={16} className="text-info" />}>
              {t('reports.needAi')}
            </Notice>
          )}
        </div>
      </div>

      <div className="mt-6 space-y-2.5">
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} model={settings.ai.model} />
        ))}
        {reports.map((report) => (
          <div key={report.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3" data-testid="report-row">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <FileText size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{report.content.title || focusName(report.focusId)}</div>
              <div className="truncate text-xs text-muted">
                {focusName(report.focusId)} · {t('reports.writtenBy', { model: report.model, date: formatDate(report.createdAt, settings.uiLanguage) })}
              </div>
            </div>
            <ScoreBadge value={report.content.score.value} />
            <Button size="sm" onClick={() => setViewing(report.id)} icon={<Eye size={15} />}>
              {t('reports.view')}
            </Button>
            <Button size="sm" variant="primary" busy={saving === report.id} onClick={() => download(report, settings.reportFormat)} icon={<Download size={15} />} data-testid="download-report">
              {t(`format.${settings.reportFormat}`)}
            </Button>
            <IconButton
              label={t('common.delete')}
              onClick={() => {
                if (confirm(t('reports.deleteConfirm'))) void deleteReport(analysis.id, report.id);
              }}
            >
              <Trash2 size={16} />
            </IconButton>
          </div>
        ))}
        {jobs.length === 0 && reports.length === 0 && <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[13.5px] text-muted">{t('reports.empty')}</p>}
      </div>

      {viewed && (
        <ReportViewer analysis={analysis} layout={layout} report={viewed} onClose={() => setViewing(null)} onDownload={(format) => download(viewed, format)} busy={saving === viewed.id} />
      )}
    </section>
  );
}

function ScoreBadge({ value }: { value: number }): ReactNode {
  return <Badge tone={value >= 75 ? 'ok' : value >= 50 ? 'warn' : 'bad'}>{value}/100</Badge>;
}

function ReportViewer({
  analysis,
  layout,
  report,
  onClose,
  onDownload,
  busy,
}: {
  analysis: Analysis;
  layout: DiagramLayout;
  report: Report;
  onClose: () => void;
  onDownload: (format: ReportFormat) => void;
  busy: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const settings = useSettings();
  const focusName = useFocusName();
  const dark = isDark(settings.theme);

  const html = useMemo(() => {
    const tr = translatorFor(report.language);
    const doc = buildReportDocument(report, analysis.model, focusName(report.focusId, report.language), tr);
    const svg = renderSvg(analysis.model, layout, { theme: getTheme(settings.diagramStyle, dark), highlights: findingHighlights(report) });
    const meta = doc.meta.map(([label, value]) => `<b>${label.replace(/</g, '&lt;')}</b><span>${value.replace(/</g, '&lt;')}</span>`).join('');
    return {
      title: doc.title,
      body: `<div class="meta">${meta}</div>${blocksToHtml(doc, svg)}<p class="disclaimer">${doc.disclaimer.replace(/</g, '&lt;')}</p>`,
    };
    // focusName is derived from the translation function and is stable per language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, analysis.model, layout, settings.diagramStyle, dark]);

  return (
    <Modal
      wide
      onClose={onClose}
      closeLabel={t('common.close')}
      title={
        <span className="flex items-center gap-3">
          <span className="truncate">{html.title}</span>
          <ScoreBadge value={report.content.score.value} />
          <span className="hidden text-xs font-normal text-muted sm:inline">{t('reports.viewerFindings', { count: report.content.findings.length })}</span>
        </span>
      }
      footer={
        <>
          {REPORT_FORMATS.map((format) => (
            <Button key={format} size="sm" variant={format === settings.reportFormat ? 'primary' : 'secondary'} busy={busy && format === settings.reportFormat} onClick={() => onDownload(format)} icon={<Download size={14} />}>
              {t(`format.${format}`)}
            </Button>
          ))}
        </>
      }
    >
      <style>{REPORT_CSS}</style>
      <div
        className="report px-6 py-6 sm:px-10"
        data-testid="report-view"
        style={{ '--r-fg': 'var(--fg)', '--r-muted': 'var(--muted)', '--r-line': 'var(--line)', '--r-soft': 'var(--panel-2)' } as React.CSSProperties}
        dangerouslySetInnerHTML={{ __html: html.body }}
      />
    </Modal>
  );
}
