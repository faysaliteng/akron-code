import React, { useState, useMemo, useEffect, useRef } from 'react';

function flattenTree(nodes, out = []) {
  for (const n of nodes || []) {
    if (!n.isDir) out.push(n);
    if (Array.isArray(n.children)) flattenTree(n.children, out);
  }
  return out;
}

function fuzzyScore(text, query) {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
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
  mode = 'files', // 'files' | 'symbols'
  treeNodes = [],
  symbols = [], // [{ name, kind, line, col }]
  onSelectFile,
  onSelectSymbol,
  onClose,
}) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current && inputRef.current.focus();
  }, [mode]);

  const allFiles = useMemo(() => flattenTree(treeNodes), [treeNodes]);

  const items = useMemo(() => {
    if (mode === 'symbols') {
      return (symbols || [])
        .map((s) => ({ ...s, score: fuzzyScore(s.name, query) }))
        .filter((s) => s.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 60);
    }
    return allFiles
      .map((f) => ({ ...f, score: fuzzyScore(f.relPath || f.name, query) }))
      .filter((f) => f.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);
  }, [mode, allFiles, symbols, query]);

  useEffect(() => { setSel(0); }, [query, mode]);

  const pick = (item) => {
    if (!item) return;
    if (mode === 'symbols') onSelectSymbol && onSelectSymbol(item);
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
          placeholder={mode === 'symbols' ? 'Go to Symbol in Editor…' : 'Go to File… (type path or filename)'}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose && onClose(); }
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
            if (e.key === 'Enter' && items[sel]) { e.preventDefault(); pick(items[sel]); }
          }}
        />
        <div className="ide-quickopen-list">
          {items.length === 0 ? (
            <div className="ide-empty-note">{mode === 'symbols' ? 'No matching symbols.' : 'No matching files.'}</div>
          ) : items.map((it, idx) => (
            <button
              key={mode === 'symbols' ? `${it.name}:${it.line}:${idx}` : it.path}
              type="button"
              className={'ide-quickopen-row' + (idx === sel ? ' on' : '')}
              onMouseEnter={() => setSel(idx)}
              onClick={() => pick(it)}
            >
              <span className="ide-qo-main">{it.name}</span>
              <span className="ide-qo-sub">{mode === 'symbols' ? `${it.kind || 'symbol'} · L${it.line}` : it.relPath}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
