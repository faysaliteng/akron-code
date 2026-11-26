import React, { useState, useMemo } from 'react';

export function SearchPanel({ cwd, onOpenMatch, onNotify, onFilesMutated, Icon }) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [includeGlob, setIncludeGlob] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState({ matches: [], engine: '', truncated: false });

  const runSearch = async (e) => {
    if (e) e.preventDefault();
    if (!query.trim() || !cwd) return;
    setLoading(true);
    try {
      const r = await window.autobot.ideSearch({
        cwd,
        query: query.trim(),
        isRegex,
        caseSensitive,
        includeGlob: includeGlob.trim() || undefined,
      });
      if (r && r.ok) setResults(r);
      else onNotify && onNotify('❌ Search error: ' + (r?.error || 'failed'));
    } finally {
      setLoading(false);
    }
  };

  const runReplaceAll = async () => {
    if (!query.trim() || !cwd) return;
    setLoading(true);
    try {
      const r = await window.autobot.ideReplace({
        cwd,
        query: query.trim(),
        replacement,
        isRegex,
        caseSensitive,
        includeGlob: includeGlob.trim() || undefined,
      });
      if (r && r.ok) {
        onNotify && onNotify(`✅ Replaced ${r.replacements} occurrence(s) across ${r.filesChanged} file(s).`);
        onFilesMutated && onFilesMutated();
        await runSearch();
      } else {
        onNotify && onNotify('❌ Replace error: ' + (r?.error || 'failed'));
      }
    } finally {
      setLoading(false);
    }
  };

  const grouped = useMemo(() => {
    const map = new Map();
    for (const m of results.matches || []) {
      const arr = map.get(m.relPath) || [];
      arr.push(m);
      map.set(m.relPath, arr);
    }
    return [...map.entries()];
  }, [results.matches]);

  return (
    <div className="ide-panel">
      <div className="ide-panel-head">
        <span className="ide-panel-title">Search</span>
        <button
          type="button"
          className="ide-icon-btn"
          title="Toggle Replace"
          onClick={() => setShowReplace((v) => !v)}
        >
          <Icon name={showReplace ? 'CaretUp' : 'CaretDown'} size={13} />
        </button>
      </div>
      <form className="ide-search-form" onSubmit={runSearch}>
        <div className="ide-search-box">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search in project (Enter)…"
          />
          <button type="button" className={'ide-flag-btn' + (caseSensitive ? ' on' : '')} title="Match Case" onClick={() => setCaseSensitive((v) => !v)}>Aa</button>
          <button type="button" className={'ide-flag-btn' + (isRegex ? ' on' : '')} title="Use Regular Expression" onClick={() => setIsRegex((v) => !v)}>.*</button>
        </div>
        {showReplace && (
          <div className="ide-search-box">
            <input
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder="Replace with…"
            />
            <button type="button" className="ide-mini-action" onClick={runReplaceAll} disabled={loading || !query.trim()}>All</button>
          </div>
        )}
        <input
          className="ide-glob-in"
          value={includeGlob}
          onChange={(e) => setIncludeGlob(e.target.value)}
          placeholder="files to include (e.g. *.jsx)"
        />
      </form>

      <div className="ide-search-meta">
        {loading ? 'Searching…' : `${(results.matches || []).length} results in ${grouped.length} files${results.engine ? ` · ${results.engine}` : ''}`}
      </div>

      <div className="ide-tree-scroll">
        {grouped.map(([rel, list]) => (
          <div key={rel} className="ide-search-group">
            <div className="ide-search-file">
              <span>{rel}</span>
              <span className="ide-search-cnt">{list.length}</span>
            </div>
            {list.map((m, idx) => (
              <button
                key={`${rel}:${m.line}:${m.column}:${idx}`}
                type="button"
                className="ide-search-hit"
                onClick={() => onOpenMatch && onOpenMatch(m.file, m.line, m.column)}
              >
                <span className="ide-hit-ln">{m.line}</span>
                <span className="ide-hit-txt">{m.text.trim()}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
