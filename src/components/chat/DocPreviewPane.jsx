import React, { useState, useEffect, useCallback } from 'react';
import { Icon } from '../Icon.jsx';
import { renderMarkdown, copyTextToClipboard, cleanErr } from '../../utils/appHelpers.jsx';
import { isMarkdownPath, isHtmlPath, resolveAgainstCwd } from '../../utils/linkAndFileHelpers.js';

export function DocPreviewPane({ target, cwd = '', onOpenInIde, onOpenBrowser, onNotice }) {
  const rawPath = (target && target.path) ? String(target.path) : '';
  const resolvedPath = resolveAgainstCwd(rawPath, cwd);
  const baseName = resolvedPath.split(/[\\/]/).pop() || rawPath || 'Document';
  const isMd = isMarkdownPath(resolvedPath);

  const [mode, setMode] = useState(isMd ? 'rendered' : 'raw');
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const loadFile = useCallback(async () => {
    if (!resolvedPath || !window.autobot || !window.autobot.ideReadFile) {
      setError('No file selected.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const r = await window.autobot.ideReadFile({ path: resolvedPath });
      if (!r || !r.ok) {
        setError(cleanErr((r && r.error) || `Could not open ${rawPath || resolvedPath}`));
        setContent('');
      } else if (r.binary) {
        setError('Binary file cannot be previewed as text.');
        setContent('');
      } else {
        setContent(String(r.content || ''));
      }
    } catch (e) {
      setError(cleanErr(e && e.message ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, [resolvedPath, rawPath]);

  useEffect(() => {
    setMode(isMarkdownPath(resolvedPath) ? 'rendered' : 'raw');
    loadFile();
  }, [resolvedPath, target?.at, loadFile]);

  const handleCopy = async () => {
    if (!content) return;
    const ok = await copyTextToClipboard(content).catch(() => false);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
      if (onNotice) onNotice(`Copied ${baseName} to clipboard.`);
    }
  };

  return (
    <div className="doc-preview-pane" data-testid="doc-preview-pane">
      <div className="doc-preview-head">
        <div className="doc-preview-meta" title={resolvedPath}>
          <Icon name="File" size={14} />
          <span className="doc-preview-name">{baseName}</span>
          <span className="doc-preview-path">{resolvedPath}</span>
        </div>
        <div className="doc-preview-actions">
          {isMd && (
            <div className="doc-preview-seg" role="group" aria-label="View mode">
              <button
                type="button"
                className={'btn-mini' + (mode === 'rendered' ? ' active' : '')}
                onClick={() => setMode('rendered')}
              >
                Rendered
              </button>
              <button
                type="button"
                className={'btn-mini' + (mode === 'raw' ? ' active' : '')}
                onClick={() => setMode('raw')}
              >
                Raw
              </button>
            </div>
          )}
          {isHtmlPath(resolvedPath) && onOpenBrowser && (
            <button type="button" className="btn-mini" onClick={() => onOpenBrowser(resolvedPath)} title="Open HTML in built-in Browser">
              <Icon name="Globe" size={12} /> Browser
            </button>
          )}
          {onOpenInIde && (
            <button type="button" className="btn-mini" onClick={() => onOpenInIde(resolvedPath, target?.line || null)} title="Open in Monaco IDE Editor">
              <Icon name="Code" size={12} /> IDE
            </button>
          )}
          <button type="button" className="btn-mini" onClick={handleCopy} disabled={!content} title="Copy file contents">
            <Icon name={copied ? 'Check' : 'Copy'} size={12} /> {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="icon-btn" onClick={loadFile} title="Reload from disk">
            <Icon name="Refresh" size={13} />
          </button>
        </div>
      </div>

      <div className="doc-preview-body">
        {loading && (
          <div className="env-empty"><Icon name="Spinner" size={14} className="spin" /> Opening {baseName}…</div>
        )}
        {!loading && error && (
          <div className="doc-preview-error">
            <Icon name="Warning" size={15} />
            <div>
              <div className="doc-preview-error-title">Could not preview {baseName}</div>
              <div className="doc-preview-error-msg">{error}</div>
            </div>
          </div>
        )}
        {!loading && !error && (mode === 'rendered' && isMd ? (
          <div className="md doc-preview-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
        ) : (
          <pre className="doc-preview-raw"><code>{content || '(empty file)'}</code></pre>
        ))}
      </div>
    </div>
  );
}
