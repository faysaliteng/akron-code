import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Icon, GoogleDriveIcon } from '../components/Icon.jsx';

export function QuestionModal({ question, answer }) {
  const [text, setText] = useState('');
  const isPlan = question.type === 'plan';
  const options = question.options || [];

  const submit = (ans) => answer(ans);

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>{isPlan ? 'Plan approval' : 'Akron Code needs your input'}</h2>
        <div className="question-text">{question.text}</div>

        {!isPlan && options.length > 0 && (
          <div className="qoptions">
            {options.map((o, i) => {
              const label = typeof o === 'string' ? o : (o.label || o.value || String(o));
              const desc = typeof o === 'object' ? o.description : null;
              return (
                <button key={i} className="qopt" onClick={() => submit(label)}>
                  <b>{label}</b>
                  {desc && <span>{desc}</span>}
                </button>
              );
            })}
          </div>
        )}

        <textarea
          className="qinput"
          placeholder={isPlan ? 'Add a note (optional)…' : 'Or type your own answer…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !isPlan) { e.preventDefault(); submit(text); } }}
        />

        <div className="modal-actions">
          {isPlan ? (
            <>
              <button onClick={() => submit('Plan rejected.' + (text ? ' Note: ' + text : ''))}>Reject</button>
              <button className="primary" onClick={() => submit('Plan approved. Proceed.' + (text ? ' Note: ' + text : ''))}>Approve plan</button>
            </>
          ) : (
            <button className="primary" onClick={() => submit(text)}>Submit</button>
          )}
        </div>
      </div>
    </div>
  );
}

const CU_TIERS = {
  access: { label: 'See the screen', blurb: 'Akron Code can look at your screen and click/type to finish this task.' },
  full_control: { label: 'Full control', blurb: 'Akron Code can drive any app, window, and keyboard shortcut without asking again.' },
  teach_access: { label: 'Watch and learn', blurb: 'Akron Code records your screen while you do a task once, then repeats it.' },
};

export function ComputerUseModal({ consent, answer }) {
  const [remember, setRemember] = useState(false);
  const info = CU_TIERS[consent.tier] || CU_TIERS.access;
  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>Allow Computer Use?</h2>
        <div className="perm-tool">{info.label}</div>
        <p style={{ opacity: 0.82, margin: '8px 0 4px' }}>{info.blurb}</p>
        {consent.tool && (
          <pre className="perm-summary">{consent.tool}{consent.sensitive ? '  (global shortcut / right-click)' : ''}</pre>
        )}
        <label className="check" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this until I turn it off
        </label>
        <div className="modal-actions">
          <button onClick={() => answer(false)}>Deny</button>
          <button className="primary" onClick={() => answer(true, remember)}>Allow</button>
        </div>
      </div>
    </div>
  );
}

export function CommandPalette({ onClose, onNewChat, onSearch, onToggleBrowser, onToggleCode, onSettings, onOpenTutorial, onQuickEntry, onAbout, onExport, onToggleSidebar, onToggleTheme }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const COMMANDS = [
    { key: 'new', label: 'New chat', icon: 'Add', run: onNewChat },
    { key: 'tutorial', label: 'Interactive Tutorial & How-To Guide…', icon: 'GraduationCap', run: () => onOpenTutorial && onOpenTutorial('tour') },
    { key: 'search', label: 'Search conversations…', icon: 'Search', run: onSearch },
    { key: 'browser', label: 'Toggle browser pane', icon: 'Globe', run: onToggleBrowser },
    { key: 'code', label: 'Code mode', icon: 'Code', run: onToggleCode },
    { key: 'sidebar', label: 'Toggle sidebar', icon: 'SidebarClose', run: onToggleSidebar },
    { key: 'theme', label: 'Toggle theme', icon: 'Lightbulb', run: onToggleTheme },
    { key: 'quick', label: 'Quick Entry…', icon: 'CommandLine', run: onQuickEntry },
    { key: 'export', label: 'Export current conversation', icon: 'Download', run: onExport },
    { key: 'settings', label: 'Settings…', icon: 'Settings', run: onSettings },
    { key: 'about', label: 'About Akron Code', icon: 'Chat', run: onAbout },
  ];

  const query = q.trim().toLowerCase();
  const items = query ? COMMANDS.filter((c) => c.label.toLowerCase().includes(query)) : COMMANDS;
  const [sel, setSel] = useState(0);
  useEffect(() => { setSel(0); }, [query]);

  const run = (c) => { onClose(); c.run(); };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal palette-modal" onClick={(e) => e.stopPropagation()}>
        <div className="search-box">
          <Icon name="CommandLine" size={16} />
          <input
            ref={inputRef}
            placeholder="Type a command…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); run(items[sel]); }
            }}
          />
        </div>
        <div className="palette-list">
          {items.map((c, i) => (
            <button key={c.key} className={'palette-item ' + (i === sel ? 'sel' : '')} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              <Icon name={c.icon} size={15} />
              <span>{c.label}</span>
            </button>
          ))}
          {items.length === 0 && <p className="muted">No matching command.</p>}
        </div>
      </div>
    </div>
  );
}

export function FindBar({ query, setQuery, messages, onClose }) {
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const hits = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    const out = [];
    for (const m of messages) {
      const body = String(m.content || '');
      let i = body.toLowerCase().indexOf(q);
      while (i !== -1) {
        out.push({ role: m.role, start: i, snippet: body.slice(Math.max(0, i - 25), i + 75) });
        i = body.toLowerCase().indexOf(q, i + 1);
        if (out.length > 200) return out;
      }
    }
    return out;
  }, [query, messages]);

  const cur = hits.length ? Math.min(idx, hits.length - 1) : 0;

  return (
    <div className="findbar">
      <div className="search-box">
        <Icon name="Search" size={14} />
        <input
          ref={inputRef}
          placeholder="Find in conversation…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'Enter') { e.preventDefault(); setIdx((i) => (hits.length ? (i + 1) % hits.length : 0)); }
          }}
        />
        <span className="find-count">{hits.length ? (cur + 1) + '/' + hits.length : '0/0'}</span>
        <button className="icon-btn" onClick={() => setIdx((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0))}><Icon name="ArrowUp" size={14} /></button>
        <button className="icon-btn" onClick={() => setIdx((i) => (hits.length ? (i + 1) % hits.length : 0))}><Icon name="ArrowDown" size={14} /></button>
        <button className="icon-btn" onClick={onClose}><Icon name="X" size={14} /></button>
      </div>
      {query && hits.length > 0 && <div className="find-result"><span className="find-role">{hits[cur].role}</span> …{hits[cur].snippet}…</div>}
    </div>
  );
}

export function GoogleDriveModal({ gdriveState, onRefreshStatus, onAttachFiles, onClose }) {
  const detected = (gdriveState && gdriveState.detectedLocalFolders) || [];
  const connected = !!(gdriveState && gdriveState.connected);
  const [tab, setTab] = useState(connected ? 'browse' : (detected.length ? 'local' : 'token'));
  const [folderPath, setFolderPath] = useState(() => (gdriveState && gdriveState.folderPath) || (detected[0] && detected[0].path) || '');
  const [accessToken, setAccessToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpCmd, setMcpCmd] = useState('npx');
  const [mcpArgs, setMcpArgs] = useState('-y @modelcontextprotocol/server-gdrive');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [files, setFiles] = useState([]);
  const [searching, setSearching] = useState(false);

  const loadFiles = useCallback(async (q = '') => {
    if (!window.autobot || !window.autobot.gdriveSearch) return;
    setSearching(true);
    try {
      const r = await window.autobot.gdriveSearch(q, { limit: 30 });
      if (r && r.ok) setFiles(r.files || []);
      else if (r && r.error) setErr(r.error);
    } finally { setSearching(false); }
  }, []);

  useEffect(() => {
    if (connected) loadFiles('');
  }, [connected, loadFiles]);

  const pickLocalFolder = async () => {
    const p = await window.autobot.gdrivePickFolder();
    if (p) setFolderPath(p);
  };

  const connectMode = async (payload) => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await window.autobot.gdriveConnect(payload);
      if (!r || !r.ok) {
        setErr((r && r.error) || 'Failed to connect Google Drive');
        return;
      }
      setMsg(`Connected Google Drive (${(r.status && r.status.mode) || payload.mode}).`);
      if (onRefreshStatus) await onRefreshStatus();
      setTab('browse');
      await loadFiles('');
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnectDrive = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      await window.autobot.gdriveDisconnect();
      setFiles([]);
      setMsg('Disconnected Google Drive.');
      if (onRefreshStatus) await onRefreshStatus();
      setTab(detected.length ? 'local' : 'token');
    } finally { setBusy(false); }
  };

  const attachDriveFile = async (f) => {
    setBusy(true); setErr('');
    try {
      const res = await window.autobot.gdriveRead(f.id || f.path);
      if (!res || !res.ok) {
        setErr((res && res.error) || 'Could not read Drive file');
        return;
      }
      if (onAttachFiles) {
        onAttachFiles([{
          name: `${res.name || f.name} (Drive)`,
          path: `gdrive://${res.id || f.id}`,
          size: String(res.content || '').length,
          isText: true,
          content: String(res.content || ''),
        }]);
      }
      setMsg(`Attached "${res.name || f.name}" to composer context.`);
      onClose();
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal gdrive-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gdrive-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <GoogleDriveIcon size={20} />
            <div>
              <h2>Google Drive</h2>
              <span className="muted">
                {connected
                  ? `Connected via ${gdriveState.mode}${gdriveState.accountEmail ? ' · ' + gdriveState.accountEmail : (gdriveState.folderPath ? ' · ' + gdriveState.folderPath : '')}`
                  : 'Connect Drive files, Docs, Sheets & Slides to chat context and agent tools'}
              </span>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="X" size={16} /></button>
        </div>

        <div className="seg" style={{ marginBottom: 12 }}>
          {connected && <button className={tab === 'browse' ? 'on' : ''} onClick={() => setTab('browse')}>Browse &amp; Attach</button>}
          <button className={tab === 'local' ? 'on' : ''} onClick={() => setTab('local')}>Drive Desktop Folder</button>
          <button className={tab === 'token' ? 'on' : ''} onClick={() => setTab('token')}>Google OAuth / Token</button>
          <button className={tab === 'mcp' ? 'on' : ''} onClick={() => setTab('mcp')}>MCP Server</button>
        </div>

        {err && <div className="plugin-test-res err" style={{ marginBottom: 10 }}>✕ {err}</div>}
        {msg && <div className="plugin-test-res ok" style={{ marginBottom: 10 }}>✓ {msg}</div>}

        {tab === 'browse' && connected && (
          <div className="gdrive-body">
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <input
                className="gdrive-input"
                placeholder="Search Google Drive files…"
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') loadFiles(searchQ); }}
              />
              <button className="btn-mini primary" disabled={searching} onClick={() => loadFiles(searchQ)}>
                {searching ? 'Searching…' : 'Search'}
              </button>
              <button className="btn-mini" disabled={busy} onClick={disconnectDrive}>Disconnect</button>
            </div>
            <div className="gdrive-list">
              {files.map((f) => (
                <div key={f.id || f.path || f.name} className="gdrive-file-row">
                  <Icon name="File" size={14} />
                  <div className="gdrive-file-meta">
                    <b>{f.name}</b>
                    <span className="muted">{f.relativePath || f.mimeType || ''}</span>
                  </div>
                  <button className="btn-mini primary" disabled={busy} onClick={() => attachDriveFile(f)}>Attach</button>
                </div>
              ))}
              {!searching && files.length === 0 && <p className="muted">No files matched in connected Google Drive.</p>}
            </div>
          </div>
        )}

        {tab === 'local' && (
          <div className="gdrive-body">
            <p className="muted">Connect a synced Google Drive for Desktop mount (<code>~/Library/CloudStorage/GoogleDrive-*</code>) or any local synced Drive folder with zero cloud console setup.</p>
            {detected.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {detected.map((d) => (
                  <button key={d.path} className="btn-mini primary" disabled={busy} onClick={() => { setFolderPath(d.path); connectMode({ mode: 'local', folderPath: d.path }); }}>
                    Use {d.label}
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="gdrive-input" placeholder="/Users/.../Library/CloudStorage/GoogleDrive-.../My Drive" value={folderPath} onChange={(e) => setFolderPath(e.target.value)} />
              <button className="btn-mini" onClick={pickLocalFolder}>Browse…</button>
            </div>
            <div className="gdrive-foot">
              <button className="btn-mini primary" disabled={busy || !folderPath.trim()} onClick={() => connectMode({ mode: 'local', folderPath: folderPath.trim() })}>
                {busy ? 'Connecting…' : 'Connect Folder'}
              </button>
              {connected && <button className="btn-mini" disabled={busy} onClick={disconnectDrive}>Disconnect</button>}
            </div>
          </div>
        )}

        {tab === 'token' && (
          <div className="gdrive-body">
            <p className="muted">Connect directly to Google Drive REST API v3 with either a Google OAuth 2.0 Client ID (PKCE browser sign-in) or a Google OAuth access token.</p>
            <div className="gdrive-fields">
              <label>Google OAuth Access Token (instant connection)</label>
              <input type="password" className="gdrive-input" placeholder="ya29...." value={accessToken} onChange={(e) => setAccessToken(e.target.value)} />
              <button className="btn-mini primary" style={{ alignSelf: 'flex-start' }} disabled={busy || !accessToken.trim()} onClick={() => connectMode({ mode: 'token', accessToken: accessToken.trim() })}>
                {busy ? 'Verifying…' : 'Connect with Access Token'}
              </button>
            </div>
            <div className="model-menu-divider" style={{ margin: '12px 0' }} />
            <div className="gdrive-fields">
              <label>Or Sign in via Google OAuth 2.0 PKCE</label>
              <input type="text" className="gdrive-input" placeholder="Google OAuth Client ID (....apps.googleusercontent.com)" value={clientId} onChange={(e) => setClientId(e.target.value)} />
              <input type="password" className="gdrive-input" placeholder="Client Secret (optional for desktop OAuth)" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
              <button className="btn-mini" disabled={busy || !clientId.trim()} onClick={() => connectMode({ mode: 'oauth', clientId: clientId.trim(), clientSecret: clientSecret.trim() })}>
                {busy ? 'Opening Google Sign-in…' : 'Sign in with Google'}
              </button>
            </div>
          </div>
        )}

        {tab === 'mcp' && (
          <div className="gdrive-body">
            <p className="muted">Connect an external Google Drive MCP server over stdio (<code>@modelcontextprotocol/server-gdrive</code>) or HTTP/SSE.</p>
            <div className="gdrive-fields">
              <label>HTTP / SSE MCP Server URL (optional)</label>
              <input type="text" className="gdrive-input" placeholder="https://.../mcp (leave blank to use stdio command below)" value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} />
              <label>Stdio Command &amp; Args</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="text" className="gdrive-input" style={{ flex: '0 0 120px' }} value={mcpCmd} onChange={(e) => setMcpCmd(e.target.value)} />
                <input type="text" className="gdrive-input" value={mcpArgs} onChange={(e) => setMcpArgs(e.target.value)} />
              </div>
            </div>
            <div className="gdrive-foot">
              <button
                className="btn-mini primary"
                disabled={busy}
                onClick={() => connectMode(mcpUrl.trim()
                  ? { mode: 'mcp', url: mcpUrl.trim(), transport: /sse/i.test(mcpUrl) ? 'sse' : 'http' }
                  : { mode: 'mcp', command: mcpCmd.trim() || 'npx', args: mcpArgs.trim().split(/\s+/).filter(Boolean) })}
              >
                {busy ? 'Connecting…' : 'Connect MCP Server'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
