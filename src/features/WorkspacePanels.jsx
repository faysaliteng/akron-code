import React, { useState } from 'react';
import { Icon } from '../components/Icon.jsx';

const makeUid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

export function MemoryView({ memory, addMemory, clearMemory, convs = [], provider = null, onJumpToMessage }) {
  const [curated, setCurated] = React.useState({ autoCurate: false, entries: [] });
  const [areaFilter, setAreaFilter] = React.useState('all');
  const [editingId, setEditingId] = React.useState(null);
  const [editDraft, setEditDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState('');

  const refreshCurated = React.useCallback(async () => {
    try {
      if (window.autobot && window.autobot.getCuratedMemory) {
        const st = await window.autobot.getCuratedMemory();
        if (st && Array.isArray(st.entries)) setCurated(st);
      }
    } catch (_) {}
  }, []);

  React.useEffect(() => { refreshCurated(); }, [refreshCurated]);

  const toggleAuto = async () => {
    if (!window.autobot || !window.autobot.setMemoryAutoCurate) return;
    const r = await window.autobot.setMemoryAutoCurate(!curated.autoCurate);
    if (r && r.state) setCurated(r.state);
  };

  const runCurate = async () => {
    if (!window.autobot || !window.autobot.curateMemory) return;
    setBusy(true); setMsg('');
    try {
      const r = await window.autobot.curateMemory({ convs, provider });
      if (r && r.state) setCurated(r.state);
      if (r && r.ok) setMsg(`Curated ${r.added || 0} new note(s), archived ${r.archived || 0}, rejected ${r.rejected || 0} unverified.`);
    } finally { setBusy(false); }
  };

  const saveEdit = async (id) => {
    if (!window.autobot || !window.autobot.updateCuratedMemory) return;
    const r = await window.autobot.updateCuratedMemory({ id, patch: { content: editDraft } });
    if (r && r.ok === false) { setMsg(r.error || 'Could not update note'); return; }
    setEditingId(null); setEditDraft('');
    await refreshCurated();
  };

  const forgetEntry = async (id) => {
    if (!window.autobot || !window.autobot.deleteCuratedMemory) return;
    await window.autobot.deleteCuratedMemory(id);
    await refreshCurated();
  };

  const activeCurated = (curated.entries || []).filter((e) => !e.archived && (areaFilter === 'all' || e.area === areaFilter));

  return (
    <div className="panel">
      <div className="panel-head"><h2>Long-term memory</h2>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="btn-mini primary" disabled={busy} onClick={runCurate}>{busy ? 'Curating…' : 'Curate Now'}</button>
          <button type="button" className="btn-mini" onClick={addMemory}>+ Add Manual</button>
          <button type="button" className="btn-mini" onClick={clearMemory}>Clear Manual</button>
        </div>
      </div>

      <div className="oc-row" style={{ marginBottom: 10 }}>
        <div className="oc-row-meta">
          <div className="oc-row-title">Auto-Curate from My Messages (opt-in)</div>
          <div className="oc-row-sub">Reads only your own messages (ignores external tool/web output) and requires a verbatim quote for every fact.</div>
        </div>
        <div className="oc-row-ctrl">
          <button type="button" role="switch" aria-checked={!!curated.autoCurate} className={'oc-switch' + (curated.autoCurate ? ' on' : '')} onClick={toggleAuto}>
            <span className="oc-switch-knob" />
          </button>
        </div>
      </div>

      <div className="mc-filters" style={{ marginBottom: 10 }}>
        {['all', 'about', 'preferences', 'people', 'routines', 'lessons'].map((a) => (
          <button key={a} type="button" className={'mc-filter-pill' + (areaFilter === a ? ' on' : '')} onClick={() => setAreaFilter(a)}>
            {a === 'all' ? 'All Areas' : a}
          </button>
        ))}
      </div>

      {msg && <p className="muted" style={{ margin: '0 0 8px' }}>{msg}</p>}

      {activeCurated.map((e) => (
        <div key={e.id} className="memitem">
          <div className="mem-ts" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span><strong>[{e.area}]</strong> · {new Date(e.ts || Date.now()).toLocaleString()}</span>
            <span style={{ display: 'inline-flex', gap: 6 }}>
              {e.convId && onJumpToMessage && (
                <button type="button" className="btn-mini" onClick={() => onJumpToMessage(e.convId, e.sourceMsgId)}>Jump</button>
              )}
              <button type="button" className="btn-mini" onClick={() => { setEditingId(e.id); setEditDraft(e.content); }}>Edit</button>
              <button type="button" className="btn-mini" onClick={() => forgetEntry(e.id)}>Forget</button>
            </span>
          </div>
          {editingId === e.id ? (
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input value={editDraft} onChange={(ev) => setEditDraft(ev.target.value)} style={{ flex: 1 }} />
              <button type="button" className="btn-mini primary" onClick={() => saveEdit(e.id)}>Save</button>
              <button type="button" className="btn-mini" onClick={() => setEditingId(null)}>Cancel</button>
            </div>
          ) : (
            <div style={{ marginTop: 4 }}>{e.content}</div>
          )}
          {e.quote && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4, fontStyle: 'italic' }}>
              Quote: &ldquo;{e.quote}&rdquo;
            </div>
          )}
        </div>
      ))}

      {activeCurated.length === 0 && memory.length === 0 && (
        <p className="muted">Memory is empty. Click &ldquo;Curate Now&rdquo; to extract quote-verified facts from your messages, or add a note manually.</p>
      )}
      {memory.map((e, i) => (
        <div key={'legacy-' + i} className="memitem">
          <div className="mem-ts">{new Date(e.ts).toLocaleString()}{e.category ? ` · ${e.category}` : ' · manual'}</div>
          <div>{e.content}</div>
        </div>
      ))}
    </div>
  );
}

export function ProjectsView({ projects, setProjects, activeProject, setActiveProject }) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');

  const createProject = () => {
    const n = name.trim();
    if (!n) return;
    setProjects((ps) => [...ps, { id: makeUid(), name: n, instructions: instructions.trim(), ts: Date.now() }]);
    setName(''); setInstructions('');
  };
  const deleteProject = (id) => {
    setProjects((ps) => ps.filter((p) => p.id !== id));
    if (activeProject === id) setActiveProject(null);
  };
  const toggleProject = (id) => setActiveProject((cur) => (cur === id ? null : id));
  const updateInstructions = (id, val) => setProjects((ps) => ps.map((p) => (p.id === id ? { ...p, instructions: val } : p)));

  return (
    <div className="panel">
      <h2>Projects</h2>
      <p className="muted">Projects bundle custom instructions that are automatically injected into every message while a project is active (toggle a project to activate it).</p>
      <div className="project-new">
        <input placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea placeholder="Custom instructions (injected into the system prompt)…" rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        <button onClick={createProject} disabled={!name.trim()}>Create project</button>
      </div>
      {projects.map((p) => (
        <div key={p.id} className={'projectitem' + (activeProject === p.id ? ' active' : '')}>
          <div className="projectitem-head">
            <button className="project-toggle" onClick={() => toggleProject(p.id)} title={activeProject === p.id ? 'Active — click to deactivate' : 'Click to activate'}>
              <Icon name={activeProject === p.id ? 'Check' : 'Folder'} size={15} /> {p.name}
            </button>
            <button className="icon-btn" onClick={() => deleteProject(p.id)}><Icon name="Trash" size={13} /></button>
          </div>
          <textarea rows={2} placeholder="Instructions…" value={p.instructions} onChange={(e) => updateInstructions(p.id, e.target.value)} />
        </div>
      ))}
    </div>
  );
}

export function McpView({ mcpServers, mcpForm, setMcpForm, connectMcp, disconnectMcp }) {
  const transport = mcpForm.transport || 'stdio';
  return (
    <div className="panel">
      <h2>MCP Servers</h2>
      <p className="muted">Connect external Model Context Protocol servers over stdio, SSE, or streamable-HTTP. Their tools become available to Akron Code automatically.</p>
      <div className="mcp-form">
        <select value={transport} onChange={(e) => setMcpForm({ ...mcpForm, transport: e.target.value })}>
          <option value="stdio">stdio</option>
          <option value="sse">sse</option>
          <option value="http">streamable-http</option>
        </select>
        {transport === 'stdio' ? (
          <>
            <input placeholder="command (e.g. npx -y @modelcontextprotocol/server-filesystem)" value={mcpForm.command} onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })} />
            <input placeholder="args (space-separated)" value={mcpForm.args} onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })} />
          </>
        ) : (
          <input placeholder="URL (e.g. https://host/mcp or /sse)" value={mcpForm.url} onChange={(e) => setMcpForm({ ...mcpForm, url: e.target.value })} />
        )}
        <button onClick={connectMcp}>Connect</button>
      </div>
      {mcpServers.map((s) => (
        <div key={s.serverId} className="mcpserver">
          <div className="mcpserver-head"><b>{s.name}</b><button onClick={() => disconnectMcp(s.serverId)}>Disconnect</button></div>
          <div className="tools">{s.tools.map((t) => <span key={t.name} className="toolchip" title={t.description}>{t.name}</span>)}</div>
        </div>
      ))}
    </div>
  );
}

export function NotebooksView({ notebooks, activeNotebook, notebookCells, setNotebookCells, openNotebook, newNotebook, saveActiveNotebook, deleteActiveNotebook }) {
  return (
    <div className="panel">
      <div className="panel-head"><h2>Notebooks</h2>
        <div><button onClick={newNotebook}>+ New</button> <button onClick={saveActiveNotebook} disabled={!activeNotebook}>Save</button> <button onClick={deleteActiveNotebook} disabled={!activeNotebook}>Delete</button></div>
      </div>
      <div className="notebook-layout">
        <div className="notebook-list">
          {notebooks.length === 0 && <p className="muted">No notebooks yet.</p>}
          {notebooks.map((n) => (
            <button key={n} className={'notebook-item ' + (n === activeNotebook ? 'on' : '')} onClick={() => openNotebook(n)}>{n}</button>
          ))}
        </div>
        <div className="notebook-editor">
          {!activeNotebook && <p className="muted">Select or create a notebook to edit cells.</p>}
          {activeNotebook && (
            <>
              <h3>{activeNotebook}</h3>
              {notebookCells.map((c, i) => (
                <div key={i} className="nbcell">
                  <div className="nbcell-head">
                    <input className="nblang" value={c.language || ''} placeholder="language (e.g. js, py, md)" onChange={(e) => setNotebookCells((cs) => cs.map((x, j) => (j === i ? { ...x, language: e.target.value } : x)))} />
                  </div>
                  <textarea className="nbsrc" value={c.source || ''} placeholder="cell source…" onChange={(e) => setNotebookCells((cs) => cs.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)))} />
                </div>
              ))}
              <button className="nbadd" onClick={() => setNotebookCells((cs) => [...cs, { language: 'md', source: '' }])}>+ Add cell</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
