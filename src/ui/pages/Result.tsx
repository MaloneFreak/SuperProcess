/** The result of an analysis: diagram, BPMN check, notes, saving and reports. */
import { ArrowLeft, Check, ChevronDown, CircleAlert, Download, Info, Pencil, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { exportDiagram, type DiagramFormat } from '../../core/export';
import { layoutProcess } from '../../core/layout/layout';
import { computeStats } from '../../core/model/stats';
import type { ProcessNode } from '../../core/model/types';
import { validateModel, type Severity } from '../../core/model/validate';
import { formatDate } from '../../core/report/document';
import { renderSvg } from '../../core/render/svg';
import { DIAGRAM_STYLES, getTheme, type DiagramStyle } from '../../core/render/theme';
import { saveFile } from '../../lib/save';
import { cx } from '../../lib/util';
import type { Analysis } from '../../state/history';
import { loadAnalysis } from '../../state/history';
import { navigate, toast, updateAnalysis, useSession } from '../../state/session';
import { DIAGRAM_FORMATS, isDark, useSettings } from '../../state/settings';
import { DiagramViewer } from '../components/DiagramViewer';
import { ReportsPanel } from '../components/Reports';
import { Badge, Button, Card, Segmented, Spinner, type Tone } from '../components/ui';

type Tab = 'overview' | 'quality' | 'notes' | 'step';

const SEVERITY_TONE: Record<Severity, Tone> = { error: 'bad', warning: 'warn', info: 'info' };
const SEVERITY_ICON = { error: CircleAlert, warning: TriangleAlert, info: Info };

function SaveButton({ analysis, onSave, busy }: { analysis: Analysis; onSave: (format: DiagramFormat) => void; busy: boolean }): ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={box} className="relative flex">
      <Button variant="primary" busy={busy} className="rounded-r-none" onClick={() => onSave(analysis.format)} icon={<Download size={16} />} data-testid="save-diagram">
        {t('result.saveAs', { format: t(`format.${analysis.format}`) })}
      </Button>
      <Button variant="primary" className="rounded-l-none border-l border-white/25 px-2.5" aria-label={t('result.otherFormats')} aria-expanded={open} onClick={() => setOpen(!open)} data-testid="save-menu">
        <ChevronDown size={16} />
      </Button>
      {open && (
        <div className="absolute top-full right-0 z-30 mt-2 w-72 animate-rise rounded-xl border border-line bg-panel p-1.5 shadow-pop" role="menu">
          {DIAGRAM_FORMATS.map((format) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              data-format={format}
              onClick={() => {
                setOpen(false);
                onSave(format);
              }}
              className="block w-full rounded-lg px-3 py-2 text-left hover:bg-panel2"
            >
              <span className="block text-sm font-medium">{t(`format.${format}`)}</span>
              <span className="block text-xs leading-snug text-muted">{t(`format.${format}Hint`)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <div className="rounded-xl border border-line bg-panel2 px-3 py-2.5">
      <div className="text-xl leading-tight font-semibold tabular-nums">{value}</div>
      <div className="text-xs leading-snug text-muted">{label}</div>
    </div>
  );
}

function ListBlock({ title, items }: { title: string; items: string[] }): ReactNode {
  const { t } = useTranslation();
  return (
    <div>
      <h3 className="mb-1.5 text-[13px] font-semibold">{title}</h3>
      {items.length === 0 ? (
        <p className="text-[13px] text-faint">{t('common.none')}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-muted">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong" />
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StepDetails({ node, analysis }: { node: ProcessNode; analysis: Analysis }): ReactNode {
  const { t } = useTranslation();
  const lane = analysis.model.lanes.find((item) => item.id === node.lane)?.name ?? '';
  const findings = analysis.reports.flatMap((report) => report.content.findings.filter((finding) => finding.steps.includes(node.id)));
  const row = (label: string, value: ReactNode): ReactNode => (
    <div>
      <dt className="text-xs font-medium text-faint">{label}</dt>
      <dd className="mt-0.5 text-[13px] leading-relaxed">{value}</dd>
    </div>
  );
  return (
    <div className="space-y-3" data-testid="step-details">
      <h3 className="text-base font-semibold">{node.name || t(`nodeType.${node.type}`)}</h3>
      <dl className="space-y-3">
        {row(t('result.fieldType'), t(`nodeType.${node.type}`))}
        {lane && row(t('result.fieldLane'), lane)}
        {node.description && row(t('result.fieldDescription'), node.description)}
        {node.systems.length > 0 && row(t('result.fieldSystems'), node.systems.join(', '))}
        {node.inputs.length > 0 && row(t('result.fieldInputs'), node.inputs.join(', '))}
        {node.outputs.length > 0 && row(t('result.fieldOutputs'), node.outputs.join(', '))}
        {node.duration && row(t('result.fieldDuration'), node.duration)}
        {node.issues.length > 0 &&
          row(
            t('result.fieldIssues'),
            <ul className="space-y-1">
              {node.issues.map((issue, i) => (
                <li key={i} className="flex gap-2">
                  <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" />
                  {issue}
                </li>
              ))}
            </ul>,
          )}
        {findings.length > 0 &&
          row(
            t('result.fieldFindings'),
            <ul className="space-y-1">
              {findings.map((finding, i) => (
                <li key={i}>{finding.title}</li>
              ))}
            </ul>,
          )}
      </dl>
    </div>
  );
}

export function ResultPage({ id }: { id: string }): ReactNode {
  const { t } = useTranslation();
  const settings = useSettings();
  const current = useSession((state) => state.current);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const analysis = current?.id === id ? current : null;

  useEffect(() => {
    let cancelled = false;
    setMissing(false);
    setSelected(null);
    setTab('overview');
    if (useSession.getState().current?.id !== id) {
      void loadAnalysis(id).then((loaded) => {
        if (cancelled) return;
        if (loaded) useSession.setState({ current: loaded });
        else setMissing(true);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [id]);

  const model = analysis?.model;
  const layout = useMemo(() => (model ? layoutProcess(model) : null), [model]);
  const validation = useMemo(() => (model ? validateModel(model) : null), [model]);
  const stats = useMemo(() => (model ? computeStats(model) : null), [model]);
  const dark = isDark(settings.theme);
  const theme = getTheme(settings.diagramStyle, dark);
  const svg = useMemo(
    () =>
      model && layout
        ? renderSvg(model, layout, {
            theme,
            interactive: true,
            highlights: selected ? { [selected]: { color: dark ? '#818cf8' : '#4f46e5' } } : undefined,
          })
        : '',
    [model, layout, theme, selected, dark],
  );

  if (missing) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <p className="text-muted">{t('result.notFound')}</p>
        <Button className="mt-4" onClick={() => navigate({ name: 'home' })} icon={<ArrowLeft size={16} />}>
          {t('result.allAnalyses')}
        </Button>
      </div>
    );
  }
  if (!analysis || !model || !layout || !validation || !stats) {
    return (
      <div className="flex justify-center py-24">
        <Spinner size={28} />
      </div>
    );
  }

  const save = async (format: DiagramFormat): Promise<void> => {
    setSaving(true);
    try {
      const file = await exportDiagram(format, model, layout, settings.diagramStyle);
      if (await saveFile(file.blob, file.fileName)) toast(t('result.saved', { name: file.fileName }));
    } catch (error) {
      toast(t('error.unknown', { message: error instanceof Error ? error.message : String(error) }), 'error');
    } finally {
      setSaving(false);
    }
  };

  const rename = (title: string): void => {
    setEditing(false);
    const clean = title.trim();
    if (clean && clean !== analysis.title) {
      void updateAnalysis(analysis.id, (latest) => ({ ...latest, title: clean, model: { ...latest.model, name: clean } }));
    }
  };

  const select = (nodeId: string | null): void => {
    setSelected(nodeId);
    if (nodeId) setTab('step');
  };
  const selectedNode = model.nodes.find((node) => node.id === selected);
  const findings = validation.issues.length;
  const tabs: { id: Tab; label: string; badge?: ReactNode }[] = [
    { id: 'overview', label: t('result.tabOverview') },
    {
      id: 'quality',
      label: t('result.tabQuality'),
      badge: <Badge tone={validation.counts.error > 0 ? 'bad' : validation.counts.warning > 0 ? 'warn' : 'ok'}>{validation.score}</Badge>,
    },
    { id: 'notes', label: t('result.tabNotes') },
    { id: 'step', label: t('result.tabStep') },
  ];

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6">
      <button type="button" onClick={() => navigate({ name: 'home' })} className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-fg">
        <ArrowLeft size={15} /> {t('result.allAnalyses')}
      </button>

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              defaultValue={analysis.title}
              onBlur={(event) => rename(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') rename(event.currentTarget.value);
                if (event.key === 'Escape') setEditing(false);
              }}
              className="w-full max-w-xl rounded-lg border border-accent bg-panel px-2 py-1 text-2xl font-semibold tracking-tight focus:outline-none"
            />
          ) : (
            <h1 className="group flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <span className="truncate" data-testid="analysis-title">
                {analysis.title}
              </span>
              <button type="button" aria-label={t('result.rename')} title={t('result.rename')} onClick={() => setEditing(true)} className="rounded-md p-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg focus:opacity-100">
                <Pencil size={15} />
              </button>
              {analysis.sample && <Badge tone="accent">{t('home.sample')}</Badge>}
            </h1>
          )}
          <p className="mt-0.5 truncate text-[13px] text-muted">
            {formatDate(analysis.createdAt, settings.uiLanguage)}
            {analysis.aiModel && ` · ${t('result.mappedBy', { model: analysis.aiModel })}`}
          </p>
        </div>
        <Segmented<DiagramStyle>
          label={t('style.label')}
          value={settings.diagramStyle}
          onChange={(value) => settings.update({ diagramStyle: value })}
          options={DIAGRAM_STYLES.map((style) => ({ value: style, label: t(`style.${style}`) }))}
        />
        <SaveButton analysis={analysis} onSave={(format) => void save(format)} busy={saving} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="h-[460px] lg:h-[calc(100vh-250px)] lg:min-h-[480px]">
          <DiagramViewer svg={svg} width={layout.width} height={layout.height} background={theme.background} onSelect={select} />
        </div>

        <Card className="flex max-h-[calc(100vh-250px)] min-h-[320px] flex-col overflow-hidden lg:min-h-[480px]">
          <div className="flex gap-0.5 overflow-x-auto border-b border-line px-2 pt-2" role="tablist">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                data-tab={item.id}
                onClick={() => setTab(item.id)}
                className={cx(
                  '-mb-px inline-flex shrink-0 items-center gap-1.5 rounded-t-lg border-b-2 px-2.5 py-2 text-[13px] font-medium whitespace-nowrap',
                  tab === item.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
                )}
              >
                {item.label}
                {item.badge}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {tab === 'overview' && (
              <>
                {model.summary && <p className="text-[13.5px] leading-relaxed text-muted">{model.summary}</p>}
                <div className="grid grid-cols-2 gap-2">
                  <Stat label={t('result.statActivities')} value={stats.activities} />
                  <Stat label={t('result.statDecisions')} value={stats.decisions} />
                  <Stat label={t('result.statLanes')} value={stats.lanes} />
                  <Stat label={t('result.statHandoffs')} value={stats.handoffs} />
                  <Stat label={t('result.statSystems')} value={stats.systems.length} />
                  <Stat label={t('result.statLoops')} value={stats.loops} />
                  <Stat label={t('result.statExternals')} value={stats.externals} />
                  <Stat label={t('result.statIssues')} value={stats.stepsWithIssues} />
                </div>
                <ListBlock title={t('result.sources')} items={analysis.sources.map((source) => `${source.name} (${source.format})`)} />
              </>
            )}

            {tab === 'quality' && (
              <>
                <div className="flex items-center gap-4 rounded-xl border border-line bg-panel2 px-4 py-3">
                  <div className={cx('text-4xl font-bold tabular-nums', validation.counts.error > 0 ? 'text-bad' : validation.score >= 85 ? 'text-ok' : 'text-warn')} data-testid="bpmn-score">
                    {validation.score}
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{t('result.qualityScore')}</div>
                    <div className="text-xs text-muted">{t('result.qualityChecked', { count: validation.rulesChecked })}</div>
                  </div>
                </div>
                {findings === 0 ? (
                  <p className="flex items-center gap-2 text-[13px] font-medium text-ok">
                    <Check size={16} /> {t('result.qualityClean')}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {validation.issues.map((issue, i) => {
                      const Icon = SEVERITY_ICON[issue.severity];
                      return (
                        <li key={i}>
                          <button
                            type="button"
                            disabled={issue.nodeIds.length === 0}
                            onClick={() => setSelected(issue.nodeIds[0] ?? null)}
                            className="flex w-full items-start gap-2.5 rounded-xl border border-line px-3 py-2.5 text-left enabled:hover:bg-panel2"
                          >
                            <Icon size={16} className={cx('mt-0.5 shrink-0', issue.severity === 'error' ? 'text-bad' : issue.severity === 'warning' ? 'text-warn' : 'text-info')} />
                            <span className="min-w-0 flex-1 text-[13px] leading-relaxed">{t(`validation.${issue.code}`, issue.params)}</span>
                            <Badge tone={SEVERITY_TONE[issue.severity]}>{t(`result.severity${issue.severity[0].toUpperCase()}${issue.severity.slice(1)}`)}</Badge>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {analysis.repairs.length > 0 && <ListBlock title={t('result.repairsTitle')} items={analysis.repairs.map((repair) => t(`repair.${repair.code}`, repair.params))} />}
              </>
            )}

            {tab === 'notes' && (
              <>
                <ListBlock title={t('result.assumptions')} items={model.assumptions} />
                <ListBlock title={t('result.openQuestions')} items={model.openQuestions} />
              </>
            )}

            {tab === 'step' && (selectedNode ? <StepDetails node={selectedNode} analysis={analysis} /> : <p className="text-[13px] text-muted">{t('result.stepHint')}</p>)}
          </div>
        </Card>
      </div>

      <div className="mt-5">
        <ReportsPanel analysis={analysis} layout={layout} />
      </div>
    </div>
  );
}
