import React, { useState, useEffect, useCallback } from 'react';
import { Icon } from '../Icon.jsx';
import {
  contextWindowFor,
  usedTokens,
  formatContextPct,
  estimateConvBaselineTokens,
  loadJSON,
  fmtInt,
  copyTextToClipboard,
} from '../../utils/appHelpers.jsx';

export function ContextMeter({ used, win, size = 44 }) {
  const rawPct = win > 0 && used > 0 ? Math.max(0, Math.min(100, (used / win) * 100)) : 0;
  const arcPct = rawPct > 0 ? Math.max(rawPct, 2.5) : 0;
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const dash = (arcPct / 100) * c;
  const tone = rawPct >= 90 ? 'hot' : rawPct >= 70 ? 'warm' : 'cool';
  return (
    <span className={'ctx-meter ' + tone} title={fmtInt(used) + ' of ' + fmtInt(win) + ' tokens used'}>
      <svg width={size} height={size} viewBox={'0 0 ' + size + ' ' + size}>
        <circle className="ctx-track" cx={size / 2} cy={size / 2} r={r} strokeWidth="3" fill="none" />
        <circle
          className="ctx-arc" cx={size / 2} cy={size / 2} r={r} strokeWidth="3" fill="none"
          strokeDasharray={dash + ' ' + c} strokeDashoffset="0"
          transform={'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')'}
        />
      </svg>
      <span className="ctx-pct">{formatContextPct(used, win)}</span>
    </span>
  );
}

export function EnvPanel({
  cwd,
  setCwd,
  provider,
  lastUsage,
  mcpServers,
  features,
  saveFeat,
  runSlashCommand,
  onOpenConnectors,
  envState,
  refreshEnvState,
  onSwitchEnvironment,
  onOpenEnvironments,
  activeConv,
  skills,
  swarmEnabled,
  permissions,
  setNotice,
}) {
  const activeModel = (lastUsage && lastUsage.model) || (provider && provider.model) || '';
  const win = contextWindowFor(activeModel);
  const used = usedTokens(lastUsage);
  const rawPct = win > 0 && used > 0 ? (used / win) * 100 : 0;
  const pctNum = win > 0 ? Math.min(100, Math.round(rawPct)) : 0;
  const pctLabel = formatContextPct(used, win);

  const [compacting, setCompacting] = useState(false);
  const [loadedOpen, setLoadedOpen] = useState(false);
  const [loadedBusy, setLoadedBusy] = useState(false);
  const [loadedInfo, setLoadedInfo] = useState(null);
  const [hostBusy, setHostBusy] = useState(false);
  const [hostToken, setHostToken] = useState('');
  const [relayInfo, setRelayInfo] = useState(null);
  const [reaInfo, setReaInfo] = useState(null);
  const [extBridge, setExtBridge] = useState(null);
  const [envPickOpen, setEnvPickOpen] = useState(false);

  const refreshBuiltins = useCallback(async () => {
    try {
      if (window.autobot && window.autobot.reaStatus) {
        const rs = await window.autobot.reaStatus();
        if (rs && typeof rs === 'object') setReaInfo(rs);
      }
    } catch (_) {}
    try {
      if (window.autobot && window.autobot.extBridgeStatus) {
        const eb = await window.autobot.extBridgeStatus();
        if (eb && typeof eb === 'object') setExtBridge(eb);
      }
    } catch (_) {}
    try {
      if (window.autobot && window.autobot.remoteRelayStatus) {
        const rr = await window.autobot.remoteRelayStatus();
        if (rr && typeof rr === 'object') setRelayInfo(rr);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    refreshBuiltins();
  }, [refreshBuiltins, cwd]);

  const activeEnv = (envState && envState.active) || { kind: 'local', id: null, label: 'This Computer' };
  const hostServer = (envState && envState.hostServer) || {};
  const remoteOn = Boolean(hostServer.running || (features && (features.remoteControl || features.remoteServerEnabled)));
  const sshAll = [
    ...((envState && envState.sshProfiles) || []),
    ...((envState && envState.sshConfigHosts) || []),
  ];
  const remoteProfiles = (envState && envState.remoteProfiles) || [];
  const connected = Array.isArray(mcpServers) ? mcpServers : [];

  const builtinConnectors = [
    {
      serverId: 'builtin:rea',
      name: 'rea (Reverse Engineering)',
      active: Boolean(!reaInfo || reaInfo.connected || reaInfo.available),
      count: (reaInfo && Number(reaInfo.toolCount)) || 263,
      meta: `${(reaInfo && Number(reaInfo.toolCount)) || 263} tools`,
    },
    {
      serverId: 'builtin:computer-use',
      name: 'Computer Use 2.0',
      active: Boolean(!features || features.computerUse !== false),
      count: 24,
      meta: features && features.computerUse === false ? 'Off' : '24 tools',
    },
    {
      serverId: 'builtin:chrome-ext',
      name: 'Akron Browser Bot (:8766)',
      active: Boolean(extBridge && extBridge.extensionConnected),
      count: Number((extBridge && extBridge.openTabCount) || 0),
      meta: extBridge && extBridge.extensionConnected
        ? `${extBridge.openTabCount || 0} tabs`
        : (extBridge && extBridge.running ? 'Standby' : 'Off'),
    },
  ];
  const allConnectors = [
    ...connected.map((s) => ({
      serverId: s.serverId || s.name,
      name: s.name || s.serverId,
      active: Boolean(s.tools && s.tools.length > 0),
      count: (s.tools && s.tools.length) || 0,
      meta: `${(s.tools && s.tools.length) || 0} tools`,
      url: s.url || s.name,
    })),
    ...builtinConnectors.filter((b) => !connected.some((c) => String(c.name || c.serverId || '').toLowerCase() === 'rea' && b.serverId === 'builtin:rea')),
  ];
  const activeCount = allConnectors.filter((c) => c.active).length;

  const folderName = String(cwd || '').replace(/\/+$/, '').split('/').filter(Boolean).pop() || '~';

  const chooseFolder = async () => {
    const d = await window.autobot.pickFolder();
    if (!d) return;
    setCwd(d);
    try {
      const id = loadJSON('autobot:activeId', null);
      if (id) window.autobot.setWorkspace(id, d).catch(() => {});
    } catch (_) {}
  };

  const handleToggleRemote = async () => {
    if (hostBusy) return;
    setHostBusy(true);
    try {
      const want = !remoteOn;
      if (window.autobot && window.autobot.envToggleHostServer) {
        const res = await window.autobot.envToggleHostServer(want, { workspaceRoot: cwd || undefined });
        if (res && res.token) setHostToken(res.token);
        if (saveFeat) saveFeat({ ...features, remoteControl: !!(res && res.running), remoteServerEnabled: !!(res && res.running) });
        if (refreshEnvState) await refreshEnvState();
        setNotice && setNotice(res && res.running ? `Remote Control listening at ${res.url}` : 'Remote Control turned off');
      } else if (saveFeat) {
        saveFeat({ ...features, remoteControl: want, remoteServerEnabled: want });
      }
      await refreshBuiltins();
    } catch (err) {
      setNotice && setNotice(`Remote Control error: ${err?.message || err}`);
    } finally {
      setHostBusy(false);
    }
  };

  const handleCopyToken = async () => {
    try {
      const tok = hostToken || (window.autobot && window.autobot.envGetHostToken ? await window.autobot.envGetHostToken() : '');
      if (tok) {
        copyTextToClipboard(tok);
        setHostToken(tok);
        setNotice && setNotice('Remote pairing Bearer token copied');
      } else {
        setNotice && setNotice('No pairing token active yet — turn Remote Control ON first');
      }
    } catch (_) {}
  };

  const handleKillSwitch = async () => {
    try {
      if (!window.autobot || !window.autobot.remoteKillSwitch) return;
      const nextActive = !(relayInfo && relayInfo.killSwitchActive);
      const res = await window.autobot.remoteKillSwitch(nextActive);
      setRelayInfo((prev) => ({ ...(prev || {}), killSwitchActive: !!(res && res.active) }));
      if (refreshEnvState) await refreshEnvState();
      setNotice && setNotice(nextActive ? 'Remote Kill Switch activated (remote.OFF)' : 'Remote Kill Switch cleared');
    } catch (_) {}
  };

  const handleCompactNow = async () => {
    if (compacting || !runSlashCommand) return;
    setCompacting(true);
    try {
      await runSlashCommand('compact');
    } finally {
      setCompacting(false);
    }
  };

  const handleWhatIsLoaded = async () => {
    if (loadedOpen) {
      setLoadedOpen(false);
      return;
    }
    setLoadedOpen(true);
    setLoadedBusy(true);
    try {
      const [memRes, mcpCfg] = await Promise.all([
        window.autobot && window.autobot.getProjectMemory ? window.autobot.getProjectMemory(cwd).catch(() => null) : null,
        window.autobot && window.autobot.mcpConfig ? window.autobot.mcpConfig(cwd).catch(() => null) : null,
      ]);
      await refreshBuiltins();
      const msgs = (activeConv && Array.isArray(activeConv.messages)) ? activeConv.messages : [];
      const estTokens = estimateConvBaselineTokens(activeConv, provider);
      const enabledSkills = Array.isArray(skills) ? skills.filter((s) => s && s.enabled !== false).length : 0;
      const mcpList = (mcpCfg && Array.isArray(mcpCfg.status)) ? mcpCfg.status : connected;
      setLoadedInfo({
        messageCount: msgs.length,
        estTokens,
        memoryFiles: (memRes && Array.isArray(memRes.files)) ? memRes.files : [],
        memoryChars: (memRes && typeof memRes.text === 'string') ? memRes.text.length : 0,
        enabledSkills,
        mcpCount: mcpList.length,
        reaTools: (reaInfo && Number(reaInfo.toolCount)) || 263,
      });
    } finally {
      setLoadedBusy(false);
    }
  };

  const routingLabel = provider && provider.routingMode === 'auto'
    ? 'Auto · Smart Router'
    : (provider && provider.routingMode === 'orchestrator' ? 'Orchestrator' : 'Direct');
  const displayModel = activeModel ? String(activeModel).split('/').pop() : 'no model';
  const hostPort = hostServer.port || 9477;

  return (
    <div className="envpanel" data-testid="env-panel">
      <section className="env-sec">
        <div className="env-sec-title">Execution Environment</div>
        <div className="env-card">
          <span className="env-ico">
            <Icon name={activeEnv.kind === 'remote' ? 'Globe' : (activeEnv.kind === 'ssh' ? 'CommandLine' : 'Laptop')} size={16} />
          </span>
          <div className="env-card-main">
            <div className="env-card-title">{activeEnv.label || 'This Computer'}</div>
            <div className="env-card-sub" title={cwd || '~'}>{folderName}{cwd ? ' · ' + cwd : ''}</div>
          </div>
        </div>
        <div className="env-row">
          <button type="button" className="env-action" onClick={chooseFolder}>
            <Icon name="Folder" size={14} /> Choose folder…
          </button>
          <button type="button" className="env-action" onClick={() => setEnvPickOpen((v) => !v)}>
            <Icon name="Globe" size={14} /> {envPickOpen ? 'Hide hosts' : 'Switch host'}
          </button>
        </div>
        {envPickOpen && (
          <div className="env-loaded-card" data-testid="env-host-switcher">
            <div className="env-loaded-row">
              <span>Local</span>
              <button
                type="button"
                className="btn-mini"
                onClick={() => { onSwitchEnvironment && onSwitchEnvironment({ kind: 'local' }); setEnvPickOpen(false); }}
              >
                {activeEnv.kind === 'local' ? 'Active' : 'Use This Computer'}
              </button>
            </div>
            {sshAll.slice(0, 6).map((h) => (
              <div key={h.id} className="env-loaded-row">
                <span title={`${h.username || ''}@${h.host}:${h.port}`}>{h.name || h.host}</span>
                <button
                  type="button"
                  className="btn-mini"
                  onClick={() => { onSwitchEnvironment && onSwitchEnvironment({ kind: 'ssh', id: h.id, cwd: h.remoteCwd || '' }); setEnvPickOpen(false); }}
                >
                  {activeEnv.kind === 'ssh' && activeEnv.id === h.id ? 'Active' : 'Connect'}
                </button>
              </div>
            ))}
            {remoteProfiles.slice(0, 6).map((r) => (
              <div key={r.id} className="env-loaded-row">
                <span title={r.url}>{r.name}</span>
                <button
                  type="button"
                  className="btn-mini"
                  onClick={() => { onSwitchEnvironment && onSwitchEnvironment({ kind: 'remote', id: r.id, cwd: r.remoteCwd || '' }); setEnvPickOpen(false); }}
                >
                  {activeEnv.kind === 'remote' && activeEnv.id === r.id ? 'Active' : 'Connect'}
                </button>
              </div>
            ))}
            {onOpenEnvironments && (
              <button type="button" className="env-action" style={{ marginTop: 4 }} onClick={onOpenEnvironments}>
                <Icon name="Settings" size={13} /> Manage SSH &amp; Remote Hosts…
              </button>
            )}
          </div>
        )}
      </section>

      <section className="env-sec">
        <div className="env-sec-title">Remote Control</div>
        <button
          type="button"
          className={'env-toggle' + (remoteOn ? ' on' : '')}
          onClick={handleToggleRemote}
          disabled={hostBusy}
          aria-pressed={remoteOn}
          data-testid="env-remote-toggle"
        >
          <span className="env-toggle-track"><span className="env-toggle-knob" /></span>
          <span className="env-toggle-label">
            {hostBusy
              ? 'Updating remote server…'
              : (remoteOn
                ? `On — listening on 127.0.0.1:${hostPort}`
                : 'Off — local control only')}
          </span>
        </button>
        {remoteOn && (
          <div className="env-loaded-card" data-testid="env-remote-details">
            <div className="env-loaded-row">
              <span>Endpoint</span>
              <code>{`http://127.0.0.1:${hostPort}`}</code>
            </div>
            <div className="env-row" style={{ marginTop: 4 }}>
              <button type="button" className="env-action" onClick={handleCopyToken} data-testid="env-copy-token">
                <Icon name="Copy" size={13} /> Copy Token
              </button>
              <button type="button" className="env-action" onClick={handleKillSwitch}>
                <Icon name="LockShield" size={13} /> {relayInfo && relayInfo.killSwitchActive ? 'Resume' : 'Kill Switch'}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="env-sec">
        <div className="env-sec-title">Context</div>
        <div className="env-card">
          <ContextMeter used={used} win={win} size={46} />
          <div className="env-card-main">
            <div className="env-card-title" data-testid="env-ctx-title">{pctLabel} used</div>
            <div className="env-card-sub" data-testid="env-ctx-sub">
              {lastUsage && lastUsage.estimated ? '~' : ''}{fmtInt(used)} / {fmtInt(win)} tokens · {displayModel}
            </div>
          </div>
        </div>
        <div className="env-meter">
          <span
            className={'env-meter-fill' + (pctNum >= 90 ? ' hot' : pctNum >= 70 ? ' warm' : '')}
            style={{ width: (used > 0 ? Math.max(2, Math.min(100, rawPct)) : 0) + '%' }}
          />
        </div>
        <div className="env-row">
          <button type="button" className="env-action" onClick={handleCompactNow} disabled={compacting} data-testid="env-compact-btn">
            <Icon name={compacting ? 'Spinner' : 'Frame'} size={14} className={compacting ? 'spin' : ''} /> {compacting ? 'Compacting…' : 'Compact now'}
          </button>
          <button type="button" className="env-action" onClick={handleWhatIsLoaded} data-testid="env-loaded-btn">
            <Icon name="Activity" size={14} /> {loadedOpen ? 'Hide loaded' : 'What is loaded'}
          </button>
        </div>
        {loadedOpen && (
          <div className="env-loaded-card" data-testid="env-loaded-card">
            {loadedBusy || !loadedInfo ? (
              <div className="env-card-sub">Inspecting workspace context…</div>
            ) : (
              <>
                <div className="env-loaded-row"><span>Conversation</span><span>{loadedInfo.messageCount} msgs (~{fmtInt(loadedInfo.estTokens)} tok)</span></div>
                <div className="env-loaded-row"><span>Project Memory</span><span>{loadedInfo.memoryFiles.length} file(s) · {fmtInt(loadedInfo.memoryChars)} chars</span></div>
                <div className="env-loaded-row"><span>Skills Active</span><span>{loadedInfo.enabledSkills} enabled</span></div>
                <div className="env-loaded-row"><span>Tool Surface</span><span>184 native + {loadedInfo.reaTools} REA</span></div>
                <div className="env-loaded-row"><span>MCP Bridges</span><span>{loadedInfo.mcpCount} server(s)</span></div>
              </>
            )}
          </div>
        )}
      </section>

      <section className="env-sec">
        <div className="env-sec-title">Connectors</div>
        <div className="env-card-sub env-summary" data-testid="env-conn-summary">
          {activeCount} active · {allConnectors.length} total connectors
        </div>
        {allConnectors.map((s) => (
          <div key={s.serverId} className={'env-conn' + (s.active ? '' : ' idle')}>
            <span className="env-conn-dot" />
            <span className="env-conn-name" title={s.url || s.name}>{s.name}</span>
            <span className="env-conn-meta">{s.meta}</span>
          </div>
        ))}
        <button type="button" className="env-action" onClick={onOpenConnectors}>
          <Icon name="Connectors" size={14} /> Manage connectors
        </button>
      </section>

      <section className="env-sec env-sec-last">
        <div className="env-sec-title">Session</div>
        <div className="env-card-sub env-summary">
          {routingLabel} · {displayModel} · Swarm {swarmEnabled ? 'ON' : 'OFF'} · {permissions || 'auto'}
        </div>
      </section>
    </div>
  );
}
export default EnvPanel;
