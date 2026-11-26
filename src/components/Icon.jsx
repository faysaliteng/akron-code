import React from 'react';
import iconsMap from '../icons.json';

export const iconChar = (name) => {
  const cp = iconsMap[name];
  if (!cp) return '';
  return String.fromCodePoint(parseInt(cp, 10));
};

export function Icon({ name, size = 16, className = '', title, style }) {
  return (
    <span
      className={'icon ' + className}
      style={{ fontSize: size, lineHeight: 1, width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', ...style }}
      aria-hidden={title ? undefined : true}
      title={title}
    >
      {iconChar(name)}
    </span>
  );
}

export function GoogleDriveIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M8.5 3.5h7l6 10.5h-7L8.5 3.5Z" fill="#FFC107" />
      <path d="M2.5 14l3.5 6h12l3.5-6h-19Z" fill="#2684FC" />
      <path d="M8.5 3.5l-6 10.5 3.5 6 6-10.5-3.5-6Z" fill="#00AC47" />
    </svg>
  );
}
