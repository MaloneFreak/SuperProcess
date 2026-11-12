/** The loading screen shown while the AI maps the process. */
import { Check, CircleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cx } from '../../lib/util';
import { aiIsLocal, cancelAnalysis, navigate, retryAnalysis, useSession, type Work } from '../../state/session';
import { useSettings } from '../../state/settings';
import { failureText } from '../errors';
import { Button, Card, Spinner } from '../components/ui';

type Stage = Work['stage'];
const ORDER: Stage[] = ['read', 'condense', 'model', 'check', 'repair', 'layout'];
/** Stages that only appear when they actually happen. */
const OPTIONAL: Stage[] = ['condense', 'repair'];

function FlowAnimation(): ReactNode {
  return (
    <svg viewBox="0 0 320 84" className="mx-auto h-20 w-full max-w-[320px]" aria-hidden="true">
      <g fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="6 8" className="animate-flow">
        <path d="M42 42H86" />
        <path d="M150 42H178" />
        <path d="M222 42H262" />
      </g>
      <g fill="var(--panel)" stroke="var(--accent)" strokeWidth="2.2">
        <circle cx="28" cy="42" r="13" />
        <rect x="88" y="22" width="62" height="40" rx="9" />
        <path d="M200 20 222 42 200 64 178 42Z" />
        <circle cx="278" cy="42" r="13" strokeWidth="4.5" />
      </g>
      <g stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" className="animate-pulse-soft">
        <path d="M100 36H138M100 48H126" />
        <path d="M193 35 207 49M207 35 193 49" />
      </g>
    </svg>
  );
}

export function WorkingPage(): ReactNode {
  const { t } = useTranslation();
  const work = useSession((state) => state.work);
  const model = useSettings((state) => state.ai.model);
  const [seconds, setSeconds] = useState(0);
  const seen = useRef(new Set<Stage>());

  useEffect(() => {
    if (!work || work.status !== 'running') return;
    const tick = (): void => setSeconds(Math.floor((Date.now() - work.startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [work?.startedAt, work?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!work) return null;
  seen.current.add(work.stage);

  if (work.status === 'error' && work.error) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <Card className="p-8 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-bad-soft text-bad">
            <CircleAlert size={28} />
          </span>
          <h1 className="mt-4 text-xl font-semibold">{t('working.errorTitle')}</h1>
          <p className="mt-2 leading-relaxed text-muted" data-testid="work-error">
            {failureText(t, work.error, model, aiIsLocal())}
          </p>
          <div className="mt-6 flex justify-center gap-2">
            <Button
              onClick={() => {
                useSession.setState({ work: null });
                navigate({ name: 'home' });
              }}
            >
              {t('common.back')}
            </Button>
            <Button variant="primary" onClick={retryAnalysis}>
              {t('common.retry')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const current = ORDER.indexOf(work.stage);
  const stages = ORDER.filter((stage) => !OPTIONAL.includes(stage) || seen.current.has(stage));
  const nodes = work.progress?.nodes ?? 0;

  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:py-16">
      <Card className="p-8">
        <FlowAnimation />
        <h1 className="mt-4 text-center text-xl font-semibold">{t('working.title')}</h1>
        <p className="mt-1 text-center text-[13px] text-muted tabular-nums">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        </p>

        <ol className="mx-auto mt-6 max-w-sm space-y-3" data-testid="work-stages">
          {stages.map((stage) => {
            const index = ORDER.indexOf(stage);
            const done = index < current;
            const active = index === current;
            return (
              <li key={stage} className="flex items-start gap-3">
                <span
                  className={cx(
                    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                    done ? 'bg-ok-soft text-ok' : active ? '' : 'border border-line-strong',
                  )}
                >
                  {done ? <Check size={13} strokeWidth={3} /> : active ? <Spinner size={18} /> : null}
                </span>
                <span className="min-w-0">
                  <span className={cx('block text-sm', active ? 'font-medium text-fg' : done ? 'text-muted' : 'text-faint')}>{t(`working.${stage}`)}</span>
                  {active && stage === 'condense' && work.progress?.parts && (
                    <span className="block text-xs text-muted">{t('working.condensePart', { part: work.progress.part, parts: work.progress.parts })}</span>
                  )}
                  {active && (stage === 'model' || stage === 'repair') && nodes > 0 && (
                    <span className="block text-xs text-muted">{t('working.found', { count: nodes })}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>

        <p className="mx-auto mt-6 max-w-sm text-center text-xs leading-relaxed text-faint">{t('working.hint')}</p>
        <div className="mt-5 flex justify-center">
          <Button variant="ghost" onClick={cancelAnalysis} data-testid="cancel-analysis">
            {t('common.cancel')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
