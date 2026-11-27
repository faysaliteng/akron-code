import React, { useState, useEffect, useCallback } from 'react';

export function ParadevIntegrationCard({ setNotice }) {
  const [status, setStatus] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [orgId, setOrgId] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.paradev.com');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [workspaces, setWorkspaces] = useState(null);
  const [tasks, setTasks] = useState(null);
  const api = (typeof window !== 'undefined' && window.autobot) || {};

  const refreshStatus = useCallback(async (probeNetwork = false) => {
    if (!api.paradevStatus) return null;
    try {
      const r = await api.paradevStatus({ probeNetwork });
      if (r && r.ok) {
        setStatus(r);
        if (r.organizationId) setOrgId(r.organizationId);
        if (r.baseURL) setBaseUrl(r.baseURL);
      }
      return r;
    } catch (_) {
      return null;
    }
  }, [api]);

  useEffect(() => { refreshStatus(false); }, [refreshStatus]);

  const saveAndTest = async () => {
    if (!api.paradevSaveConfig) return;
    setBusy('save');
    setMsg('');
    try {
      const saved = await api.paradevSaveConfig({
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        organizationId: orgId.trim(),
        baseURL: baseUrl.trim() || 'https://api.paradev.com',
      });
      if (apiKey.trim()) setApiKey('');
      const st = await refreshStatus(true);
      if (st && st.network && st.network.reachable) {
        const plan = (st.network.plan && (st.network.plan.planTier || st.network.plan.plan)) || 'connected';
        const line = `✅ Connected to Paradev (${plan}, ${st.network.modelsCount || 0} catalog models)`;
        setMsg(line);
        setNotice && setNotice(line);
      } else if (saved && saved.configured) {
        setMsg((st && st.network && st.network.error) ? `Saved key — probe warning: ${st.network.error}` : 'Saved Paradev credentials.');
      } else {
        setMsg('Cleared Paradev API key.');
      }
    } finally {
      setBusy('');
    }
  };

  const addParadevMcp = async () => {
    if (!api.paradevAddMcp) return;
    setBusy('mcp');
    try {
      const r = await api.paradevAddMcp();
      if (r && r.ok) {
        const line = `✅ Added ${r.added?.length || 1} Paradev MCP server(s)`;
        setMsg(line);
        setNotice && setNotice(line);
      } else {
        setMsg(`❌ ${(r && r.error) || 'Failed to register Paradev MCP'}`);
      }
    } finally {
      setBusy('');
    }
  };

  const fetchPreview = async () => {
    if (!api.paradevWorkspaces || !api.paradevTasks) return;
    setBusy('fetch');
    try {
      const [wsRes, tRes] = await Promise.all([api.paradevWorkspaces({}), api.paradevTasks({})]);
      if (wsRes && wsRes.ok) setWorkspaces(Array.isArray(wsRes.data) ? wsRes.data : []);
      if (tRes && tRes.ok) setTasks(Array.isArray(tRes.data) ? tRes.data : []);
      if (!(wsRes && wsRes.ok) && !(tRes && tRes.ok)) {
        setMsg((wsRes && wsRes.error) || (tRes && tRes.error) || 'Could not load Paradev workspaces/tasks');
      }
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="settings-card" data-testid="paradev-integration-card">
      <h3>Paradev Subscription Bridge (Raw API, Cloud Sandboxes &amp; Voice)</h3>
      <p className="muted" style={{ marginTop: -4 }}>
        Connects your Paradev / Superset subscription via Personal API Key (<code>sk_live_…</code>) for server-backed Whisper dictation (<code>voice.transcribe</code>), cloud sandboxes (<code>cloudWorkspace</code>), task sync (<code>task</code>), and MCP servers.
      </p>

      <div className="env-prof-row" style={{ marginBottom: 10 }}>
        <div className="env-prof-meta">
          <span className="env-prof-title">
            {status && status.configured
              ? `API Key Connected (${status.keyPreview || status.source})`
              : 'Not connected — add Personal API Key'}
          </span>
          <span className="env-prof-sub">
            {status && status.appInstalled ? 'Paradev.app detected' : 'Desktop optional'}
            {status && status.desktopSessionPresent ? ' · Signed-in desktop session on Mac' : ''}
            {' · '}Worktree hooks: <code>.superset/config.json</code> supported natively
          </span>
        </div>
        <span className={'mc-pill ' + (status && status.configured ? 'done' : 'idle')}>
          {status && status.configured ? 'Ready' : 'Setup'}
        </span>
      </div>

      <div className="row">
        <label>
          Paradev API Key (<code>sk_live_…</code>)
          <input
            type="password"
            value={apiKey}
            placeholder={status && status.configured ? `Saved (${status.keyPreview}) — leave blank to keep` : 'sk_live_… (from Paradev API Keys)'}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label>
          Organization ID (optional)
          <input
            value={orgId}
            placeholder="org UUID for cloud workspaces"
            onChange={(e) => setOrgId(e.target.value)}
          />
        </label>
      </div>

      <label>
        API Base URL
        <input
          value={baseUrl}
          placeholder="https://api.paradev.com"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>

      <div className="env-prof-actions" style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn-mini primary" disabled={!!busy} onClick={saveAndTest}>
          {busy === 'save' ? 'Saving & Testing…' : 'Save & Test Paradev API'}
        </button>
        <button type="button" className="btn-mini" disabled={!!busy} onClick={addParadevMcp}>
          {busy === 'mcp' ? 'Registering…' : 'Add Paradev MCP Servers'}
        </button>
        {status && status.configured && (
          <button type="button" className="btn-mini" disabled={!!busy} onClick={fetchPreview}>
            {busy === 'fetch' ? 'Loading…' : 'Load Cloud Workspaces & Tasks'}
          </button>
        )}
      </div>

      {msg && <p className="muted" style={{ marginTop: 8 }}>{msg}</p>}

      {(Array.isArray(workspaces) || Array.isArray(tasks)) && (
        <div className="ct-list" style={{ marginTop: 10 }}>
          {Array.isArray(workspaces) && (
            <div className="ct-row">
              <span>Cloud Workspaces</span>
              <span>{workspaces.length} active</span>
            </div>
          )}
          {Array.isArray(tasks) && (
            <div className="ct-row">
              <span>Organization Tasks</span>
              <span>{tasks.length} synced</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
