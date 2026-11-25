'use strict';
// Pure SVG chart generator (no external deps). Produces an SVG string for the
// mcp__visualize__visualize tool. Supports bar / line / pie / scatter / area.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const PALETTE = ['#4f8cff', '#00c2a8', '#ffb020', '#ff5c7a', '#9b6bff', '#2dd4bf', '#f472b6', '#facc15', '#38bdf8', '#a3e635'];

// Normalize flexible inputs into { labels: [], data: [] } (single series).
function normalizeSeries(args) {
  let labels = args.labels || args.categories || null;
  let data = args.data || args.values || [];

  // { a: 1, b: 2 } object form
  if (data && !Array.isArray(data) && typeof data === 'object') {
    const entries = Object.entries(data);
    labels = labels || entries.map((e) => e[0]);
    data = entries.map((e) => e[1]);
  }
  // [{ label, value }] form
  if (Array.isArray(data) && data.length && typeof data[0] === 'object') {
    labels = labels || data.map((d) => d.label ?? d.name ?? d.x ?? '');
    data = data.map((d) => d.value ?? d.y ?? d.count ?? d.size ?? 0);
  }
  if (!Array.isArray(data)) data = [data];
  if (!labels && Array.isArray(data)) labels = data.map((_, i) => String(i + 1));
  if (!Array.isArray(labels)) labels = [];
  const numeric = (data || []).map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
  return { labels: labels.map(String), data: numeric };
}

function svgDoc(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="-apple-system, 'Segoe UI', Roboto, sans-serif">${body}</svg>`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * exp;
}

function niceStep(max, ticks) {
  const raw = max / (ticks || 5);
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * exp;
}

function axes(w, h, m, max) {
  const step = niceStep(max, 5);
  let grid = '';
  for (let v = 0; v <= max + 1e-9; v += step) {
    const y = h - m.b - (v / max) * m.innerH;
    grid += `<line x1="${m.l}" y1="${y.toFixed(1)}" x2="${w - m.r}" y2="${y.toFixed(1)}" stroke="#2a303c" stroke-width="1"/>`;
    grid += `<text x="${(m.l - 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="#8b949e" font-size="11" text-anchor="end">${fmtNum(v)}</text>`;
  }
  grid += `<line x1="${m.l}" y1="${h - m.b}" x2="${w - m.r}" y2="${h - m.b}" stroke="#4a5160" stroke-width="1"/>`;
  grid += `<line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${h - m.b}" stroke="#4a5160" stroke-width="1"/>`;
  return grid;
}

function fmtNum(v) {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v * 100) / 100);
}

function bar(args) {
  const { labels, data } = normalizeSeries(args);
  const w = 720, h = 440, m = { l: 56, r: 20, t: 30, b: 56 };
  m.innerW = w - m.l - m.r;
  m.innerH = h - m.t - m.b;
  const max = niceMax(Math.max(0, ...data));
  const n = data.length;
  const slot = m.innerW / Math.max(1, n);
  const bw = Math.min(48, slot * 0.6);
  const title = args.title ? `<text x="${(m.l + m.innerW / 2).toFixed(1)}" y="20" fill="#e6edf3" font-size="15" font-weight="600" text-anchor="middle">${esc(args.title)}</text>` : '';
  let rects = '';
  data.forEach((v, i) => {
    const x = m.l + slot * i + (slot - bw) / 2;
    const y = h - m.b - (v / max) * m.innerH;
    const color = PALETTE[i % PALETTE.length];
    rects += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - m.b - y).toFixed(1)}" rx="3" fill="${color}"/>`;
    rects += `<text x="${(x + bw / 2).toFixed(1)}" y="${(h - m.b + 18).toFixed(1)}" fill="#8b949e" font-size="11" text-anchor="middle">${esc(truncLabel(labels[i], 12))}</text>`;
  });
  return svgDoc(w, h, title + axes(w, h, m, max) + rects);
}

function line(args) {
  const { labels, data } = normalizeSeries(args);
  const w = 720, h = 440, m = { l: 56, r: 20, t: 30, b: 56 };
  m.innerW = w - m.l - m.r;
  m.innerH = h - m.t - m.b;
  const max = niceMax(Math.max(0, ...data));
  const n = data.length;
  const pts = data.map((v, i) => {
    const x = m.l + (n === 1 ? m.innerW / 2 : (i / (n - 1)) * m.innerW);
    const y = h - m.b - (v / max) * m.innerH;
    return [x, y];
  });
  const poly = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const color = PALETTE[0];
  const title = args.title ? `<text x="${(m.l + m.innerW / 2).toFixed(1)}" y="20" fill="#e6edf3" font-size="15" font-weight="600" text-anchor="middle">${esc(args.title)}</text>` : '';
  let dots = '', lbl = '';
  pts.forEach((p, i) => {
    dots += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${color}"/>`;
    lbl += `<text x="${p[0].toFixed(1)}" y="${(h - m.b + 18).toFixed(1)}" fill="#8b949e" font-size="11" text-anchor="middle">${esc(truncLabel(labels[i], 12))}</text>`;
  });
  const area = args.area || args.fill;
  const areaPath = area && n > 1
    ? `<polygon points="${m.l},${h - m.b} ${poly} ${(m.l + m.innerW).toFixed(1)},${h - m.b}" fill="${color}" opacity="0.15"/>`
    : '';
  return svgDoc(w, h, title + axes(w, h, m, max) + areaPath + `<polyline points="${poly}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>` + dots + lbl);
}

function pie(args) {
  const { labels, data } = normalizeSeries(args);
  const w = 720, h = 440;
  const cx = w / 2 - 40, cy = h / 2, r = Math.min(170, h / 2 - 30);
  const total = data.reduce((a, b) => a + b, 0) || 1;
  let angle = -Math.PI / 2;
  let slices = '';
  let legend = '';
  data.forEach((v, i) => {
    const frac = v / total;
    const a1 = angle, a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const color = PALETTE[i % PALETTE.length];
    if (frac > 0) {
      slices += `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${color}" stroke="#0d1117" stroke-width="1.5"/>`;
    }
    const pct = ((frac * 100)).toFixed(1);
    legend += `<text x="${(cx + r + 24).toFixed(1)}" y="${(cy - (data.length - 1) * 10 + i * 20).toFixed(1)}" fill="#e6edf3" font-size="12">${esc(truncLabel(labels[i], 16))} — ${pct}%</text>`;
    angle = a2;
  });
  const title = args.title ? `<text x="${(w / 2).toFixed(1)}" y="24" fill="#e6edf3" font-size="15" font-weight="600" text-anchor="middle">${esc(args.title)}</text>` : '';
  return svgDoc(w, h, title + slices + legend);
}

function scatter(args) {
  const { labels, data } = normalizeSeries(args);
  const w = 720, h = 440, m = { l: 56, r: 20, t: 30, b: 56 };
  m.innerW = w - m.l - m.r;
  m.innerH = h - m.t - m.b;
  const max = niceMax(Math.max(0, ...data));
  const n = data.length;
  const title = args.title ? `<text x="${(m.l + m.innerW / 2).toFixed(1)}" y="20" fill="#e6edf3" font-size="15" font-weight="600" text-anchor="middle">${esc(args.title)}</text>` : '';
  let dots = '';
  data.forEach((v, i) => {
    const x = m.l + (n === 1 ? m.innerW / 2 : (i / (n - 1)) * m.innerW);
    const y = h - m.b - (v / max) * m.innerH;
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="${PALETTE[i % PALETTE.length]}" opacity="0.85"/>`;
  });
  return svgDoc(w, h, title + axes(w, h, m, max) + dots);
}

function truncLabel(s, max) {
  s = String(s == null ? '' : s);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Main entry: render(args) -> { svg, title }
function render(args) {
  const type = String((args && (args.type || args.chart || args.chartType)) || 'bar').toLowerCase();
  let svg;
  switch (type) {
    case 'line': svg = line(args || {}); break;
    case 'pie': case 'donut': svg = pie(args || {}); break;
    case 'scatter': svg = scatter(args || {}); break;
    case 'area': svg = line({ ...(args || {}), area: true }); break;
    case 'bar': default: svg = bar(args || {}); break;
  }
  return { svg, title: (args && args.title) || `${type} chart`, type };
}

module.exports = { render, normalizeSeries };
