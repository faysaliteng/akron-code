// Helio Bot — connector / plugin card artwork.
//
// <ConnectorLogo> paints, in order of preference:
//   1. the service's own icon (apple-touch-icon, then favicon), lazily loaded,
//   2. a monogram tile derived from the name,
//   3. for role plugins, a stroked glyph tile.
// The monogram is always painted underneath, so there is never a flash of an
// empty box and never a broken-image icon.
import { useState, useMemo } from 'react';
import { domainFor, logoSources, monogram, glyphFor, isRoleCard, iconOverride } from './logos.js';

const GLYPHS = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 17-4.35-4.35',
  chart: 'M4 20V9M10 20V4M16 20v-7M22 20H2',
  layout: 'M3 4h18v16H3zM3 9h18M9 9v11',
  doc: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  slides: 'M3 4h18v12H3zM8 20h8M12 16v4',
  grid: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  code: 'm9 7-5 5 5 5M15 7l5 5-5 5',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  check: 'm4 12 5 5L20 6',
  terminal: 'M3 4h18v16H3zM7 9l3 3-3 3M13 15h4',
  database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3ZM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  flow: 'M4 5h6v6H4zM14 13h6v6h-6zM7 11v3h7',
  film: 'M3 4h18v16H3zM3 9h18M3 15h18M8 4v16M16 4v16',
  book: 'M4 4h7v16H4zM13 4h7v16h-7z',
  pen: 'M4 20h4L20 8l-4-4L4 16zM14 6l4 4',
  share: 'M12 3v12M8 7l4-4 4 4M5 13v7h14v-7',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  clipboard: 'M9 3h6v4H9zM6 5h12v16H6zM9 12h6M9 16h4',
  access: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 21c0-4 4-6 8-6s8 2 8 6',
  network: 'M12 3v6M12 15v6M6 12H3M21 12h-3M7.5 7.5 5 5M16.5 16.5 19 19M16.5 7.5 19 5M7.5 16.5 5 19',
  alert: 'M12 3 2 21h20zM12 9v6M12 18v.5',
  lock: 'M6 11h12v10H6zM9 11V8a3 3 0 0 1 6 0v3',
  calc: 'M5 3h14v18H5zM8 7h8M8 12h2M14 12h2M8 17h2M14 17h2',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  users: 'M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM2 21c0-4 3-6 7-6s7 2 7 6M17 5a3 3 0 0 1 0 6M18 15c3 .6 4 2.4 4 6',
  calendar: 'M3 5h18v16H3zM3 10h18M8 3v4M16 3v4',
  cube: 'm12 3 9 5v8l-9 5-9-5V8zM12 3v18M3 8l9 5 9-5',
  gamepad: 'M7 8h10a5 5 0 0 1 5 5v1a4 4 0 0 1-7 3l-3-2-3 2a4 4 0 0 1-7-3v-1a5 5 0 0 1 5-5ZM8 11v2M7 12h2M15 12h.5M17 14h.5',
  phone: 'M7 3h10v18H7zM11 18h2',
  api: 'M4 9V7a3 3 0 0 1 3-3h2M20 15v2a3 3 0 0 1-3 3h-2M8 12h8M12 8v8',
  spark: 'M12 3v6M12 15v6M3 12h6M15 12h6M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3',
};

const TINTS = [
  ['#e7e3f7', '#5b48c9'],
  ['#fde8d7', '#a8562a'],
  ['#ddeef7', '#1d6f96'],
  ['#e3f2e3', '#2f7d3a'],
  ['#f7e3ea', '#a3325a'],
  ['#f3ecd9', '#8a6a1f'],
];

function tintFor(seed) {
  let h = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
  return TINTS[h % TINTS.length];
}

export function GlyphTile({ glyph, seed, size = 34 }) {
  const [bg, fg] = tintFor(seed || glyph);
  const d = GLYPHS[glyph] || GLYPHS.spark;
  return (
    <span className="clogo" style={{ width: size, height: size, background: bg, color: fg }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size * 0.56} height={size * 0.56} fill="none"
           stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d={d} />
      </svg>
    </span>
  );
}

export default function ConnectorLogo({ id, name, url, type, size = 34 }) {
  const role = isRoleCard(id, type);
  const domain = useMemo(() => (role ? '' : domainFor(id, name, url)), [id, name, url, role]);
  const srcs = useMemo(() => {
    const exact = iconOverride(id);
    const list = logoSources(domain);
    return exact ? [exact, ...list] : list;
  }, [id, domain]);
  const [stage, setStage] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const mono = useMemo(() => monogram(name), [name]);

  if (role) return <GlyphTile glyph={glyphFor(id, name)} seed={name || id} size={size} />;

  const src = srcs[stage];

  return (
    <span className="clogo" style={{ width: size, height: size, background: mono.bg, color: mono.fg }} aria-hidden="true">
      <span className="clogo-mono" style={{ fontSize: Math.round(size * 0.42) }}>{mono.text}</span>
      {src && (
        <img
          // key resets the element so a failed URL cannot stick
          key={src}
          // No loading="lazy": a card that is scrolled past keeps its fallback
          // tile forever in some engines, and the directory only mounts one
          // page of cards at a time.
          className={'clogo-img' + (loaded ? ' on' : '')}
          src={src}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          draggable="false"
          onLoad={(e) => {
            // Some sites answer 404 with a 1×1 or a generic icon; ignore those.
            const el = e.currentTarget;
            if (el.naturalWidth && el.naturalWidth < 8) { setStage((s) => s + 1); return; }
            setLoaded(true);
          }}
          onError={() => setStage((s) => s + 1)}
        />
      )}
    </span>
  );
}
