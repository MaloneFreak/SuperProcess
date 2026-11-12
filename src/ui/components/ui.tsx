/** Small, themed building blocks shared by every screen. */
import { LoaderCircle, X } from 'lucide-react';
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from '../../lib/util';

export function Logo({ size = 28 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="sp-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#sp-logo)" />
      <g fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="14" cy="32" r="5.5" />
        <path d="M19.5 32H25" />
        <path d="M32 21.5 42.5 32 32 42.5 21.5 32Z" />
        <path d="M42.5 32H46" />
        <circle cx="51" cy="32" r="5" fill="#fff" />
      </g>
    </svg>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
  icon?: ReactNode;
}

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-sm',
  secondary: 'bg-panel text-fg border border-line-strong hover:bg-panel2',
  ghost: 'text-muted hover:text-fg hover:bg-panel2',
  danger: 'bg-panel text-bad border border-line-strong hover:bg-bad-soft',
};

const BUTTON_SIZE = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-[10px]',
  lg: 'h-12 px-6 text-[15px] gap-2 rounded-xl',
};

export function Button({ variant = 'secondary', size = 'md', busy, icon, children, className, disabled, ...rest }: ButtonProps): ReactNode {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cx(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors disabled:opacity-50',
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        className,
      )}
    >
      {busy ? <LoaderCircle size={16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cx(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-panel2 hover:text-fg disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }): ReactNode {
  return <div className={cx('rounded-2xl border border-line bg-panel shadow-card', className)}>{children}</div>;
}

export function Field({ label, hint, optional, children, className }: { label: string; hint?: ReactNode; optional?: string; children: ReactNode; className?: string }): ReactNode {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1.5 flex items-baseline gap-2 text-[13px] font-medium text-fg">
        {label}
        {optional && <span className="font-normal text-faint">({optional})</span>}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const CONTROL =
  'w-full rounded-[10px] border border-line-strong bg-panel px-3 text-sm text-fg placeholder:text-faint transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60';

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input {...rest} className={cx(CONTROL, 'h-10', className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return <textarea {...rest} className={cx(CONTROL, 'resize-y py-2 leading-relaxed', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <select {...rest} className={cx(CONTROL, 'h-10 pr-8', className)}>
      {children}
    </select>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
}): ReactNode {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-[10px] border border-line-strong bg-panel2 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cx(
            'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors',
            option.value === value ? 'bg-panel text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'info';

const BADGE_TONE: Record<Tone, string> = {
  neutral: 'bg-panel2 text-muted border border-line',
  accent: 'bg-accent-soft text-accent',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }): ReactNode {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap', BADGE_TONE[tone], className)}>
      {children}
    </span>
  );
}

/** A progress bar. Without a `value` it shows an indeterminate shimmer. */
export function ProgressBar({ value, className }: { value?: number; className?: string }): ReactNode {
  return (
    <div className={cx('h-1.5 overflow-hidden rounded-full bg-line', className)} role="progressbar" aria-valuenow={value === undefined ? undefined : Math.round(value * 100)}>
      {value === undefined ? (
        <div className="h-full w-1/3 animate-pulse-soft rounded-full bg-accent" />
      ) : (
        <div className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out" style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
      )}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }): ReactNode {
  return <LoaderCircle size={size} className="animate-spin text-accent" />;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
  footer,
  closeLabel,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
  closeLabel: string;
}): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className={cx(
          'relative flex max-h-full w-full animate-rise flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-pop',
          wide ? 'max-w-[1080px]' : 'max-w-xl',
        )}
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0 flex-1 text-base font-semibold">{title}</div>
          <IconButton label={closeLabel} onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-panel2 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Notice({ tone, children, icon }: { tone: Tone; children: ReactNode; icon?: ReactNode }): ReactNode {
  return (
    <div className={cx('flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[13px] leading-relaxed', BADGE_TONE[tone])}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1 text-fg">{children}</div>
    </div>
  );
}
