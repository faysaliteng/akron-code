import type * as React from 'react';
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'quiet' }
export declare function Button(props: ButtonProps): React.ReactElement;
export interface BadgeProps { tone?: 'neutral' | 'ember' | 'leaf'; children?: React.ReactNode }
export declare function Badge(props: BadgeProps): React.ReactElement;
declare global { interface Window { Ember: { Button: typeof Button; Badge: typeof Badge } } }
