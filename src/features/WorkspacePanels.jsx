import React, { useState } from 'react';
import { Icon } from '../components/Icon.jsx';

const makeUid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

export function MemoryView({ memory, addMemory, clearMemory }) {
  return (
    <div className="panel">
      <div className="panel-head"><h2>Long-term memory</h2>
        <div><button onClick={addMemory}>+ Add</button> <button onClick={clearMemory}>Clear</button></div>
      </div>
      {memory.length === 0 && <p className="muted">Memory is empty. Use the &quot;memory_add&quot; tool in chat, or add a note here.</p>}
      {memory.map((e, i) => (
        <div key={i} className="memitem">
          <div className="mem-ts">{new Date(e.ts).toLocaleString()}{e.category ? ` · ${e.category}` : ''}</div>
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
