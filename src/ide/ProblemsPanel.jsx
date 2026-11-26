import React from 'react';

export function ProblemsPanel({ problems = [], onSelectProblem, onFixProblem, onFixAll, Icon }) {
  const errCount = problems.filter((p) => p.severity === 'error').length;
  const warnCount = problems.filter((p) => p.severity === 'warning').length;

  return (
    <div className="ide-problems">
      <div className="ide-problems-bar">
        <span>{errCount} Errors · {warnCount} Warnings</span>
        {problems.length > 0 && (
          <button type="button" className="ide-mini-action accent" onClick={() => onFixAll && onFixAll(problems)}>
            <Icon name="Sparkles" size={12} /> Fix all with Agent
          </button>
        )}
      </div>
      <div className="ide-problems-list">
        {problems.length === 0 ? (
          <div className="ide-empty-note">No problems detected in active workspace.</div>
        ) : problems.map((p, idx) => (
          <div key={`${p.file}:${p.line}:${p.col}:${idx}`} className="ide-problem-row" onClick={() => onSelectProblem && onSelectProblem(p)}>
            <span className={'ide-prob-sev ' + p.severity}>{p.severity === 'error' ? '✕' : '▲'}</span>
            <span className="ide-prob-msg">{p.message}</span>
            <span className="ide-prob-loc">{p.relPath || p.file.split('/').pop()}:{p.line}:{p.col}</span>
            <button
              type="button"
              className="ide-mini-action"
              onClick={(e) => { e.stopPropagation(); onFixProblem && onFixProblem(p); }}
            >
              Fix
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
