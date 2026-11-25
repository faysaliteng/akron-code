import * as React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'quiet' }
/** The one button. Primary (ember) at most once per view. */
export function Button({ variant = 'quiet', className, children, ...rest }: ButtonProps) {
  return <button {...rest} className={['em-btn', 'em-btn-' + variant, className].filter(Boolean).join(' ')}>{children}</button>;
}

export interface BadgeProps { tone?: 'neutral' | 'ember' | 'leaf'; children?: React.ReactNode }
/** One or two words of status. */
export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return <span className={'em-badge em-badge-' + tone}>{children}</span>;
}
