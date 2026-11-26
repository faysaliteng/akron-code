import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

function XtermInstance({ ptyId, theme, onSelectionChange, registerReader }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !ptyId) return;
    const isLight = theme === 'light';
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      lineHeight: 1.35,
      fontFamily: "'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
      theme: isLight
        ? { background: '#fafafa', foreground: '#18181b', cursor: '#059669', selectionBackground: '#05966933' }
        : { background: '#0e0e11', foreground: '#e4e4ea', cursor: '#10b981', selectionBackground: '#10b98133' },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;

    const doFit = () => {
      try {
        fit.fit();
        if (term.cols && term.rows && window.autobot && window.autobot.idePtyResize) {
          window.autobot.idePtyResize({ id: ptyId, cols: term.cols, rows: term.rows });
        }
      } catch (_) {}
    };
    requestAnimationFrame(doFit);

    const onDataDisp = term.onData((data) => {
      window.autobot && window.autobot.idePtyWrite && window.autobot.idePtyWrite({ id: ptyId, data });
    });
    const onSelDisp = term.onSelectionChange(() => {
      onSelectionChange && onSelectionChange(term.getSelection() || '');
    });

    const offPtyData = window.autobot && window.autobot.onIdePtyData
      ? window.autobot.onIdePtyData((evt) => {
          if (evt && evt.id === ptyId && evt.data) term.write(evt.data);
        })
      : () => {};

    const ro = new ResizeObserver(() => doFit());
    ro.observe(el);

    if (registerReader) {
      registerReader(ptyId, () => {
        const sel = term.getSelection();
        if (sel && sel.trim()) return sel.trim();
        const buf = term.buffer && term.buffer.active;
        if (!buf) return '';
        const lines = [];
        const start = Math.max(0, buf.length - 40);
        for (let i = start; i < buf.length; i++) {
          const ln = buf.getLine(i);
          if (ln) lines.push(ln.translateToString(true));
        }
        return lines.join('\n').trim();
      });
    }

    return () => {
      try { ro.disconnect(); } catch (_) {}
      try { offPtyData(); } catch (_) {}
      try { onDataDisp.dispose(); } catch (_) {}
      try { onSelDisp.dispose(); } catch (_) {}
      try { term.dispose(); } catch (_) {}
      termRef.current = null;
      fitRef.current = null;
    };
  }, [ptyId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const isLight = theme === 'light';
    term.options.theme = isLight
      ? { background: '#fafafa', foreground: '#18181b', cursor: '#059669', selectionBackground: '#05966933' }
      : { background: '#0e0e11', foreground: '#e4e4ea', cursor: '#10b981', selectionBackground: '#10b98133' };
  }, [theme]);

  return <div ref={hostRef} className="ide-xterm-host" />;
}

export function TerminalPanel({ cwd, theme, onSendToAgent, Icon }) {
  const [tabs, setTabs] = useState([]); // [{ id, shell, title }]
  const [activeId, setActiveId] = useState(null);
  const [splitId, setSplitId] = useState(null);
  const [selection, setSelection] = useState('');
  const readersRef = useRef({});
  const initStartedRef = useRef(false);

  const registerReader = useCallback((id, fn) => {
    readersRef.current[id] = fn;
  }, []);

  const createTab = useCallback(async (asSplit = false) => {
    if (!window.autobot || !window.autobot.idePtyCreate) return null;
    const res = await window.autobot.idePtyCreate({ cwd });
    if (res && res.ok && res.id) {
      setTabs((prev) => [...prev, { id: res.id, shell: res.shell || 'shell', title: `${res.shell || 'zsh'} #${prev.length + 1}` }]);
      if (asSplit) setSplitId(res.id);
      else setActiveId(res.id);
      return res.id;
    }
    return null;
  }, [cwd]);

  const killTab = useCallback(async (id, e) => {
    if (e) e.stopPropagation();
    try { await window.autobot.idePtyKill({ id }); } catch (_) {}
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) setActiveId(next[0] ? next[0].id : null);
      if (splitId === id) setSplitId(null);
      return next;
    });
  }, [activeId, splitId]);

  useEffect(() => {
    if (initStartedRef.current || tabs.length > 0) return;
    initStartedRef.current = true;
    createTab(false);
  }, [createTab, tabs.length]);

  useEffect(() => {
    if (!window.autobot || !window.autobot.onIdePtyExit) return undefined;
    return window.autobot.onIdePtyExit((evt) => {
      if (!evt || !evt.id) return;
      setTabs((prev) => prev.filter((t) => t.id !== evt.id));
    });
  }, []);

  const sendSnippetToAgent = () => {
    const reader = readersRef.current[activeId];
    const txt = (selection && selection.trim()) || (reader ? reader() : '');
    if (txt && onSendToAgent) onSendToAgent(txt);
  };

  return (
    <div className="ide-term-root">
      <div className="ide-term-toolbar">
        <div className="ide-term-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={'ide-term-tab' + (t.id === activeId ? ' on' : '')}
              onClick={() => setActiveId(t.id)}
            >
              <span>{t.title}</span>
              <span className="ide-term-x" onClick={(e) => killTab(t.id, e)}>×</span>
            </button>
          ))}
          <button type="button" className="ide-icon-btn" title="New Terminal" onClick={() => createTab(false)}>
            <Icon name="Add" size={12} />
          </button>
        </div>
        <div className="ide-term-actions">
          <button
            type="button"
            className="ide-mini-action"
            title="Send terminal selection or recent output to Akron Code Agent"
            onClick={sendSnippetToAgent}
          >
            <Icon name="Sparkles" size={11} /> Send to Agent
          </button>
          <button
            type="button"
            className={'ide-icon-btn' + (splitId ? ' active' : '')}
            title={splitId ? 'Close split terminal' : 'Split Terminal'}
            onClick={() => (splitId ? setSplitId(null) : createTab(true))}
          >
            <Icon name="ArrowSplitRight" size={13} />
          </button>
        </div>
      </div>

      <div className={'ide-term-panes' + (splitId ? ' split' : '')}>
        {activeId ? (
          <XtermInstance key={activeId} ptyId={activeId} theme={theme} onSelectionChange={setSelection} registerReader={registerReader} />
        ) : (
          <div className="ide-empty-note">Click + to launch a terminal.</div>
        )}
        {splitId && splitId !== activeId && (
          <XtermInstance key={splitId} ptyId={splitId} theme={theme} onSelectionChange={setSelection} registerReader={registerReader} />
        )}
      </div>
    </div>
  );
}
