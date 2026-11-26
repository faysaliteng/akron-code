import React, { useState, useMemo, useEffect, useRef } from 'react';
import { shortcutLabels } from './shortcuts';

function flattenTree(nodes, out = []) {
  for (const n of nodes || []) {
    if (!n.isDir) out.push(n);
    if (Array.isArray(n.children)) flattenTree(n.children, out);
  }
  return out;
}

function fuzzyScore(text, query) {
  if (!query) return 1;
  const t = String(text || '').toLowerCase();
  const q = String(query || '').toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 100 - t.indexOf(q);
  let qi = 0;
  let score = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      qi++;
      score += 2;
    }
  }
  return qi === q.length ? score : -1;
}

export function QuickOpenModal({
  mode = 'files', // 'files' | 'symbols' | 'commands'
  initialQuery = '',
  treeNodes = [],
  symbols = [], // [{ name, kind, line, col }]
  commands = [], // [{ id, title, shortcut, run }]
  onSelectFile,
  onSelectSymbol,
  onClose,
}) {
  const [query, setQuery] = useState(
    initialQuery || (mode === 'commands' ? '>' : mode === 'symbols' ? '@' : '')
  );
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const sc = shortcutLabels();

  useEffect(() => {
    inputRef.current && inputRef.current.focus();
  }, [mode]);

  const allFiles = useMemo(() => flattenTree(treeNodes), [treeNodes]);

  const effectiveMode = query.startsWith('>')
    ? 'commands'
    : query.startsWith('@')
      ? 'symbols'
      : mode === 'symbols' && !query
        ? 'symbols'
        : mode === 'commands' && !query
          ? 'commands'
          : 'files';

  const cleanQuery = query.replace(/^[>@]\s*/, '');

  const items = useMemo(() => {
    if (effectiveMode === 'commands') {
      return (commands || [])
        .map((c) => ({ ...c, score: fuzzyScore(c.title, cleanQuery) }))
        .filter((c) => c.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 60);
    }
    if (effectiveMode === 'symbols') {
      return (symbols || [])
        .map((s) => ({ ...s, score: fuzzyScore(s.name, cleanQuery) }))
        .filter((s) => s.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 60);
    }
    return allFiles
      .map((f) => ({ ...f, score: fuzzyScore(f.relPath || f.name, cleanQuery) }))
      .filter((f) => f.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);
  }, [effectiveMode, allFiles, symbols, commands, cleanQuery]);

  useEffect(() => { setSel(0); }, [query, effectiveMode]);

  const pick = (item) => {
    if (!item) return;
    if (effectiveMode === 'commands') {
      onClose && onClose();
      item.run && item.run();
      return;
    }
    if (effectiveMode === 'symbols') onSelectSymbol && onSelectSymbol(item);
    else onSelectFile && onSelectFile(item.path);
    onClose && onClose();
  };

  return (
    <div className="ide-quickopen-backdrop" onMouseDown={onClose}>
      <div className="ide-quickopen" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="ide-quickopen-in"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search files (${sc.quickOpen}), type > for commands, @ for symbols…`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose && onClose(); }
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
            if (e.key === 'Enter' && items[sel]) { e.preventDefault(); pick(items[sel]); }
          }}
        />
        <div className="ide-quickopen-list">
          {items.length === 0 ? (
            <div className="ide-empty-note">
              {effectiveMode === 'commands'
                ? 'No matching commands.'
                : effectiveMode === 'symbols'
                  ? 'No matching symbols in active file.'
                  : 'No matching files.'}
            </div>
          ) : items.map((it, idx) => (
            <button
              key={
                effectiveMode === 'commands'
                  ? `cmd:${it.id || it.title}:${idx}`
                  : effectiveMode === 'symbols'
                    ? `${it.name}:${it.line}:${idx}`
                    : it.path
              }
              type="button"
              className={'ide-quickopen-row' + (idx === sel ? ' on' : '')}
              onMouseEnter={() => setSel(idx)}
              onClick={() => pick(it)}
            >
              <span className="ide-qo-main">{effectiveMode === 'commands' ? `> ${it.title}` : it.name}</span>
              <span className="ide-qo-sub">
                {effectiveMode === 'commands'
                  ? (it.shortcut || 'Command')
                  : effectiveMode === 'symbols'
                    ? `${it.kind || 'symbol'} · L${it.line}`
                    : it.relPath}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
