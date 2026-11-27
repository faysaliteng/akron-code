import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Icon } from '../Icon.jsx';
import { uid, useDismiss } from '../../utils/appHelpers.jsx';

export function normalizeUrl(url, cwd) {
  url = String(url || '').trim();
  if (!url) return null;
  // A local path (`/…`, `~/…`, `file://…`) is resolved in the main process so a
  // FOLDER becomes its index.html — a webview on a folder renders nothing.
  if (/^(file:|~\/|\/)/i.test(url) && window.autobot?.resolveUrl) return window.autobot.resolveUrl(url, cwd);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

export function BrowserViewBody({ cwd, previewUrl, onClose, onAttachInspect }) {
  // `launch` is the URL handed to <webview src> at mount and never changes afterwards.
  // `url` tracks the live location. Keeping src stable stops React from re-issuing a
  // navigation on every did-navigate (which aborted and duplicated in-flight loads).
  const [tabs, setTabs] = useState([{ id: 'tab1', launch: 'https://www.google.com', url: 'https://www.google.com', title: 'New Tab', loading: false }]);
  const [activeId, setActiveId] = useState('tab1');
  const [omnibox, setOmnibox] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [findRes, setFindRes] = useState(null); // {active, total}
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const menuBtnRef = useRef(null);
  useDismiss(menuOpen, [menuRef, menuBtnRef], () => setMenuOpen(false));
  const [expanded, setExpanded] = useState(false);   // ⌘↑ / ⌘↓
  const [responsive, setResponsive] = useState(false);
  const [cookiesShared, setCookiesShared] = useState(true);
  const [dev, setDev] = useState(null);             // {hasScript, script, running, port, framework}
  const [devBusy, setDevBusy] = useState(false);
  const [menuNote, setMenuNote] = useState('');
  const [inspectMode, setInspectMode] = useState(false);
  const [inspectedEl, setInspectedEl] = useState(null);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [shotBusy, setShotBusy] = useState(false);
  const [lastShot, setLastShot] = useState(null);
  const [cropMode, setCropMode] = useState(false);
  const [cropDrag, setCropDrag] = useState(null);
  const stageRef = useRef(null);
  const inspectModeRef = useRef(false);
  inspectModeRef.current = inspectMode;
  const webviews = useRef({});
  const omniboxRef = useRef(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // Cookies either ride the app's own partition (`persist:autobot`, shared with any
  // sign-in the user already did) or an isolated one. Switching remounts the
  // webviews, which is the only honest way to change a partition at runtime.
  const partition = cookiesShared ? 'persist:autobot' : 'persist:autobot-isolated';

  // Which dev server, if any, this project can start. Nothing is invented: the card
  // only renders when package.json has a dev-ish script (or a port is already live).
  useEffect(() => {
    if (!cwd || !window.autobot || !window.autobot.devServerDetect) return undefined;
    let cancelled = false;
    window.autobot.devServerDetect(cwd)
      .then((r) => { if (!cancelled && r && r.ok) setDev(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cwd]);

  // ⌘↑ expands the pane to the whole window, ⌘↓ (or Esc) puts it back.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'ArrowUp') { e.preventDefault(); setExpanded(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setExpanded(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!expanded) return undefined;
    const onEsc = (e) => {
      if (e.key === 'Escape' && document.activeElement !== omniboxRef.current) {
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [expanded]);

  const active = tabs.find((t) => t.id === activeId);
  const patchTab = (id, patch) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const nextTabNum = useRef(2);

  const openTab = useCallback((url) => {
    const id = 'tab' + nextTabNum.current++;
    const launch = url || 'https://www.google.com';
    setTabs((ts) => [...ts, { id, launch, url: launch, title: 'New Tab', loading: true }]);
    setActiveId(id);
    setOmnibox(launch);
  }, []);

  const closeTab = (id) => {
    // Drop the dead <webview> handle: bindWebview skips ids it already knows,
    // and tools/menus must never drive a destroyed guest.
    const wv = webviews.current[id];
    if (wv) {
      try { const wid = wv.getWebContentsId(); if (wid) window.autobot.browserUnregister(wid); } catch {}
      delete webviews.current[id];
    }
    if (previewTabRef.current === id) previewTabRef.current = null;
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const remaining = tabs.filter((t) => t.id !== id);
    if (!remaining.length) {
      // Closing the last tab opens a fresh one AND selects it — the id used to
      // be minted inside the updater while activeId fell back to 'tab1', which
      // no longer existed, so the pane went blank.
      const nid = 'tab' + nextTabNum.current++;
      const home = 'https://www.google.com';
      setTabs([{ id: nid, launch: home, url: home, title: 'New Tab', loading: false }]);
      setActiveId(nid);
      setOmnibox(home);
      return;
    }
    setTabs((ts) => ts.filter((t) => t.id !== id));
    if (activeId === id) {
      const next = remaining[Math.min(idx, remaining.length - 1)];
      setActiveId(next.id);
      setOmnibox(next.url || '');
    }
  };

  const selectTab = (id) => {
    setActiveId(id);
    const t = tabs.find((x) => x.id === id);
    if (t) setOmnibox(t.url);
    // Re-point the agent's guest at the tab the user just picked.
    const wv = webviews.current[id];
    if (wv) {
      try { const wid = wv.getWebContentsId(); if (wid) window.autobot.browserRegister(wid); } catch {}
      try { const u = wv.getURL(); if (u) { patchTab(id, { url: u }); setOmnibox(u); } } catch {}
    }
  };

  const exitInspectMode = useCallback(async () => {
    setInspectMode(false);
    inspectModeRef.current = false;
    const wv = webviews.current[activeIdRef.current];
    if (wv && window.autobot && window.autobot.browserInspectSet) {
      try {
        const wid = wv.getWebContentsId();
        if (wid) await window.autobot.browserInspectSet(wid, false);
      } catch (_) {}
    }
  }, []);

  const enterInspectMode = useCallback(async () => {
    const wv = webviews.current[activeIdRef.current];
    if (!wv || !window.autobot || !window.autobot.browserInspectSet) return;
    setInspectMode(true);
    inspectModeRef.current = true;
    try {
      const wid = wv.getWebContentsId();
      if (wid) await window.autobot.browserInspectSet(wid, true);
    } catch (_) {}
  }, []);

  const toggleInspectMode = useCallback(() => {
    if (inspectModeRef.current) exitInspectMode();
    else enterInspectMode();
  }, [enterInspectMode, exitInspectMode]);

  useEffect(() => {
    if (!inspectMode && !cropMode) return undefined;
    const onEsc = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (cropMode) { setCropMode(false); setCropDrag(null); }
        else exitInspectMode();
      }
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [inspectMode, cropMode, exitInspectMode]);

  const bindWebview = (id) => (el) => {
    if (!el || webviews.current[id]) return;
    webviews.current[id] = el;
    const isActive = () => activeIdRef.current === id;
    el.addEventListener('did-start-loading', () => patchTab(id, { loading: true }));
    el.addEventListener('did-stop-loading', () => {
      patchTab(id, { loading: false });
      if (isActive() && inspectModeRef.current && window.autobot && window.autobot.browserInspectSet) {
        try {
          const wid = el.getWebContentsId();
          if (wid) window.autobot.browserInspectSet(wid, true).catch(() => {});
        } catch (_) {}
      }
    });
    el.addEventListener('did-navigate', (e) => { patchTab(id, { url: e.url }); if (isActive()) setOmnibox(e.url); });
    el.addEventListener('did-navigate-in-page', (e) => { patchTab(id, { url: e.url }); if (isActive()) setOmnibox(e.url); });
    el.addEventListener('page-title-updated', (e) => patchTab(id, { title: e.title || 'Untitled' }));
    el.addEventListener('did-fail-load', (e) => { if (e.errorCode !== -3) patchTab(id, { loading: false }); });
    el.addEventListener('dom-ready', () => {
      try { const wid = el.getWebContentsId(); if (wid) window.autobot.browserRegister(wid); } catch {}
      try { const u = el.getURL(); patchTab(id, { url: u }); if (isActive()) setOmnibox(u); } catch {}
    });
    el.addEventListener('console-message', async (e) => {
      const msg = String((e && e.message) || '');
      if (!msg.startsWith('__AKRON_INSPECT__:')) return;
      try {
        const payload = JSON.parse(msg.slice('__AKRON_INSPECT__:'.length));
        if (!payload) return;
        if (payload.type === 'exit') {
          setInspectMode(false);
          inspectModeRef.current = false;
          return;
        }
        if (payload.type === 'select') {
          let shotDataUrl = '';
          try {
            const wid = el.getWebContentsId();
            if (wid && window.autobot && window.autobot.browserCaptureElement && payload.rect) {
              const r = await window.autobot.browserCaptureElement(wid, payload.rect);
              if (r && r.ok && r.dataUrl) shotDataUrl = r.dataUrl;
            }
          } catch (_) {}
          setInspectedEl({ ...payload, screenshot: shotDataUrl });
        }
      } catch (_) {}
    });
    el.addEventListener('new-window', (e) => { try { e.preventDefault(); if (e.url) openTab(e.url); } catch {} });
    el.addEventListener('found-in-page', (e) => setFindRes({ active: e.result.activeMatchOrdinal, total: e.result.matches }));
  };

  const navigate = (e) => {
    e.preventDefault();
    const wv = webviews.current[activeId];
    const raw = String(omnibox || '').trim();
    if (!wv || !raw) return;
    const go = (u) => {
      if (!u) return;
      patchTab(activeId, { loading: true });
      wv.loadURL(u);
    };
    const r = normalizeUrl(raw, cwd);
    if (r && typeof r.then === 'function') r.then(go).catch(() => {}); else go(r);
  };

  const goBack = () => { const wv = webviews.current[activeId]; if (wv && wv.canGoBack()) wv.goBack(); };
  const goForward = () => { const wv = webviews.current[activeId]; if (wv && wv.canGoForward()) wv.goForward(); };
  const reload = () => { const wv = webviews.current[activeId]; if (wv) wv.reload(); };
  const stopLoading = () => { const wv = webviews.current[activeId]; if (wv) wv.stop(); };
  const goHome = () => { const wv = webviews.current[activeId]; if (wv) wv.loadURL('https://www.google.com'); };

  const runFind = (text) => {
    setFindText(text);
    const wv = webviews.current[activeId];
    if (!wv) return;
    if (!text) { wv.stopFindInPage('clearSelection'); setFindRes(null); return; }
    wv.findInPage(text, { findNext: false, forward: true });
  };
  const closeFind = () => { runFind(''); setFindOpen(false); };

  // Keep the main process's copy of tab state fresh so agent tools can list tabs.
  useEffect(() => {
    if (!window.autobot || !window.autobot.browserSyncTabs) return;
    window.autobot.browserSyncTabs({ tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })), activeId });
  }, [tabs, activeId]);

  // Agent tab commands (browser_tabs tool) → renderer tab actions.
  const handlersRef = useRef({});
  handlersRef.current = { openTab, closeTab, selectTab };
  useEffect(() => {
    if (!window.autobot || !window.autobot.onBrowserTabsCommand) return undefined;
    return window.autobot.onBrowserTabsCommand((cmd) => {
      if (!cmd || !cmd.type) return;
      const h = handlersRef.current;
      if (cmd.type === 'new') h.openTab(cmd.url);
      else if (cmd.type === 'close') h.closeTab(cmd.tabId || activeIdRef.current);
      else if (cmd.type === 'switch') h.selectTab(cmd.tabId);
    });
  }, []);

  // A generated page (Write / Artifact) opens right here. Without this the
  // "website" only existed as a chat code block and the pane kept showing
  // Google — the exact "the site was never made" complaint.
  const previewTabRef = useRef(null);
  useEffect(() => {
    const target = previewUrl && previewUrl.url;
    if (!target) return undefined;
    let cancelled = false;
    const apply = (u) => {
      if (cancelled || !u) return;
      const pid = previewTabRef.current;
      const wv = pid ? webviews.current[pid] : null;
      if (wv) {
        patchTab(pid, { loading: true });
        try { wv.loadURL(u); } catch (_) {}
        setActiveId(pid);
        setOmnibox(u);
        return;
      }
      const reuse = !pid && tabs.length === 1 && /google\.com/i.test(tabs[0].url || '');
      const id = pid || (reuse ? tabs[0].id : 'tab' + nextTabNum.current++);
      previewTabRef.current = id;
      setTabs((ts) => (reuse
        ? ts.map((t) => ({ ...t, launch: u, url: u, title: 'Preview', loading: true }))
        : ts.some((t) => t.id === id)
          ? ts.map((t) => (t.id === id ? { ...t, launch: u, url: u, loading: true } : t))
          : [...ts, { id, launch: u, url: u, title: 'Preview', loading: true }]));
      setActiveId(id);
      setOmnibox(u);
    };
    const r = normalizeUrl(target, cwd);
    if (r && typeof r.then === 'function') r.then(apply).catch(() => {}); else apply(r);
    return () => { cancelled = true; };
  }, [previewUrl, cwd]);

  // When the pane closes every <webview> is destroyed: clear the guest so tools
  // don't drive a dead WebContents, and re-open the pane on the next tool call.
  useEffect(() => () => {
    Object.values(webviews.current).forEach((wv) => {
      try { const wid = wv.getWebContentsId(); if (wid) window.autobot.browserUnregister(wid); } catch {}
    });
    try { window.autobot.browserUnregister(); } catch {}
  }, []);

  // ---- ··· menu actions -------------------------------------------------
  // Every handler returns a short, honest status string for the menu footer.
  const currentUrl = () => {
    const wv = webviews.current[activeId];
    try { const u = wv && wv.getURL(); if (u) return u; } catch {}
    return (active && active.url) || omnibox || '';
  };
  const note = (msg) => { setMenuNote(msg); };
  const openExternal = async (profile) => {
    const url = currentUrl();
    if (!url) return note('Nothing to open yet');
    const r = await window.autobot.browserOpenExternal(url, profile);
    if (r && r.ok) { note('Opened in ' + r.app); setMenuOpen(false); return; }
    if (r && r.fallback === 'default') {
      const r2 = await window.autobot.browserOpenExternal(url, 'default');
      if (r2 && r2.ok) { note('Brave not installed — opened in ' + r2.app); setMenuOpen(false); return; }
    }
    note((r && r.error) || 'Could not open the page');
  };
  const copyLink = async () => {
    const url = currentUrl();
    if (!url) return note('Nothing to copy yet');
    try { await navigator.clipboard.writeText(url); note('Link copied'); }
    catch { note('Clipboard unavailable'); }
  };
  const saveShot = async () => {
    const name = String((active && active.title) || 'screenshot').replace(/[^\w.-]+/g, '-').slice(0, 60);
    const r = await window.autobot.browserSaveScreenshot(name);
    if (r && r.ok) { note('Saved to ' + r.path); setMenuOpen(false); }
    else if (!(r && r.canceled)) note((r && r.error) || 'Screenshot failed');
  };
  const openHtml = async () => {
    const r = await window.autobot.browserOpenFile();
    if (r && r.ok) { openTab(r.url); setMenuOpen(false); note('Opened ' + r.path); }
  };
  const toggleResponsive = () => {
    setResponsive((v) => { note('Viewport: ' + (!v ? 'Responsive (390px)' : 'Fill pane')); return !v; });
  };
  const toggleCookies = () => {
    setCookiesShared((v) => {
      note('Cookies: ' + (!v ? 'Shared with app sign-ins' : 'Isolated browser jar'));
      return !v;
    });
  };
  const importCookies = async () => {
    const r = await window.autobot.browserImportCookies(partition);
    if (r && r.ok) { note('Imported ' + r.added + ' cookies' + (r.failed ? ' (' + r.failed + ' skipped)' : '')); reload(); }
    else if (!(r && r.canceled)) note((r && r.error) || 'Import failed');
  };
  const clearData = async () => {
    const r = await window.autobot.browserClearData(partition);
    if (r && r.ok) { note('Cookies, cache and storage cleared'); reload(); }
    else note((r && r.error) || 'Could not clear data');
  };
  const attachShotPayload = useCallback((shot, modeLabel = 'Viewport') => {
    if (!shot || !shot.ok) return false;
    const slug = String((active && active.title) || 'browser').replace(/[^\w.-]+/g, '-').slice(0, 48) || 'browser';
    const fileName = `${slug}-${modeLabel === 'Region' ? 'region' : (modeLabel === 'Full Page' ? 'fullpage' : 'screenshot')}.png`;
    if (onAttachInspect && shot.dataUrl) {
      onAttachInspect([{
        name: fileName,
        path: shot.path || fileName,
        isImage: true,
        mimeType: 'image/png',
        dataUrl: shot.dataUrl,
      }], 'screenshot');
    }
    setLastShot({
      dataUrl: shot.dataUrl || '',
      path: shot.path || '',
      width: Number(shot.width) || 0,
      height: Number(shot.height) || 0,
      mode: modeLabel,
    });
    note(shot.path ? `Saved ${shot.path}` : `${modeLabel} screenshot attached to chat`);
    return true;
  }, [active, onAttachInspect]);

  const captureBrowserScreenshot = useCallback(async (fullPage = false) => {
    if (shotBusy) return;
    setShotBusy(true);
    setCropMode(false);
    setCropDrag(null);
    try {
      const wv = webviews.current[activeIdRef.current];
      let wid = null;
      try { wid = wv ? wv.getWebContentsId() : null; } catch (_) {}
      let res = window.autobot && window.autobot.browserScreenshot
        ? await window.autobot.browserScreenshot(Boolean(fullPage), wid)
        : null;
      if ((!res || !res.ok || !res.dataUrl) && wid && window.autobot && window.autobot.browserCaptureElement) {
        res = await window.autobot.browserCaptureElement(wid, null);
      }
      if (!attachShotPayload(res, fullPage ? 'Full Page' : 'Viewport')) {
        note((res && res.error) || 'Screenshot failed');
      }
    } catch (e) {
      note((e && e.message) || 'Screenshot failed');
    } finally {
      setShotBusy(false);
    }
  }, [shotBusy, attachShotPayload]);

  const startCropMode = useCallback(() => {
    if (inspectModeRef.current) exitInspectMode();
    setCropDrag(null);
    setCropMode(true);
  }, [exitInspectMode]);

  const onCropMouseDown = (e) => {
    if (!cropMode || !stageRef.current) return;
    e.preventDefault();
    const r = stageRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    const y = Math.max(0, Math.min(r.height, e.clientY - r.top));
    setCropDrag({ x0: x, y0: y, x1: x, y1: y });
  };
  const onCropMouseMove = (e) => {
    if (!cropDrag || !stageRef.current) return;
    const r = stageRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    const y = Math.max(0, Math.min(r.height, e.clientY - r.top));
    setCropDrag((d) => (d ? { ...d, x1: x, y1: y } : null));
  };
  const onCropMouseUp = async () => {
    if (!cropDrag) return;
    const x = Math.round(Math.min(cropDrag.x0, cropDrag.x1));
    const y = Math.round(Math.min(cropDrag.y0, cropDrag.y1));
    const width = Math.round(Math.abs(cropDrag.x1 - cropDrag.x0));
    const height = Math.round(Math.abs(cropDrag.y1 - cropDrag.y0));
    setCropDrag(null);
    setCropMode(false);
    if (width < 12 || height < 12) return;
    const wv = webviews.current[activeIdRef.current];
    if (!wv || !window.autobot || !window.autobot.browserCaptureElement) return;
    try {
      const wid = wv.getWebContentsId();
      const res = await window.autobot.browserCaptureElement(wid, { x, y, width, height });
      attachShotPayload(res, 'Region');
    } catch (e) {
      note((e && e.message) || 'Region screenshot failed');
    }
  };

  const openDevTools = async () => {
    const wv = webviews.current[activeId];
    if (!wv) return note('Developer tools unavailable');
    try {
      if (window.autobot && window.autobot.browserToggleDevTools) {
        const wid = wv.getWebContentsId();
        const r = await window.autobot.browserToggleDevTools(wid);
        if (r && r.ok) {
          setDevToolsOpen(!!r.opened);
          setMenuOpen(false);
          note(r.opened ? 'Developer tools opened' : 'Developer tools closed');
          return;
        }
      }
      if (wv.isDevToolsOpened && wv.isDevToolsOpened()) {
        wv.closeDevTools();
        setDevToolsOpen(false);
      } else {
        wv.openDevTools();
        setDevToolsOpen(true);
      }
      setMenuOpen(false);
    } catch {
      note('Developer tools unavailable');
    }
  };

  const sendInspectedToAgent = () => {
    if (!inspectedEl || !onAttachInspect) return;
    const styleLines = Object.entries(inspectedEl.computedStyles || {})
      .map(([k, v]) => `  - \`${k}\`: \`${v}\``)
      .join('\n');
    const summary = [
      `# Inspected Browser Element`,
      `- **Page**: ${inspectedEl.title || 'Untitled'} (${inspectedEl.url || ''})`,
      `- **Element**: \`${inspectedEl.tagLabel || inspectedEl.tagName}\``,
      `- **CSS Selector**: \`${inspectedEl.selector}\``,
      styleLines ? `- **Computed Styles**:\n${styleLines}` : '',
      inspectedEl.innerText ? `- **Text**: ${JSON.stringify(inspectedEl.innerText)}` : '',
      `\`\`\`html\n${inspectedEl.outerHTML || ''}\n\`\`\``,
    ].filter(Boolean).join('\n');
    const atts = [
      {
        name: 'inspected-element.md',
        path: 'inspected-element.md',
        size: summary.length,
        isText: true,
        content: summary,
      },
    ];
    if (inspectedEl.screenshot) {
      atts.push({
        name: 'inspected-element.png',
        path: 'inspected-element.png',
        isImage: true,
        mimeType: 'image/png',
        dataUrl: inspectedEl.screenshot,
      });
    }
    onAttachInspect(atts);
    setInspectedEl(null);
    exitInspectMode();
  };
  const runDevServer = async () => {
    if (!cwd) return;
    setDevBusy(true);
    note('Starting ' + ((dev && dev.script) || 'dev server') + '…');
    try {
      const r = await window.autobot.devServerStart(cwd);
      if (r && r.ok && r.url) {
        openTab(r.url);
        setDev((d) => ({ ...(d || {}), running: true, port: r.port, url: r.url }));
        note('Dev server up on :' + r.port);
      } else if (r && r.ok && r.pending) {
        setDev((d) => ({ ...(d || {}), running: true }));
        note('Started — waiting for the port to answer');
      } else {
        note((r && r.error) || 'Could not start the dev server');
      }
    } finally {
      setDevBusy(false);
      setMenuOpen(false);
    }
  };

  return (
    <div className={'browser-panel' + (expanded ? ' expanded' : '')}>
      <div className="browser-tabs">
        <div className="browser-tab-strip">
          {tabs.map((t) => (
            <div key={t.id} className={'browser-tab ' + (t.id === activeId ? 'on' : '')} onClick={() => selectTab(t.id)} title={t.url}>
              {t.loading ? <Icon name="Spinner" size={12} className="spin" /> : <Icon name="Globe" size={12} />}
              <span className="browser-tab-title">{t.title || 'New Tab'}</span>
              <button className="browser-tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}><Icon name="X" size={11} /></button>
            </div>
          ))}
        </div>
        {/* The actions live in the tab row, pinned right, so they can never be
            squeezed out of the toolbar by a narrow pane. */}
        <div className="browser-tabs-actions">
          <button className="browser-act" onClick={() => openTab()} title="New tab"><Icon name="Add" size={14} /></button>
          <button
            className={'browser-act' + (expanded ? ' browser-restore-btn on' : '')}
            onClick={() => setExpanded(!expanded)}
            title={expanded ? 'Minimize / Restore side pane (⌘↓ or Esc)' : 'Expand (⌘↑)'}
          >
            <Icon name={expanded ? 'ArrowsIn' : 'ArrowsOut'} size={14} />
            {expanded && <span>Minimize</span>}
          </button>
          {expanded && onClose && (
            <button
              className="browser-act"
              onClick={() => { setExpanded(false); onClose(); }}
              title="Close browser pane"
            >
              <Icon name="X" size={14} />
            </button>
          )}
          <button ref={menuBtnRef} className={'browser-act browser-menu-btn' + (menuOpen ? ' on' : '')} onClick={() => { setMenuNote(''); setMenuOpen(!menuOpen); }} title="Browser options"><Icon name="DotsHorizontal" size={15} /></button>
        </div>
      </div>

      <div className="browser-toolbar">
        <button className="icon-btn" onClick={goBack} title="Back"><Icon name="ArrowLeft" size={16} /></button>
        <button className="icon-btn" onClick={goForward} title="Forward"><Icon name="ArrowRight" size={16} /></button>
        {active && active.loading
          ? <button className="icon-btn" onClick={stopLoading} title="Stop"><Icon name="X" size={15} /></button>
          : <button className="icon-btn" onClick={reload} title="Reload"><Icon name="ArrowClockwise" size={15} /></button>}
        <button className="icon-btn" onClick={goHome} title="Home"><Icon name="Home" size={15} /></button>
        <form className="omnibox" onSubmit={navigate}>
          <Icon name="Lock" size={12} className="omnibox-lock" />
          <input ref={omniboxRef} value={omnibox} onChange={(e) => setOmnibox(e.target.value)} placeholder="Search or enter address" spellCheck={false} />
        </form>
        <button
          type="button"
          data-testid="browser-screenshot-btn"
          className={'icon-btn browser-screenshot-btn' + (cropMode ? ' on' : '')}
          onClick={(e) => (e.shiftKey ? startCropMode() : captureBrowserScreenshot(false))}
          disabled={shotBusy}
          title="Capture Screenshot to Chat (Shift+Click to drag & crop region)"
          aria-pressed={cropMode}
        >
          <Icon name="Camera" size={15} />
        </button>
        <button
          type="button"
          className={'icon-btn browser-inspect-btn' + (inspectMode ? ' on' : '')}
          onClick={toggleInspectMode}
          title={inspectMode ? 'Exit Inspect Mode (Esc)' : 'Inspect Element'}
          aria-pressed={inspectMode}
        >
          <Icon name="Eye" size={15} />
        </button>
        <button
          type="button"
          className={'icon-btn browser-devtools-btn' + (devToolsOpen ? ' on' : '')}
          onClick={openDevTools}
          title="Toggle Preview DevTools"
          aria-pressed={devToolsOpen}
        >
          <Icon name="Wrench" size={14} />
        </button>
        <button className={'icon-btn' + (findOpen ? ' on' : '')} onClick={() => setFindOpen(!findOpen)} title="Find in page"><Icon name="Search" size={15} /></button>
      </div>

      {inspectMode && (
        <div className="browser-inspect-banner" role="status">
          <div className="browser-inspect-banner-left">
            <span className="browser-inspect-dot" />
            <span>
              <strong>Inspect Element</strong> — Hover to highlight, click any element to inspect &amp; capture
            </span>
          </div>
          <button type="button" className="browser-exit-inspect-btn" onClick={exitInspectMode}>
            Exit Inspect Mode <kbd>Esc</kbd>
          </button>
        </div>
      )}

      {menuOpen && (
        <div className="browser-menu" role="menu" ref={menuRef}>
          <button className="bm-item" role="menuitem" onClick={() => { setExpanded((v) => !v); setMenuOpen(false); }}>
            <Icon name={expanded ? 'ArrowsIn' : 'ArrowsOut'} size={14} />
            <span className="bm-label">{expanded ? 'Minimize to side pane' : 'Maximize browser'}</span>
          </button>
          <div className="bm-sep" />
          <button className="bm-item" role="menuitem" onClick={() => openExternal('brave')}><Icon name="ArrowUpRight" size={14} /><span className="bm-label">Open in Brave Browser</span></button>
          <button className="bm-item" role="menuitem" onClick={() => openExternal('default')}><Icon name="Globe" size={14} /><span className="bm-label">Open in default browser</span></button>
          <button className="bm-item" role="menuitem" onClick={copyLink}><Icon name="Copy" size={14} /><span className="bm-label">Copy link</span></button>
          <button className="bm-item" role="menuitem" onClick={saveShot}><Icon name="Camera" size={14} /><span className="bm-label">Save screenshot</span></button>
          <button className="bm-item" role="menuitem" onClick={openHtml}><Icon name="Code" size={14} /><span className="bm-label">Open HTML file…</span></button>
          <div className="bm-sep" />
          <button className="bm-item" role="menuitem" onClick={toggleResponsive}><Icon name="Frame" size={14} /><span className="bm-label">Viewport</span><span className="bm-value">{responsive ? 'Responsive' : 'Fill'}</span></button>
          <button className="bm-item" role="menuitem" onClick={openDevTools}><Icon name="Wrench" size={14} /><span className="bm-label">More settings · Developer tools</span></button>
          <div className="bm-sep" />
          <button className="bm-item" role="menuitem" onClick={importCookies}><Icon name="Download" size={14} /><span className="bm-label">Import cookies…</span></button>
          <button className="bm-item" role="menuitem" onClick={toggleCookies}><Icon name={cookiesShared ? 'Share' : 'Lock'} size={14} /><span className="bm-label">Keep cookies</span><span className="bm-value">{cookiesShared ? 'Shared' : 'Isolated'}</span></button>
          <button className="bm-item danger" role="menuitem" onClick={clearData}><Icon name="Broom" size={14} /><span className="bm-label">Clear browsing data</span></button>
          {menuNote && <div className="bm-note">{menuNote}</div>}
        </div>
      )}

      {findOpen && (
        <div className="browser-find">
          <input autoFocus value={findText} onChange={(e) => runFind(e.target.value)} placeholder="Find in page…" />
          <span className="find-res">{findRes ? `${findRes.active}/${findRes.total}` : ''}</span>
          <button className="icon-btn" onClick={() => runFind('')}><Icon name="X" size={13} /></button>
        </div>
      )}

      {dev && (dev.hasScript || dev.running) && (
        <div className={'devfound' + (dev.running ? ' running' : '')}>
          <span className="devfound-dot" />
          <span className="devfound-text">
            <b>Dev server {dev.running ? 'running' : 'found'}</b>
            <span className="devfound-sub">
              {dev.script ? dev.script + ' · ' : ''}{dev.framework}{dev.port ? ' :' + dev.port : ''}
            </span>
          </span>
          {dev.running && dev.url ? (
            <button className="devfound-btn" onClick={() => openTab(dev.url)}>Open</button>
          ) : (
            <button className="devfound-btn" disabled={devBusy || !dev.hasScript} onClick={runDevServer}>
              {devBusy ? 'Starting…' : 'Run'}
            </button>
          )}
        </div>
      )}

      <div ref={stageRef} className={'browser-stage' + (responsive ? ' responsive' : '')}>
        {tabs.map((t) => (
          <webview
            key={t.id + ':' + partition}
            ref={bindWebview(t.id)}
            className="browser-webview"
            style={{ display: t.id === activeId ? 'flex' : 'none' }}
            src={t.launch || t.url}
            partition={partition}
          />
        ))}
        {cropMode && (
          <div
            className="browser-crop-overlay"
            onMouseDown={onCropMouseDown}
            onMouseMove={onCropMouseMove}
            onMouseUp={onCropMouseUp}
          >
            <div className="browser-crop-hint">Drag to capture region to Chat · Press Esc to cancel</div>
            {cropDrag && (
              <div
                className="browser-crop-box"
                style={{
                  left: Math.min(cropDrag.x0, cropDrag.x1),
                  top: Math.min(cropDrag.y0, cropDrag.y1),
                  width: Math.abs(cropDrag.x1 - cropDrag.x0),
                  height: Math.abs(cropDrag.y1 - cropDrag.y0),
                }}
              />
            )}
          </div>
        )}
        {lastShot && (
          <div className="browser-shot-toast" role="status" data-testid="browser-shot-toast">
            <div className="bst-top">
              {lastShot.dataUrl && <img className="bst-thumb" src={lastShot.dataUrl} alt="Browser screenshot preview" />}
              <div className="bst-meta">
                <span className="bst-title">✓ Attached to Chat ({lastShot.mode})</span>
                <span className="bst-sub">{lastShot.width && lastShot.height ? `${lastShot.width}×${lastShot.height}` : 'PNG'}</span>
              </div>
              <button type="button" className="icon-btn" onClick={() => setLastShot(null)} title="Dismiss"><Icon name="X" size={12} /></button>
            </div>
            <div className="bst-actions">
              <button type="button" className="bic-btn" onClick={startCropMode}><Icon name="Frame" size={12} /> Select Area</button>
              <button type="button" className="bic-btn" onClick={() => captureBrowserScreenshot(true)} disabled={shotBusy}>Full Page</button>
              <button type="button" className="bic-btn" onClick={saveShot}><Icon name="Download" size={12} /> Save…</button>
            </div>
          </div>
        )}
        {inspectedEl && (
          <div className="browser-inspect-card" role="region" aria-label="Inspected element details">
            <div className="bic-head">
              <span className="bic-tag">{inspectedEl.tagLabel || inspectedEl.tagName}</span>
              <button type="button" className="icon-btn" onClick={() => setInspectedEl(null)} title="Dismiss"><Icon name="X" size={12} /></button>
            </div>
            <div className="bic-body">
              {inspectedEl.screenshot && (
                <img className="bic-shot" src={inspectedEl.screenshot} alt={inspectedEl.tagLabel || 'Inspected element'} />
              )}
              <code className="bic-selector" title={inspectedEl.selector}>{inspectedEl.selector}</code>
              <div className="bic-styles">
                {Object.entries(inspectedEl.computedStyles || {}).slice(0, 6).map(([k, v]) => (
                  <span key={k} className="bic-style-chip">{k}: {String(v).slice(0, 28)}</span>
                ))}
              </div>
              {inspectedEl.outerHTML && (
                <details className="bic-html-details">
                  <summary>outerHTML ({inspectedEl.outerHTML.length} chars)</summary>
                  <pre className="bic-html">{inspectedEl.outerHTML.slice(0, 800)}</pre>
                </details>
              )}
            </div>
            <div className="bic-actions">
              <button type="button" className="bic-btn primary" onClick={sendInspectedToAgent}>
                <Icon name="Sparkles" size={12} /> Send to Agent
              </button>
              <button
                type="button"
                className="bic-btn"
                onClick={() => { navigator.clipboard?.writeText(inspectedEl.selector || '').catch(() => {}); note('Selector copied'); }}
              >
                Copy Selector
              </button>
              <button
                type="button"
                className="bic-btn"
                onClick={() => { navigator.clipboard?.writeText(inspectedEl.outerHTML || '').catch(() => {}); note('HTML copied'); }}
              >
                Copy HTML
              </button>
              {inspectMode && (
                <button type="button" className="bic-btn" onClick={exitInspectMode}>Exit Inspect Mode</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
