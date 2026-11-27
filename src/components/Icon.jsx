import React from 'react';
import iconsMap from '../icons.json';

export const iconChar = (name) => {
  const cp = iconsMap[name];
  if (!cp) return '';
  return String.fromCodePoint(parseInt(cp, 10));
};

export function AgentIcon({ size = 16, className = '', title, style }) {
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const hoodId = `ak-agent-hood-${uid}`;
  const faceId = `ak-agent-face-${uid}`;
  const crestId = `ak-agent-crest-${uid}`;
  const shadowId = `ak-agent-shadow-${uid}`;
  return (
    <span
      className={'icon akron-agent-icon ' + className}
      style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, ...style }}
      aria-hidden={title ? undefined : true}
      title={title}
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width={size} height={size} fill="none" style={{ display: 'block' }}>
        <defs>
          <radialGradient id={hoodId} cx="42%" cy="28%" r="72%">
            <stop offset="0%" stopColor="#34D399" />
            <stop offset="55%" stopColor="#10B981" />
            <stop offset="100%" stopColor="#047857" />
          </radialGradient>
          <radialGradient id={faceId} cx="50%" cy="38%" r="65%">
            <stop offset="0%" stopColor="#ECFDF5" />
            <stop offset="68%" stopColor="#A7F3D0" />
            <stop offset="100%" stopColor="#6EE7B7" />
          </radialGradient>
          <linearGradient id={crestId} x1="56" y1="10" x2="72" y2="26" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FEF08A" />
            <stop offset="50%" stopColor="#A3E635" />
            <stop offset="100%" stopColor="#16A34A" />
          </linearGradient>
          <filter id={shadowId} x="-15%" y="-15%" width="130%" height="130%">
            <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#022C22" floodOpacity="0.25" />
          </filter>
        </defs>
        <style>{`
          .akron-agent-head { animation: akAgentFloatBob 3.2s ease-in-out infinite; transform-origin: 64px 64px; }
          .akron-agent-eyes { animation: akAgentEyeBlink 4.5s ease-in-out infinite; transform-origin: 64px 68px; }
          .akron-agent-gem { animation: akAgentGemPulse 2.4s ease-in-out infinite; transform-origin: 64px 18px; }
          @keyframes akAgentFloatBob { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-4px); } }
          @keyframes akAgentEyeBlink { 0%, 90%, 100% { transform: scaleY(1); } 94% { transform: scaleY(0.08); } }
          @keyframes akAgentGemPulse { 0%, 100% { opacity: 0.85; transform: scale(1); } 50% { opacity: 1; transform: scale(1.12); } }
        `}</style>
        <g className="akron-agent-head" filter={`url(#${shadowId})`}>
          <rect x="10" y="54" width="10" height="26" rx="5" fill="#059669" stroke="#047857" strokeWidth="2" />
          <rect x="108" y="54" width="10" height="26" rx="5" fill="#059669" stroke="#047857" strokeWidth="2" />
          <rect x="18" y="20" width="92" height="92" rx="44" fill={`url(#${hoodId})`} stroke="#059669" strokeWidth="2.5" />
          <path d="M42 29 C54 23, 74 23, 86 29" stroke="#A7F3D0" strokeWidth="2.5" strokeLinecap="round" opacity="0.6" />
          <path className="akron-agent-gem" d="M64 11 L69 18 L64 25 L59 18 Z" fill={`url(#${crestId})`} stroke="#ECFCCB" strokeWidth="1.2" />
          <rect x="28" y="34" width="72" height="64" rx="30" fill={`url(#${faceId})`} stroke="#059669" strokeWidth="2" />
          <rect x="30" y="36" width="68" height="60" rx="28" stroke="#FFFFFF" strokeWidth="1.5" opacity="0.65" />
          <ellipse cx="42" cy="76" rx="6.5" ry="3.8" fill="#34D399" opacity="0.5" />
          <ellipse cx="86" cy="76" rx="6.5" ry="3.8" fill="#34D399" opacity="0.5" />
          <g className="akron-agent-eyes">
            <circle cx="48" cy="67" r="6" fill="#022C22" />
            <circle cx="46" cy="64.8" r="2" fill="#FFFFFF" />
            <circle cx="50" cy="69" r="0.9" fill="#A7F3D0" />
            <circle cx="80" cy="67" r="6" fill="#022C22" />
            <circle cx="78" cy="64.8" r="2" fill="#FFFFFF" />
            <circle cx="82" cy="69" r="0.9" fill="#A7F3D0" />
          </g>
          <path d="M58 75 Q64 81 70 75" stroke="#022C22" strokeWidth="2.4" strokeLinecap="round" fill="none" />
        </g>
      </svg>
    </span>
  );
}

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

export { ModelLogo, resolveModelBrand } from './ModelLogo.jsx';

export function GoogleDriveIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M8.5 3.5h7l6 10.5h-7L8.5 3.5Z" fill="#FFC107" />
      <path d="M2.5 14l3.5 6h12l3.5-6h-19Z" fill="#2684FC" />
      <path d="M8.5 3.5l-6 10.5 3.5 6 6-10.5-3.5-6Z" fill="#00AC47" />
    </svg>
  );
}
