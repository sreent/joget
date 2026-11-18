import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useEffect, useId, useRef } from 'react';

/** Small building blocks in Ocean (via the Tailwind theme in styles.css). */

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' };

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-sm border font-medium whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-55',
        size === 'sm' ? 'px-2.5 py-1 text-sm' : 'px-3.5 py-1.5',
        variant === 'primary' && 'border-accent bg-accent text-accent-text hover:border-accent-strong hover:bg-accent-strong',
        variant === 'secondary' && 'border-line-strong bg-surface text-text hover:bg-sunken',
        variant === 'ghost' && 'border-transparent bg-transparent text-accent hover:bg-accent-soft',
        variant === 'danger' && 'border-bad bg-surface text-bad hover:bg-bad-bg',
        className,
      )}
      {...rest}
    />
  );
}

const control = 'rounded-sm border border-line-strong bg-surface px-2.5 py-1.5 text-text placeholder:text-faint';

/** Full width, unless the caller sizes the control: two width classes would leave the winner to the stylesheet's order. */
const sized = (className?: string) => (className && /(^|\s)(w-|flex-1)/.test(className) ? className : cx('w-full', className));

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(control, sized(className))} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(control, sized(className))} {...rest}>
      {children}
    </select>
  );
}

/** A labelled control. The label is tied to the control for screen readers. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="grid content-start gap-1">
      <label htmlFor={id} className="text-sm text-muted">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="m-0 text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const TONES = {
  idle: 'bg-idle-bg text-idle',
  good: 'bg-good-bg text-good',
  warn: 'bg-warn-bg text-warn',
  bad: 'bg-bad-bg text-bad',
  agent: 'bg-agent-soft text-agent',
  outside: 'bg-outside-bg text-outside',
  accent: 'bg-accent-soft text-accent',
} as const;

export function Badge({ tone = 'idle', children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-px text-xs font-semibold whitespace-nowrap', TONES[tone])}>{children}</span>;
}

/** A panel. With a label, it is a region that screen readers and tests find by its name. */
export function Card({ className, children, 'aria-label': label }: { className?: string; children: ReactNode; 'aria-label'?: string }) {
  return (
    <section aria-label={label} className={cx('rounded-lg border border-line bg-surface p-5 shadow-card', className)}>
      {children}
    </section>
  );
}

export function Notice({ tone, children }: { tone: 'bad' | 'warn' | 'good'; children: ReactNode }) {
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cx('rounded-md px-3 py-2 text-sm', TONES[tone])}>
      {children}
    </div>
  );
}

/** A modal dialog on the platform's <dialog>, which traps focus and closes on Escape. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  actions,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-text shadow-raised"
      aria-labelledby="dialog-title"
    >
      <div className="grid gap-4 p-5">
        <h2 id="dialog-title" className="m-0 text-lg font-semibold">
          {title}
        </h2>
        <div className="grid gap-3">{children}</div>
        <div className="flex justify-end gap-2">{actions}</div>
      </div>
    </dialog>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="grid place-items-center gap-2 rounded-lg border border-dashed border-line-strong p-8 text-center">
      <p className="m-0 font-semibold">{title}</p>
      {children ? <div className="text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export { cx };
