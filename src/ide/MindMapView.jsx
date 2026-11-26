import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';

const transformer = new Transformer();

const DARK_PALETTE = ['#10b981', '#34d399', '#38bdf8', '#a78bfa', '#f59e0b', '#f472b6'];
const LIGHT_PALETTE = ['#059669', '#0d9488', '#0284c7', '#7c3aed', '#d97706', '#db2777'];

function extractFileCandidate(label) {
  const plain = String(label || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/`/g, '')
    .trim();
  const m = plain.match(/([A-Za-z0-9_.\-/\\]+\.(?:js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|kt|swift|rb|php|css|scss|html|md|json|yaml|yml|toml|sql|sh))(?::(\d+))?/i);
  if (!m) return null;
  return { rel: m[1].replace(/\\/g, '/'), line: m[2] ? Number(m[2]) : null };
}

function resolveUnderCwd(cwd, relPath) {
  if (!relPath) return null;
  if (relPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relPath)) return relPath;
  if (!cwd) return relPath;
  const sep = String(cwd).includes('\\') ? '\\' : '/';
  const base = String(cwd).replace(/[\\/]+$/, '');
  return base + sep + relPath.replace(/\//g, sep);
}

function setFoldRecursive(node, foldDepth, depth = 0) {
  if (!node || typeof node !== 'object') return;
  if (!node.payload) node.payload = {};
  node.payload.fold = foldDepth != null && depth >= foldDepth ? 1 : 0;
  if (Array.isArray(node.children)) {
    for (const c of node.children) setFoldRecursive(c, foldDepth, depth + 1);
  }
}

export function MindMapView({
  markdown: propMarkdown = '',
  cwd = '',
  theme = 'dark',
  onOpenFile = null,
  onClose = null,
  compact = false,
}) {
  const svgRef = useRef(null);
  const mmRef = useRef(null);
  const rootDataRef = useRef(null);

  const [sourceMode, setSourceMode] = useState('auto'); // 'auto' | 'tree'
  const [markdown, setMarkdown] = useState(propMarkdown || '');
  const [meta, setMeta] = useState({ exists: false, path: '' });
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadFromWorkspace = useCallback(async (mode = sourceMode) => {
    if (propMarkdown) {
      setMarkdown(propMarkdown);
      return;
    }
    if (!cwd || !window.autobot?.getMindmap) {
      setMarkdown('# Workspace\n## Waiting for workspace\n- Select or open a workspace folder to visualize it.');
      return;
    }
    setLoading(true);
    try {
      const r = await window.autobot.getMindmap(cwd, mode);
      if (r && r.markdown) {
        setMarkdown(r.markdown);
        setMeta({ exists: !!r.exists, path: r.path || '' });
      }
    } finally {
      setLoading(false);
    }
  }, [cwd, propMarkdown, sourceMode]);

  useEffect(() => {
    loadFromWorkspace(sourceMode);
  }, [loadFromWorkspace, sourceMode]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const isLight = theme === 'light';
    const palette = isLight ? LIGHT_PALETTE : DARK_PALETTE;
    const { root } = transformer.transform(markdown || '# Mind Map\n- Empty');
    rootDataRef.current = root;

    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const mm = Markmap.create(
      svg,
      {
        autoFit: true,
        duration: 280,
        paddingX: 16,
        spacingVertical: 6,
        spacingHorizontal: 72,
        color: (node) => palette[(node.state?.depth || 0) % palette.length],
      },
      root
    );
    mmRef.current = mm;

    const handleClick = (ev) => {
      if (!onOpenFile) return;
      const g = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('g.markmap-node') : null;
      if (!g) return;
      const fo = g.querySelector('foreignObject');
      const txt = fo ? fo.textContent : g.textContent;
      const hit = extractFileCandidate(txt);
      if (hit) {
        const abs = resolveUnderCwd(cwd, hit.rel);
        onOpenFile(abs, hit.line);
      }
    };
    svg.addEventListener('click', handleClick);

    const fitTimer = setTimeout(() => {
      try { mm.fit(); } catch (_) {}
    }, 60);

    return () => {
      clearTimeout(fitTimer);
      svg.removeEventListener('click', handleClick);
      try { mm.destroy(); } catch (_) {}
      mmRef.current = null;
    };
  }, [markdown, theme, cwd, onOpenFile]);

  const zoomBy = (factor) => {
    try { mmRef.current?.rescale(factor); } catch (_) {}
  };
  const fitView = () => {
    try { mmRef.current?.fit(); } catch (_) {}
  };
  const toggleExpand = () => {
    const mm = mmRef.current;
    const root = rootDataRef.current;
    if (!mm || !root) return;
    const next = !collapsed;
    setFoldRecursive(root, next ? 2 : null);
    setCollapsed(next);
    try {
      mm.setData(root);
      mm.fit();
    } catch (_) {}
  };
  const exportSvg = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'akron-mindmap.svg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const isLight = theme === 'light';
  const wrapStyle = {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: compact ? 360 : '100%',
    minHeight: compact ? 280 : 320,
    background: isLight ? '#f8fafc' : '#0b0f14',
    color: isLight ? '#0f172a' : '#e5e7eb',
    borderRadius: compact ? 10 : 0,
    border: compact ? `1px solid ${isLight ? '#e2e8f0' : 'rgba(255,255,255,0.09)'}` : 'none',
    overflow: 'hidden',
  };

  return (
    <div className={`akron-mindmap-view ${isLight ? 'theme-light' : 'theme-dark'}`} data-testid="akron-mindmap-view" style={wrapStyle}>
      <div
        className="akron-mindmap-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '8px 12px',
          borderBottom: `1px solid ${isLight ? '#e2e8f0' : 'rgba(255,255,255,0.08)'}`,
          background: isLight ? '#ffffff' : '#11161d',
          fontSize: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ color: isLight ? '#059669' : '#34d399', fontWeight: 600 }}>Mind Map</strong>
          {!propMarkdown && (
            <select
              value={sourceMode}
              onChange={(e) => setSourceMode(e.target.value)}
              style={{
                background: isLight ? '#f1f5f9' : '#19202a',
                color: isLight ? '#0f172a' : '#e5e7eb',
                border: `1px solid ${isLight ? '#cbd5e1' : 'rgba(255,255,255,0.12)'}`,
                borderRadius: 6,
                padding: '3px 8px',
                fontSize: 11,
              }}
            >
              <option value="auto">{meta.exists ? 'MINDMAP.md + Files' : 'Workspace Overview'}</option>
              <option value="tree">File Tree</option>
            </select>
          )}
          {loading && <span style={{ opacity: 0.65 }}>Refreshing…</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button type="button" className="btn-mini" title="Zoom In" onClick={() => zoomBy(1.25)}>+</button>
          <button type="button" className="btn-mini" title="Zoom Out" onClick={() => zoomBy(0.8)}>−</button>
          <button type="button" className="btn-mini" title="Fit to Screen" onClick={fitView}>Fit</button>
          <button type="button" className="btn-mini" title={collapsed ? 'Expand All' : 'Collapse Branches'} onClick={toggleExpand}>
            {collapsed ? 'Expand' : 'Collapse'}
          </button>
          {!propMarkdown && (
            <button type="button" className="btn-mini" title="Refresh" onClick={() => loadFromWorkspace(sourceMode)}>↻</button>
          )}
          <button type="button" className="btn-mini" title="Export SVG" onClick={exportSvg}>SVG</button>
          {onClose && (
            <button type="button" className="btn-mini" title="Close Mind Map" onClick={onClose}>✕</button>
          )}
        </div>
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <svg
          ref={svgRef}
          className="akron-mindmap-svg"
          style={{
            width: '100%',
            height: '100%',
            display: 'block',
            color: isLight ? '#0f172a' : '#e5e7eb',
            ['--markmap-text-color']: isLight ? '#0f172a' : '#e5e7eb',
          }}
        />
        <style>{`
          .akron-mindmap-svg text,
          .akron-mindmap-svg .markmap-foreign {
            color: ${isLight ? '#0f172a' : '#e5e7eb'} !important;
            fill: ${isLight ? '#0f172a' : '#e5e7eb'} !important;
            font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
            font-size: 13px;
          }
          .akron-mindmap-svg .markmap-foreign code {
            background: ${isLight ? '#e2e8f0' : 'rgba(16,185,129,0.14)'};
            color: ${isLight ? '#047857' : '#6ee7b7'};
            padding: 1px 5px;
            border-radius: 4px;
            font-size: 12px;
            cursor: ${onOpenFile ? 'pointer' : 'default'};
          }
        `}</style>
      </div>
    </div>
  );
}

export default MindMapView;
