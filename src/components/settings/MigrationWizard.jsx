import React, { useState, useEffect, useCallback } from 'react';
import { Icon } from '../Icon.jsx';

export function MigrationWizard({ cwd, setNotice }) {
  const [scan, setScan] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const runScan = useCallback(async () => {
    setBusy(true);
    try {
      if (window.autobot && window.autobot.migrationScan) {
        const res = await window.autobot.migrationScan({ cwd });
        setScan(res);
        setSelected(new Set((res && res.items ? res.items : []).map((i) => i.id)));
      }
    } finally {
      setBusy(false);
    }
  }, [cwd]);

  useEffect(() => { runScan(); }, [runScan]);

  const applyImport = async () => {
    if (!scan || !scan.items || !scan.items.length) return;
    setBusy(true);
    try {
      if (window.autobot && window.autobot.migrationApply) {
        const res = await window.autobot.migrationApply({
          cwd,
          items: scan.items,
          selectedIds: [...selected],
        });
        setResult(res);
        if (setNotice && res && res.ok) {
          setNotice(`Imported ${res.importedCount} configuration item(s) without modifying source files`);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card" data-testid="migration-wizard">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: 0 }}><Icon name="Download" size={14} /> 1-Click Migration Importer (Cursor · Claude Code · VS Code)</h3>
        <button type="button" className="btn-mini" disabled={busy} onClick={runScan}>
          <Icon name="Refresh" size={12} /> Rescan
        </button>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Strictly read-only scan of Cursor, Claude Code, and VS Code configs — source files are never modified.
      </p>

      {scan && Array.isArray(scan.items) && scan.items.length > 0 ? (
        <div className="ct-list" style={{ marginTop: 8 }}>
          {scan.items.map((it) => {
            const on = selected.has(it.id);
            return (
              <label key={it.id} className="ct-row" style={{ cursor: 'pointer', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(it.id);
                      else next.delete(it.id);
                      setSelected(next);
                    }}
                  />
                  <div>
                    <div>
                      <strong>{it.label}</strong> <span className="token-badge-scope project">{it.source}</span>
                    </div>
                    <div className="muted" style={{ margin: '2px 0 0', fontSize: 11 }}>{it.path}</div>
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      ) : (
        <div className="muted" style={{ marginTop: 8 }}>No Cursor, Claude Code, or VS Code config files detected in this environment.</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <button
          type="button"
          className="btn-mini primary"
          disabled={busy || selected.size === 0}
          onClick={applyImport}
          data-testid="migration-import-btn"
        >
          <Icon name="Check" size={12} /> Import Selected ({selected.size})
        </button>
        {result && result.ok && (
          <span className="muted" style={{ margin: 0, color: '#34d399' }}>
            Imported {result.importedCount} item(s) to ~/.autobot
          </span>
        )}
      </div>
    </div>
  );
}
