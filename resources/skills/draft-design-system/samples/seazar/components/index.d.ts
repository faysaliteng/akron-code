import type * as React from 'react';
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'quiet' }
export declare function Button(props: ButtonProps): React.ReactElement;
export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export interface StatusChipProps { tone?: StatusTone; children: React.ReactNode }
export declare function StatusChip(props: StatusChipProps): React.ReactElement;
export interface FieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'children'> { label: string; hint?: string; error?: string }
export declare function Field(props: FieldProps): React.ReactElement;
declare global { interface Window { Seazar: { Button: typeof Button; StatusChip: typeof StatusChip; Field: typeof Field } } }
