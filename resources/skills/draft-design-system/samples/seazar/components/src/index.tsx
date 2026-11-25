import * as React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'quiet' }
/** The one button. Quiet by default; primary (the ink) at most once per view. */
export function Button({ variant = 'quiet', type = 'button', className, children, ...rest }: ButtonProps) {
  return <button {...rest} type={type} className={['sz-btn', 'sz-btn-' + variant, className].filter(Boolean).join(' ')}>{children}</button>;
}

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/* One 16px stroke glyph per tone, a different SHAPE each (check, triangle, cross, i), so the
 * tone reads without its color. Hidden from assistive technology: the chip's word says it. */
function Glyph({ tone }: { tone: StatusTone }) {
  if (tone === 'neutral') return null;
  const d =
    tone === 'success' ? 'M3 8.5l3.5 3.5L13 4.5' :
    tone === 'warning' ? 'M8 2.5l6.5 11h-13zM8 7v2.5M8 11.75v.01' :
    tone === 'danger' ? 'M4 4l8 8M12 4l-8 8' :
    'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM8 7.25v4M8 4.75v.01';
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

export interface StatusChipProps { tone?: StatusTone; children: React.ReactNode }
/** A status as a WORD in a chip; the glyph repeats the tone as a shape. Never empty, never an icon alone. */
export function StatusChip({ tone = 'neutral', children }: StatusChipProps) {
  return <span className={'sz-chip sz-chip-' + tone}><Glyph tone={tone} />{children}</span>;
}

export interface FieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'children'> { label: string; hint?: string; error?: string }
/** A labelled text input. The hint and the error are tied to the input with aria-describedby;
 * an error also sets aria-invalid and starts with the cross glyph, so it is not told by color. */
export function Field({ label, hint, error, id, className, 'aria-describedby': describedAlso, ...rest }: FieldProps) {
  const auto = React.useId();
  const inputId = id ?? 'sz-field' + auto;
  const hintId = hint !== undefined ? inputId + '-hint' : undefined;
  const errorId = error !== undefined ? inputId + '-error' : undefined;
  const describedBy = [errorId, hintId, describedAlso].filter(Boolean).join(' ') || undefined;
  return (
    <div className={['sz-field', error !== undefined ? 'sz-field-error' : '', className].filter(Boolean).join(' ')}>
      <label className="sz-label" htmlFor={inputId}>{label}</label>
      <input {...rest} id={inputId} className="sz-input" aria-invalid={error !== undefined ? true : undefined} aria-describedby={describedBy} />
      {hint !== undefined && <div className="sz-hint" id={hintId}>{hint}</div>}
      {error !== undefined && <div className="sz-error" id={errorId}><Glyph tone="danger" />{error}</div>}
    </div>
  );
}
