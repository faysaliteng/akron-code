import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import { shortcutLabels } from './shortcuts';
import { normalizeTypography, resolveMonoFontStack } from '../typography.js';

function XtermInstance({
  ptyId,
  theme,
  typography = null,
  initialBuffer = '',
  onSelectionChange,
  registerReader,
  registerSearch,
  onSerialize,
  onOpenSearch,
}) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const searchRef = useRef(null);
  const serializeRef = useRef(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !ptyId) return;
    const isLight = theme === 'light';
    const typo = normalizeTypography(typography);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: Math.max(10.5, (typo.monoSize || 13) - 0.5),
      lineHeight: 1.35,
      fontFamily: resolveMonoFontStack(typo),
      theme: isLight
        ? { background: '#fafafa', foreground: '#18181b', cursor: '#059669', selectionBackground: '#05966933' }
        : { background: '#0e0e11', foreground: '#e4e4ea', cursor: '#10b981', selectionBackground: '#10b98133' },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    const serializeAddon = new SerializeAddon();
    const webLinks = new WebLinksAddon((_event, uri) => {
      if (uri && window.autobot?.openExternal) {
        window.autobot.openExternal(uri);
      } else if (uri) {
        window.open(uri, '_blank', 'noopener');
      }
    });

    term.loadAddon(fit);
    term.loadAddon(searchAddon);
    term.loadAddon(serializeAddon);
    term.loadAddon(webLinks);
    term.open(el);

    if (initialBuffer) {
      try { term.write(initialBuffer + '\r\n\x1b[90m--- restored session ---\x1b[0m\r\n'); } catch (_) {}
    }

    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = searchAddon;
    serializeRef.current = serializeAddon;

    term.attachCustomKeyEventHandler((e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        if (e.type === 'keydown') onOpenSearch && onOpenSearch();
        return false;
      }
      return true;
    });

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

    // <=16ms batched PTY stream writer so heavy builds keep UI responsive
    let pendingBuf = '';
    let flushTimer = null;
    let serTimer = null;
    const scheduleSerialize = () => {
      if (!onSerialize) return;
      if (serTimer) clearTimeout(serTimer);
      serTimer = setTimeout(() => {
        serTimer = null;
        try { onSerialize(serializeAddon.serialize({ scrollback: 250 })); } catch (_) {}
      }, 900);
    };
    const flushWrites = () => {
      flushTimer = null;
      if (!pendingBuf) return;
      const chunk = pendingBuf;
      pendingBuf = '';
      try { term.write(chunk); } catch (_) {}
      scheduleSerialize();
    };

    const offPtyData = window.autobot && window.autobot.onIdePtyData
      ? window.autobot.onIdePtyData((evt) => {
          if (evt && evt.id === ptyId && evt.data) {
            pendingBuf += evt.data;
            if (!flushTimer) flushTimer = setTimeout(flushWrites, 14);
          }
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
    if (registerSearch) {
      registerSearch(ptyId, searchAddon);
    }

    return () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (serTimer) { clearTimeout(serTimer); serTimer = null; }
      try { if (onSerialize && serializeRef.current) onSerialize(serializeRef.current.serialize({ scrollback: 250 })); } catch (_) {}
      try { ro.disconnect(); } catch (_) {}
      try { offPtyData(); } catch (_) {}
      try { onDataDisp.dispose(); } catch (_) {}
      try { onSelDisp.dispose(); } catch (_) {}
      try { term.dispose(); } catch (_) {}
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      serializeRef.current = null;
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

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const typo = normalizeTypography(typography);
    term.options.fontFamily = resolveMonoFontStack(typo);
    term.options.fontSize = Math.max(10.5, (typo.monoSize || 13) - 0.5);
    try { if (fitRef.current) fitRef.current.fit(); } catch (_) {}
  }, [typography]);

  return <div ref={hostRef} className="ide-xterm-host" />;
}

export function TerminalPanel({ cwd, theme, typography = null, initialBuffer = '', onSerializeChange, onSendToAgent, Icon }) {
  const [tabs, setTabs] = useState([]); // [{ id, shell, title }]
  const [activeId, setActiveId] = useState(null);
  const [splitId, setSplitId] = useState(null);
  const [selection, setSelection] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const readersRef = useRef({});
  const searchersRef = useRef({});
  const initStartedRef = useRef(false);
  const searchInRef = useRef(null);
  const sc = shortcutLabels();

  const registerReader = useCallback((id, fn) => {
    readersRef.current[id] = fn;
  }, []);

  const registerSearch = useCallback((id, addon) => {
    searchersRef.current[id] = addon;
  }, []);

  const createTab = useCallback(async (asSplit = false) => {
    if (!window.autobot || !window.autobot.idePtyCreate) return null;
    const res = await window.autobot.idePtyCreate({ cwd });
    if (res && res.ok && res.id) {
      setTabs((prev) => [...prev, { id: res.id, shell: res.shell || 'shell', title: `${res.shell || 'shell'} #${prev.length + 1}` }]);
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

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setTimeout(() => searchInRef.current && searchInRef.current.focus(), 20);
  }, []);

  const findInTerm = (dir) => {
    const addon = searchersRef.current[activeId];
    if (!addon || !searchQuery) return;
    if (dir === 'prev') addon.findPrevious(searchQuery);
    else addon.findNext(searchQuery);
  };

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

        {searchOpen && (
          <div className="ide-term-find">
            <input
              ref={searchInRef}
              value={searchQuery}
              onChange={(e) => {
                const q = e.target.value;
                setSearchQuery(q);
                const addon = searchersRef.current[activeId];
                if (addon && q) addon.findNext(q);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); setSearchOpen(false); }
                if (e.key === 'Enter') { e.preventDefault(); findInTerm(e.shiftKey ? 'prev' : 'next'); }
              }}
              placeholder="Find in terminal…"
            />
            <button type="button" className="ide-icon-btn" title="Previous Match" onClick={() => findInTerm('prev')}>↑</button>
            <button type="button" className="ide-icon-btn" title="Next Match" onClick={() => findInTerm('next')}>↓</button>
            <button type="button" className="ide-icon-btn" title="Close Find" onClick={() => setSearchOpen(false)}>×</button>
          </div>
        )}

        <div className="ide-term-actions">
          <button
            type="button"
            className={'ide-icon-btn' + (searchOpen ? ' active' : '')}
            title={`Find in Terminal (${sc.find})`}
            onClick={() => (searchOpen ? setSearchOpen(false) : openSearch())}
          >
            <Icon name="Search" size={12} />
          </button>
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
          <XtermInstance
            key={activeId}
            ptyId={activeId}
            theme={theme}
            typography={typography}
            initialBuffer={tabs[0]?.id === activeId ? initialBuffer : ''}
            onSelectionChange={setSelection}
            registerReader={registerReader}
            registerSearch={registerSearch}
            onSerialize={onSerializeChange}
            onOpenSearch={openSearch}
          />
        ) : (
          <div className="ide-empty-note">Click + to launch a terminal.</div>
        )}
        {splitId && splitId !== activeId && (
          <XtermInstance
            key={splitId}
            ptyId={splitId}
            theme={theme}
            typography={typography}
            onSelectionChange={setSelection}
            registerReader={registerReader}
            registerSearch={registerSearch}
            onOpenSearch={openSearch}
          />
        )}
      </div>
    </div>
  );
}
