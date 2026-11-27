import React, { useState, useEffect, useMemo, useCallback } from 'react';
import ConnectorLogo from '../../ConnectorLogo.jsx';
import { Icon } from '../Icon.jsx';

const SHELVES = [
  {
    id: 'google-workspace',
    title: 'Google Workspace',
    subtitle: 'Connect Google Docs, Sheets, Slides, Drive, Calendar & Gmail directly into your agent workflows.',
    ids: ['gdocs', 'gsheets', 'gslides', 'gdrive', 'gcal', 'gmail'],
  },
  {
    id: 'dev-cloud',
    title: 'Developer & Cloud',
    subtitle: 'Repositories, containers, databases, cloud hosting, deployments, and issue tracking.',
    ids: ['github', 'firebase', 'cloudflare', 'netlify', 'docker', 'supabase', 'linear', 'jira'],
  },
  {
    id: 'design-media',
    title: 'Design, Media & Research',
    subtitle: 'Design systems, generative image/video pipelines, knowledge bases, and team messaging.',
    ids: ['figma', 'canva', 'replicate', 'huggingface', 'notion', 'slack'],
  },
  {
    id: 'security-data',
    title: 'Security & Reverse Engineering',
    subtitle: 'Deep binary/Electron/APK inspection, telemetry, and production databases.',
    ids: ['rea', 'sentry', 'datadog', 'postgres'],
  },
];

const AGENT_PRESETS = [
  {
    label: 'Security Reviewer',
    name: 'security-auditor',
    role: 'Security Auditor',
    description: 'Audits diffs, auth flows, IPC handlers, secrets hygiene, and ASAR/dependency exposure.',
    model: 'planner',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'CodebaseSearch'],
    body: 'You are a rigorous application security auditor. Inspect authentication boundaries, input validation, path traversal guards, secret storage, and supply-chain risks. Never mutate production files; report prioritized findings with exact file:line evidence.',
  },
  {
    label: 'UI/UX Designer',
    name: 'ui-ux-designer',
    role: 'UI/UX Designer',
    description: 'Designs responsive dark/light Emerald Carbon interfaces, CSS layouts, and visual hierarchy.',
    model: 'coder',
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Browser', 'GenerateImage'],
    body: 'You are a principal product designer and frontend engineer. Craft accessible, responsive components matching Akron Code Emerald Carbon tokens across dark and light themes.',
  },
  {
    label: 'Test Engineer',
    name: 'test-engineer',
    role: 'Test Engineer',
    description: 'Writes deterministic unit/E2E tests and runs verification suites to green.',
    model: 'coder',
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
    body: 'You are a staff test engineer. Reproduce bugs with minimal failing tests, verify edge cases without mocking core logic, and ensure every test passes cleanly.',
  },
  {
    label: 'Database Architect',
    name: 'database-architect',
    role: 'Database Architect',
    description: 'Designs SQLite/Postgres schemas, FTS5 indexes, safe migrations, and query plans.',
    model: 'planner',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
    body: 'You are a database systems architect. Design WAL-safe schemas, normalized indexes, migration paths, and transaction boundaries with zero data-loss risk.',
  },
  {
    label: 'Media Director',
    name: 'media-director',
    role: 'Media & Docs Producer',
    description: 'Produces brand images, motion videos, pitch decks, spreadsheets, and LaTeX PDFs.',
    model: 'image_gen',
    tools: ['Read', 'GenerateImage', 'EditImage', 'GenerateVideo', 'EditVideo', 'ReadDocument', 'GenerateDocument'],
    body: 'You are a creative media and technical document producer. Generate high-contrast visuals, motion reels, structured PDFs, XLSX models with formulas, and PPTX decks inside the workspace.',
  },
];

const AGENT_TOOL_CHOICES = [
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash',
  'Browser', 'CodebaseSearch', 'GenerateImage', 'EditImage',
  'GenerateVideo', 'EditVideo', 'ReadDocument', 'GenerateDocument', 'MCP',
];

const AGENT_TOOL_GROUPS = [
  { label: 'All tools', tools: [] },
  { label: 'Read-only research', tools: ['Read', 'Glob', 'Grep', 'CodebaseSearch', 'ReadDocument'] },
  { label: 'Code & Terminal', tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] },
  { label: 'Browser', tools: ['Read', 'Browser', 'GenerateImage'] },
  { label: 'Media & Docs Studio', tools: ['Read', 'GenerateImage', 'EditImage', 'GenerateVideo', 'EditVideo', 'ReadDocument', 'GenerateDocument'] },
];

const OUTPUT_STYLE_PRESETS = [
  {
    label: 'Executive Brief',
    name: 'Executive Brief',
    hint: 'TL;DR first + bulleted impact',
    directive: 'Lead with a crisp 2-sentence TL;DR executive summary, followed by bulleted Key Outcomes, Risks/Trade-offs, and Next Actions. Keep total length scannable.',
  },
  {
    label: 'Strict JSON',
    name: 'Strict JSON',
    hint: 'Machine-readable JSON only',
    directive: 'Respond strictly with valid, well-structured JSON matching the user schema or logical fields. Do not wrap in prose before or after the JSON payload.',
  },
  {
    label: 'PR Changelog',
    name: 'PR Changelog',
    hint: 'Summary, files & verification',
    directive: 'Format responses like a pull request description: ### Summary, ### Changes by File, ### Verification Commands & Results, and ### Risks/Notes.',
  },
  {
    label: 'Step-by-Step Tutorial',
    name: 'Step-by-Step Tutorial',
    hint: 'Numbered walkthrough',
    directive: 'Present solutions as a numbered step-by-step walkthrough where every step includes the exact file/command and why it matters.',
  },
  {
    label: 'Table Summary',
    name: 'Table Summary',
    hint: 'Structured Markdown tables',
    directive: 'Summarize comparisons, audits, architectures, and status checks primarily in clean Markdown tables with short takeaways beneath.',
  },
];

const SCOPE_BADGE = (src) => {
  if (src === 'workspace' || src === 'project') return { label: 'Workspace', cls: 'ws' };
  if (src === 'global' || src === 'autobot' || src === 'user' || src === 'claude') return { label: 'Global', cls: 'gl' };
  return { label: 'Built In', cls: 'bi' };
};

export function CustomizationsHub({
  cwd = '',
  skills = [],
  toggleSkill,
  refreshSkills,
  mcpServers = [],
  mcpForm = { transport: 'stdio', command: '', args: '', url: '' },
  setMcpForm,
  connectMcp,
  disconnectMcp,
  styleId = 'default',
  setStyleId,
  agentDefs = [],
  outputStyles = [],
  defaultStyleId = 'default',
  onRefreshCustomizations,
  onOpenGdrive,
  setNotice,
  setError,
  initialTab = 'marketplace',
}) {
  const [tab, setTab] = useState(initialTab === 'installed' ? 'installed' : 'marketplace');
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState([]);
  const [busyId, setBusyId] = useState('');
  const [detailEntry, setDetailEntry] = useState(null);
  const [cfgKey, setCfgKey] = useState('');
  const [reaInfo, setReaInfo] = useState(null);
  const [localAgents, setLocalAgents] = useState([]);
  const [localStyles, setLocalStyles] = useState([]);
  const [localDefaultStyle, setLocalDefaultStyle] = useState(defaultStyleId || 'default');

  // Collapsible sections inside Installed tab
  const [openSec, setOpenSec] = useState({
    skills: true,
    agents: true,
    outputs: true,
    mcp: true,
  });
  const toggleSec = (k) => setOpenSec((s) => ({ ...s, [k]: !s[k] }));

  // Skill creator
  const [skillModal, setSkillModal] = useState(false);
  const [skillDraft, setSkillDraft] = useState({ name: '', content: '' });

  // Custom Agent Editor
  const [agentEditor, setAgentEditor] = useState(null); // null | { ... }

  // Custom Output Style Editor
  const [styleEditor, setStyleEditor] = useState(null); // null | { ... }

  // MCP Add Server drawer & expanded tool lists
  const [mcpEditorOpen, setMcpEditorOpen] = useState(false);
  const [expandedMcp, setExpandedMcp] = useState({});

  const reloadAll = useCallback(async () => {
    try {
      if (window.autobot && window.autobot.listPlugins) {
        const list = await window.autobot.listPlugins({});
        if (Array.isArray(list)) setCatalog(list);
      }
    } catch (_) {}
    try {
      if (window.autobot && window.autobot.reaStatus) {
        const rs = await window.autobot.reaStatus();
        if (rs) setReaInfo(rs);
      }
    } catch (_) {}
    try {
      if (window.autobot && window.autobot.listAgentDefs) {
        const ag = await window.autobot.listAgentDefs(cwd);
        if (Array.isArray(ag)) setLocalAgents(ag);
      }
    } catch (_) {}
    try {
      if (window.autobot && window.autobot.listOutputStyles) {
        const osRes = await window.autobot.listOutputStyles(cwd);
        if (osRes && Array.isArray(osRes.styles)) {
          setLocalStyles(osRes.styles);
          if (osRes.defaultStyleId) setLocalDefaultStyle(osRes.defaultStyleId);
        }
      }
    } catch (_) {}
    if (refreshSkills) {
      try { await refreshSkills(); } catch (_) {}
    }
    if (onRefreshCustomizations) {
      try { await onRefreshCustomizations(); } catch (_) {}
    }
  }, [cwd, refreshSkills, onRefreshCustomizations]);

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);

  const effectiveAgents = localAgents.length ? localAgents : agentDefs;
  const effectiveStyles = localStyles.length ? localStyles : outputStyles;

  const catalogById = useMemo(() => {
    const map = new Map();
    for (const item of catalog) map.set(item.id, item);
    return map;
  }, [catalog]);

  const heroEntry = useMemo(() => {
    return catalogById.get('rea') || catalogById.get('gdocs') || catalog[0] || {
      id: 'rea',
      name: 'REA (Reverse Engineer Anything)',
      description: 'Built-in 263-tool MCP suite for binaries, APKs, Electron apps, bundles, firmware, and captures.',
      installed: false,
    };
  }, [catalogById, catalog]);

  const qLower = query.trim().toLowerCase();

  const togglePlugin = async (item) => {
    if (!item || !window.autobot) return;
    setBusyId(item.id);
    try {
      if (item.installed) {
        await window.autobot.uninstallPlugin(item.id);
        setNotice && setNotice(`Removed ${item.name}`);
      } else {
        const r = await window.autobot.installPlugin(item.id);
        if (r && r.needsSetup === 'gdrive') {
          setNotice && setNotice(`${item.name} added — connect Google Drive folder or account.`);
          onOpenGdrive && onOpenGdrive();
        } else if (r && r.needsAuth) {
          setNotice && setNotice(`${item.name} added — open Details to add credentials or sign in.`);
        } else if (r && r.connectError) {
          setNotice && setNotice(`${item.name} added (${r.connectError}).`);
        } else {
          setNotice && setNotice(`Added ${item.name}`);
        }
      }
      await reloadAll();
    } catch (e) {
      setError && setError((e && e.message) || 'Failed to update customization');
    } finally {
      setBusyId('');
    }
  };

  const savePluginConfig = async (id) => {
    if (!window.autobot || !window.autobot.configurePlugin) return;
    setBusyId('cfg:' + id);
    try {
      const r = await window.autobot.configurePlugin(id, { apiKey: cfgKey });
      if (r && r.ok === false) {
        setError && setError(r.error || 'Configuration failed');
      } else {
        setNotice && setNotice('Saved plugin configuration');
        setCfgKey('');
        await reloadAll();
      }
    } finally {
      setBusyId('');
    }
  };

  // Filtered Installed datasets
  const filteredSkills = useMemo(() => {
    return (skills || []).filter((s) => !qLower || `${s.name} ${s.description}`.toLowerCase().includes(qLower));
  }, [skills, qLower]);

  const filteredAgents = useMemo(() => {
    return (effectiveAgents || []).filter((a) => !qLower || `${a.name} ${a.role || ''} ${a.description || ''}`.toLowerCase().includes(qLower));
  }, [effectiveAgents, qLower]);
  const customAgentCount = useMemo(
    () => (effectiveAgents || []).filter((a) => a.custom || (a.source && a.source !== 'builtin')).length,
    [effectiveAgents]
  );

  const filteredStyles = useMemo(() => {
    return (effectiveStyles || []).filter((s) => !qLower || `${s.name} ${s.hint || ''} ${s.description || ''}`.toLowerCase().includes(qLower));
  }, [effectiveStyles, qLower]);

  // Build combined MCP rows: ensure built-in REA is visible at the top with its 263-tool count
  const mcpRows = useMemo(() => {
    const rows = Array.isArray(mcpServers) ? [...mcpServers] : [];
    const hasRea = rows.some((s) => String(s.serverId || s.name || '').toLowerCase() === 'rea');
    const reaToolCount = (reaInfo && (reaInfo.toolCount || (Array.isArray(reaInfo.tools) && reaInfo.tools.length))) || 263;
    const merged = hasRea ? rows : [{
      serverId: 'rea',
      name: 'rea',
      builtin: true,
      connected: reaInfo ? !!reaInfo.connected : true,
      toolCount: reaToolCount,
      tools: (reaInfo && Array.isArray(reaInfo.tools) && reaInfo.tools.length)
        ? reaInfo.tools
        : ['open_binary', 'inspect_artifact', 'binary_overview', 'procedure_pseudo_code', 'analyze_javascript_application', 'audit_release_exposure'],
    }, ...rows];
    return merged.filter((m) => !qLower || `${m.name || ''} ${m.serverId || ''}`.toLowerCase().includes(qLower));
  }, [mcpServers, reaInfo, qLower]);

  const extraSearchResults = useMemo(() => {
    if (!qLower) return [];
    const shelfIds = new Set(SHELVES.flatMap((sh) => sh.ids));
    return catalog
      .filter((item) => !shelfIds.has(item.id) && `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(qLower))
      .slice(0, 12);
  }, [catalog, qLower]);

  // Actions: Skills
  const handleUploadSkill = async () => {
    if (!window.autobot || !window.autobot.pickSkillFile) return;
    const picked = await window.autobot.pickSkillFile();
    if (!picked || picked.ok === false) return;
    const res = await window.autobot.addSkill(picked.name, picked.content);
    if (res && res.ok !== false) {
      setNotice && setNotice(`Installed skill /${picked.name}`);
      await reloadAll();
    } else {
      setError && setError((res && res.error) || 'Failed to add skill');
    }
  };

  const handleSaveSkill = async () => {
    if (!skillDraft.name.trim() || !skillDraft.content.trim()) return;
    const res = await window.autobot.addSkill(skillDraft.name.trim(), skillDraft.content);
    if (res && res.ok !== false) {
      setNotice && setNotice(`Created skill /${skillDraft.name.trim()}`);
      setSkillModal(false);
      setSkillDraft({ name: '', content: '' });
      await reloadAll();
    } else {
      setError && setError((res && res.error) || 'Failed to create skill');
    }
  };

  const handleDeleteSkill = async (name) => {
    const res = await window.autobot.deleteSkill(name);
    if (res && res.ok !== false) {
      setNotice && setNotice(`Removed skill /${name}`);
      await reloadAll();
    }
  };

  // Actions: Custom Agents
  const openNewAgent = (preset = null) => {
    if (preset) {
      setAgentEditor({
        name: preset.name,
        role: preset.role,
        description: preset.description,
        scope: 'autobot',
        model: preset.model || 'inherit',
        tools: [...(preset.tools || [])],
        body: preset.body || '',
      });
      return;
    }
    setAgentEditor({
      name: '',
      role: '',
      description: '',
      scope: 'autobot',
      model: 'inherit',
      tools: [],
      body: 'You are a specialized sub-agent running in Akron Code.\nComplete delegated tasks thoroughly and report concise file paths and results.',
    });
  };

  const handleSaveAgent = async () => {
    if (!agentEditor || !agentEditor.name.trim()) {
      setError && setError('Agent name is required.');
      return;
    }
    const r = await window.autobot.saveAgentDef({ ...agentEditor, cwd });
    if (r && r.ok) {
      setNotice && setNotice(`Saved custom agent @${r.agent?.name || agentEditor.name}`);
      setAgentEditor(null);
      await reloadAll();
    } else {
      setError && setError((r && r.error) || 'Could not save custom agent');
    }
  };

  const handleDeleteAgent = async (a) => {
    const r = await window.autobot.deleteAgentDef({ name: a.name, scope: a.scope, file: a.file, cwd });
    if (r && r.ok) {
      setNotice && setNotice(`Deleted custom agent @${a.name}`);
      await reloadAll();
    } else {
      setError && setError((r && r.error) || 'Could not delete agent');
    }
  };

  // Actions: Custom Output Styles
  const openNewOutputStyle = (preset = null) => {
    if (preset) {
      setStyleEditor({
        name: preset.name,
        hint: preset.hint,
        scope: 'autobot',
        directive: preset.directive,
        setDefault: false,
      });
      return;
    }
    setStyleEditor({
      name: '',
      hint: '',
      scope: 'autobot',
      directive: '',
      setDefault: false,
    });
  };

  const handleSaveOutputStyle = async () => {
    if (!styleEditor || !styleEditor.name.trim() || !styleEditor.directive.trim()) {
      setError && setError('Style name and formatting template are required.');
      return;
    }
    const r = await window.autobot.saveOutputStyle({ ...styleEditor, cwd });
    if (r && r.ok) {
      setNotice && setNotice(`Saved output style "${styleEditor.name}"`);
      if (styleEditor.setDefault && r.style && r.style.id && setStyleId) {
        setStyleId(r.style.id);
      }
      setStyleEditor(null);
      await reloadAll();
    } else {
      setError && setError((r && r.error) || 'Could not save output style');
    }
  };

  const handleDeleteOutputStyle = async (st) => {
    const r = await window.autobot.deleteOutputStyle({ id: st.id, file: st.file, cwd });
    if (r && r.ok) {
      setNotice && setNotice(`Deleted output style "${st.name}"`);
      if (styleId === st.id && setStyleId) setStyleId('default');
      await reloadAll();
    } else {
      setError && setError((r && r.error) || 'Could not delete output style');
    }
  };

  const renderShelfCard = (item) => {
    const isBusy = busyId === item.id;
    return (
      <div key={item.id} className={'cust-market-card' + (item.installed ? ' installed' : '')}>
        <div className="cust-card-main" onClick={() => setDetailEntry(item)}>
          <ConnectorLogo id={item.id} name={item.name} url={item.endpoint && item.endpoint.url} type={item.type} size={36} />
          <div className="cust-card-copy">
            <div className="cust-card-title-row">
              <span className="cust-card-title">{item.name}</span>
              {item.connected && <span className="cust-dot-ok" title="Connected" />}
            </div>
            <div className="cust-card-desc">{item.description}</div>
          </div>
        </div>
        <button
          type="button"
          className={'cust-add-btn' + (item.installed ? ' added' : '')}
          disabled={isBusy}
          title={item.installed ? `Installed (${item.name}) — click to remove` : `Add ${item.name}`}
          onClick={() => togglePlugin(item)}
        >
          {isBusy ? '…' : (item.installed ? '✓' : '+')}
        </button>
      </div>
    );
  };

  return (
    <div className="cust-hub" data-testid="customizations-hub">
      <div className="cust-hub-inner">
        <header className="cust-hub-head">
          <div className="cust-hub-title-row">
            <div>
              <h1>Customizations</h1>
              <p className="cust-hub-sub">Manage MCP integrations, slash skills, custom sub-agents, and output formatting styles.</p>
            </div>
            <div className="cust-seg-toggle" role="tablist" aria-label="Customizations view">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'marketplace'}
                className={'cust-seg-btn' + (tab === 'marketplace' ? ' on' : '')}
                onClick={() => setTab('marketplace')}
              >
                Marketplace
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'installed'}
                className={'cust-seg-btn' + (tab === 'installed' ? ' on' : '')}
                onClick={() => setTab('installed')}
              >
                Installed
              </button>
            </div>
          </div>
          <div className="cust-search-wrap">
            <Icon name="Search" size={15} className="cust-search-ico" />
            <input
              type="text"
              className="cust-search-input"
              placeholder="Search customizations..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button type="button" className="icon-btn cust-search-clear" onClick={() => setQuery('')} title="Clear search">
                <Icon name="X" size={13} />
              </button>
            )}
          </div>
        </header>

        {tab === 'marketplace' ? (
          <div className="cust-marketplace">
            {!qLower && (
              <section className="cust-hero">
                <div className="cust-hero-tiles" aria-hidden="true">
                  {['github', 'figma', 'gdocs', 'supabase', 'notion', 'rea'].map((tid) => {
                    const entry = catalogById.get(tid) || { id: tid, name: tid };
                    return (
                      <div key={tid} className="cust-hero-tile">
                        <ConnectorLogo id={entry.id} name={entry.name} size={32} />
                      </div>
                    );
                  })}
                </div>
                <div className="cust-hero-body">
                  <span className="cust-hero-pill">Featured Integration Pack</span>
                  <h2>{heroEntry.name}</h2>
                  <p>{heroEntry.description}</p>
                  <div className="cust-hero-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={busyId === heroEntry.id}
                      onClick={() => togglePlugin(heroEntry)}
                    >
                      {heroEntry.installed ? 'Added ✓' : '+ Add'}
                    </button>
                    <button type="button" className="cust-ghost-btn" onClick={() => setDetailEntry(heroEntry)}>
                      Details
                    </button>
                  </div>
                </div>
              </section>
            )}

            {SHELVES.map((shelf) => {
              const items = shelf.ids
                .map((id) => catalogById.get(id))
                .filter(Boolean)
                .filter((item) => !qLower || `${item.name} ${item.description} ${shelf.title}`.toLowerCase().includes(qLower));
              if (!items.length) return null;
              return (
                <section key={shelf.id} className="cust-shelf">
                  <div className="cust-shelf-head">
                    <h2>{shelf.title}</h2>
                    <span className="cust-shelf-sub">{shelf.subtitle}</span>
                  </div>
                  <div className="cust-shelf-grid">
                    {items.map(renderShelfCard)}
                  </div>
                </section>
              );
            })}

            {extraSearchResults.length > 0 && (
              <section className="cust-shelf">
                <div className="cust-shelf-head">
                  <h2>More Matching Integrations</h2>
                  <span className="cust-shelf-sub">{extraSearchResults.length} match(es)</span>
                </div>
                <div className="cust-shelf-grid">
                  {extraSearchResults.map(renderShelfCard)}
                </div>
              </section>
            )}

            {detailEntry && (
              <div className="cust-detail-drawer">
                <div className="cust-detail-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <ConnectorLogo id={detailEntry.id} name={detailEntry.name} size={34} />
                    <div>
                      <div className="cust-card-title">{detailEntry.name}</div>
                      <div className="cust-card-desc">{detailEntry.category} · Auth: {detailEntry.auth || 'none'}</div>
                    </div>
                  </div>
                  <button type="button" className="icon-btn" onClick={() => setDetailEntry(null)}><Icon name="X" size={14} /></button>
                </div>
                <p style={{ margin: '8px 0', fontSize: 13 }}>{detailEntry.description}</p>
                {Array.isArray(detailEntry.tools) && detailEntry.tools.length > 0 && (
                  <div className="cust-tool-chips">
                    {detailEntry.tools.map((t) => <span key={t} className="cust-tool-chip">{t}</span>)}
                  </div>
                )}
                <div className="cust-detail-actions">
                  <button type="button" className="primary" onClick={() => togglePlugin(detailEntry)}>
                    {detailEntry.installed ? 'Remove Integration' : '+ Add Integration'}
                  </button>
                  {detailEntry.auth === 'apikey' && (
                    <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                      <input
                        type="password"
                        className="cust-input"
                        placeholder="Paste API key / token..."
                        value={cfgKey}
                        onChange={(e) => setCfgKey(e.target.value)}
                      />
                      <button type="button" className="cust-ghost-btn" disabled={!cfgKey.trim()} onClick={() => savePluginConfig(detailEntry.id)}>
                        Save Key
                      </button>
                    </div>
                  )}
                  {['gdrive', 'gdocs', 'gsheets', 'gslides'].includes(detailEntry.id) && (
                    <button type="button" className="cust-ghost-btn" onClick={() => onOpenGdrive && onOpenGdrive()}>
                      Google Drive Setup
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="cust-installed">
            {/* Section A: Slash Skills & Workflows */}
            <section className="cust-section">
              <div className="cust-section-head">
                <button type="button" className="cust-collapse-btn" onClick={() => toggleSec('skills')}>
                  <Icon name={openSec.skills ? 'ChevronDown' : 'ChevronRight'} size={14} />
                  <span>Slash Skills &amp; Workflows ({filteredSkills.length})</span>
                </button>
                <div className="cust-section-actions">
                  <button type="button" className="cust-mini-btn" onClick={() => setSkillModal((v) => !v)}>+ New Skill</button>
                  <button type="button" className="cust-mini-btn" onClick={handleUploadSkill}>Upload .md</button>
                </div>
              </div>
              {skillModal && (
                <div className="cust-editor">
                  <div className="cust-editor-grid">
                    <input
                      className="cust-input"
                      placeholder="Skill slug (e.g. release-checklist)"
                      value={skillDraft.name}
                      onChange={(e) => setSkillDraft({ ...skillDraft, name: e.target.value })}
                    />
                  </div>
                  <textarea
                    rows={5}
                    className="cust-textarea"
                    placeholder={'---\nname: release-checklist\ndescription: Verify release readiness\n---\n\n# Instructions'}
                    value={skillDraft.content}
                    onChange={(e) => setSkillDraft({ ...skillDraft, content: e.target.value })}
                  />
                  <div className="cust-editor-foot">
                    <button type="button" className="cust-ghost-btn" onClick={() => setSkillModal(false)}>Cancel</button>
                    <button type="button" className="primary" onClick={handleSaveSkill}>Save Skill</button>
                  </div>
                </div>
              )}
              {openSec.skills && (
                <div className="cust-rows">
                  {filteredSkills.length === 0 ? (
                    <div className="cust-empty">No skills match your search.</div>
                  ) : filteredSkills.map((s) => {
                    const on = s.enabled !== false;
                    const badge = s.source === 'bundled' ? { label: 'Built In', cls: 'bi' } : (s.source === 'claude' ? { label: 'Global', cls: 'gl' } : { label: 'Global', cls: 'gl' });
                    return (
                      <div key={s.name} className={'cust-row' + (on ? '' : ' muted-row')}>
                        <div className="cust-row-main">
                          <code className="cust-mono">/{s.name}</code>
                          <span className={'cust-scope-badge ' + badge.cls}>{badge.label}</span>
                          <span className="cust-row-desc">{s.description}</span>
                        </div>
                        <div className="cust-row-actions">
                          {s.source === 'custom' && (
                            <button type="button" className="icon-btn" title="Delete skill" onClick={() => handleDeleteSkill(s.name)}>
                              <Icon name="Trash" size={13} />
                            </button>
                          )}
                          <button
                            type="button"
                            role="switch"
                            aria-checked={on}
                            className={'switch' + (on ? ' on' : '')}
                            onClick={() => toggleSkill && toggleSkill(s.name)}
                          >
                            <span className="knob" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Section B: Custom Agents */}
            <section className="cust-section">
              <div className="cust-section-head">
                <button type="button" className="cust-collapse-btn" onClick={() => toggleSec('agents')}>
                  <Icon name={openSec.agents ? 'ChevronDown' : 'ChevronRight'} size={14} />
                  <span>Custom Agents ({filteredAgents.length})</span>
                </button>
                <div className="cust-section-actions">
                  <button type="button" className="cust-mini-btn primary-soft" title="Create Custom Agent" onClick={() => openNewAgent()}>
                    + New Agent
                  </button>
                </div>
              </div>

              {agentEditor && (
                <div className="cust-editor" data-testid="custom-agent-editor">
                  <div className="cust-preset-strip">
                    <span className="cust-preset-label">Presets:</span>
                    {AGENT_PRESETS.map((p) => (
                      <button key={p.name} type="button" className="cust-preset-pill" onClick={() => openNewAgent(p)}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="cust-editor-grid">
                    <label className="cust-field">
                      <span>Name / Handle</span>
                      <input
                        className="cust-input"
                        placeholder="security-auditor"
                        value={agentEditor.name}
                        onChange={(e) => setAgentEditor({ ...agentEditor, name: e.target.value })}
                      />
                    </label>
                    <label className="cust-field">
                      <span>Role Title</span>
                      <input
                        className="cust-input"
                        placeholder="Security Auditor"
                        value={agentEditor.role}
                        onChange={(e) => setAgentEditor({ ...agentEditor, role: e.target.value })}
                      />
                    </label>
                    <label className="cust-field">
                      <span>Scope</span>
                      <select
                        className="cust-input"
                        value={agentEditor.scope}
                        onChange={(e) => setAgentEditor({ ...agentEditor, scope: e.target.value })}
                      >
                        <option value="autobot">Global (~/.autobot/agents)</option>
                        <option value="user">Global (~/.claude/agents)</option>
                        {cwd && <option value="workspace">Workspace (.claude/agents)</option>}
                      </select>
                    </label>
                    <label className="cust-field">
                      <span>Model / Orchestrator Role</span>
                      <select
                        className="cust-input"
                        value={agentEditor.model}
                        onChange={(e) => setAgentEditor({ ...agentEditor, model: e.target.value })}
                      >
                        <option value="inherit">inherit (active model)</option>
                        <option value="planner">planner</option>
                        <option value="coder">coder</option>
                        <option value="fast">fast</option>
                        <option value="vision">vision</option>
                        <option value="longctx">longctx</option>
                        <option value="image_gen">image_gen</option>
                        <option value="video_gen">video_gen</option>
                      </select>
                    </label>
                  </div>
                  <label className="cust-field">
                    <span>Description</span>
                    <input
                      className="cust-input"
                      placeholder="When should Akron Code delegate to this sub-agent?"
                      value={agentEditor.description}
                      onChange={(e) => setAgentEditor({ ...agentEditor, description: e.target.value })}
                    />
                  </label>
                  <div className="cust-field">
                    <span>Allowed Tools ({!agentEditor.tools || agentEditor.tools.length === 0 ? 'All Tools' : `${agentEditor.tools.length} selected`})</span>
                    <div className="cust-preset-strip">
                      {AGENT_TOOL_GROUPS.map((g) => (
                        <button
                          key={g.label}
                          type="button"
                          className="cust-preset-pill"
                          onClick={() => setAgentEditor({ ...agentEditor, tools: [...g.tools] })}
                        >
                          {g.label}
                        </button>
                      ))}
                    </div>
                    <div className="cust-tool-checks">
                      {AGENT_TOOL_CHOICES.map((tool) => {
                        const checked = Array.isArray(agentEditor.tools) && agentEditor.tools.includes(tool);
                        return (
                          <button
                            key={tool}
                            type="button"
                            className={'cust-check-chip' + (checked ? ' on' : '')}
                            onClick={() => {
                              const cur = Array.isArray(agentEditor.tools) ? agentEditor.tools : [];
                              const next = cur.includes(tool) ? cur.filter((x) => x !== tool) : [...cur, tool];
                              setAgentEditor({ ...agentEditor, tools: next });
                            }}
                          >
                            {tool}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <label className="cust-field">
                    <span>System Prompt / Instructions (Markdown)</span>
                    <textarea
                      rows={5}
                      className="cust-textarea"
                      value={agentEditor.body}
                      onChange={(e) => setAgentEditor({ ...agentEditor, body: e.target.value })}
                    />
                  </label>
                  <div className="cust-editor-foot">
                    <button type="button" className="cust-ghost-btn" onClick={() => setAgentEditor(null)}>Cancel</button>
                    <button type="button" className="primary" onClick={handleSaveAgent}>Save Custom Agent</button>
                  </div>
                </div>
              )}

              {openSec.agents && (
                <div className="cust-rows">
                  {customAgentCount === 0 && (
                    <div className="cust-empty-inline">
                      No custom agents yet — click <strong>+ New Agent</strong> to create `@security-auditor` or customize a built-in role.
                    </div>
                  )}
                  {filteredAgents.map((a) => {
                    const badge = SCOPE_BADGE(a.scope || a.source);
                    const isCustom = !!(a.custom || (a.source && a.source !== 'builtin'));
                    return (
                      <div key={`${a.scope || a.source}:${a.name}`} className="cust-row">
                        <div className="cust-row-main">
                          <code className="cust-mono">@{a.name}</code>
                          <span className={'cust-scope-badge ' + badge.cls}>{badge.label}</span>
                          {a.model && <span className="cust-meta-pill">{a.model}</span>}
                          <span className="cust-meta-pill">{Array.isArray(a.tools) && a.tools.length ? `${a.tools.length} tools` : 'All tools'}</span>
                          <span className="cust-row-desc">{a.description}</span>
                        </div>
                        <div className="cust-row-actions">
                          <button
                            type="button"
                            className="cust-mini-btn"
                            onClick={() => setAgentEditor({
                              name: isCustom ? a.name : `${a.name}-custom`,
                              role: a.role || a.name,
                              description: a.description || '',
                              scope: a.scope === 'workspace' || a.source === 'project' ? 'workspace' : 'autobot',
                              model: a.model || 'inherit',
                              tools: Array.isArray(a.tools) ? [...a.tools] : [],
                              body: a.body || '',
                            })}
                          >
                            {isCustom ? 'Edit' : 'Duplicate'}
                          </button>
                          {isCustom && (
                            <button type="button" className="icon-btn" title="Delete custom agent" onClick={() => handleDeleteAgent(a)}>
                              <Icon name="Trash" size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Section C: Custom Outputs (Output Styles) */}
            <section className="cust-section">
              <div className="cust-section-head">
                <button type="button" className="cust-collapse-btn" onClick={() => toggleSec('outputs')}>
                  <Icon name={openSec.outputs ? 'ChevronDown' : 'ChevronRight'} size={14} />
                  <span>Custom Outputs ({filteredStyles.length})</span>
                </button>
                <div className="cust-section-actions">
                  <button type="button" className="cust-mini-btn primary-soft" title="Create Custom Output Style" onClick={() => openNewOutputStyle()}>
                    + New Output Style
                  </button>
                </div>
              </div>

              {styleEditor && (
                <div className="cust-editor" data-testid="custom-output-editor">
                  <div className="cust-preset-strip">
                    <span className="cust-preset-label">Presets:</span>
                    {OUTPUT_STYLE_PRESETS.map((p) => (
                      <button key={p.name} type="button" className="cust-preset-pill" onClick={() => openNewOutputStyle(p)}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="cust-editor-grid">
                    <label className="cust-field">
                      <span>Style Name</span>
                      <input
                        className="cust-input"
                        placeholder="Executive Brief"
                        value={styleEditor.name}
                        onChange={(e) => setStyleEditor({ ...styleEditor, name: e.target.value })}
                      />
                    </label>
                    <label className="cust-field">
                      <span>Short Hint</span>
                      <input
                        className="cust-input"
                        placeholder="TL;DR first + impact bullets"
                        value={styleEditor.hint}
                        onChange={(e) => setStyleEditor({ ...styleEditor, hint: e.target.value })}
                      />
                    </label>
                    <label className="cust-field">
                      <span>Scope</span>
                      <select
                        className="cust-input"
                        value={styleEditor.scope}
                        onChange={(e) => setStyleEditor({ ...styleEditor, scope: e.target.value })}
                      >
                        <option value="autobot">Global (~/.autobot/output-styles)</option>
                        {cwd && <option value="workspace">Workspace (.claude/output-styles)</option>}
                      </select>
                    </label>
                  </div>
                  <label className="cust-field">
                    <span>Format Template / System Directive (Markdown)</span>
                    <textarea
                      rows={4}
                      className="cust-textarea"
                      placeholder="Injected via system directives whenever this output style is active..."
                      value={styleEditor.directive}
                      onChange={(e) => setStyleEditor({ ...styleEditor, directive: e.target.value })}
                    />
                  </label>
                  <label className="cust-checkbox-row">
                    <input
                      type="checkbox"
                      checked={!!styleEditor.setDefault}
                      onChange={(e) => setStyleEditor({ ...styleEditor, setDefault: e.target.checked })}
                    />
                    <span>Set as default output style for new turns</span>
                  </label>
                  <div className="cust-editor-foot">
                    <button type="button" className="cust-ghost-btn" onClick={() => setStyleEditor(null)}>Cancel</button>
                    <button type="button" className="primary" onClick={handleSaveOutputStyle}>Save Output Style</button>
                  </div>
                </div>
              )}

              {openSec.outputs && (
                <div className="cust-rows">
                  {filteredStyles.map((st) => {
                    const isCustom = !!st.custom;
                    const badge = SCOPE_BADGE(st.scope);
                    const isActive = styleId === st.id;
                    const isDef = localDefaultStyle === st.id;
                    return (
                      <div key={st.id} className={'cust-row' + (isActive ? ' active-row' : '')}>
                        <div className="cust-row-main">
                          <strong className="cust-row-title">{st.name}</strong>
                          <span className={'cust-scope-badge ' + badge.cls}>{badge.label}</span>
                          {isActive && <span className="cust-meta-pill ok">Active</span>}
                          {isDef && st.id !== 'default' && <span className="cust-meta-pill">Default</span>}
                          <span className="cust-row-desc">{st.hint || st.description || st.prompt}</span>
                        </div>
                        <div className="cust-row-actions">
                          <button type="button" className="cust-mini-btn" onClick={() => setStyleId && setStyleId(st.id)}>
                            {isActive ? 'Selected ✓' : 'Apply'}
                          </button>
                          {isCustom && (
                            <>
                              <button
                                type="button"
                                className="cust-mini-btn"
                                onClick={() => setStyleEditor({
                                  id: st.id,
                                  name: st.name,
                                  hint: st.hint || '',
                                  scope: st.scope === 'workspace' ? 'workspace' : 'autobot',
                                  directive: st.directive || st.prompt || '',
                                  setDefault: isDef,
                                })}
                              >
                                Edit
                              </button>
                              <button type="button" className="icon-btn" title="Delete output style" onClick={() => handleDeleteOutputStyle(st)}>
                                <Icon name="Trash" size={13} />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Section D: MCP Servers */}
            <section className="cust-section">
              <div className="cust-section-head">
                <button type="button" className="cust-collapse-btn" onClick={() => toggleSec('mcp')}>
                  <Icon name={openSec.mcp ? 'ChevronDown' : 'ChevronRight'} size={14} />
                  <span>MCP Servers ({mcpRows.length})</span>
                </button>
                <div className="cust-section-actions">
                  <button
                    type="button"
                    className="cust-mini-btn"
                    onClick={() => window.autobot && window.autobot.openExternal && window.autobot.openExternal('https://modelcontextprotocol.io/')}
                  >
                    Docs ↗
                  </button>
                  <button type="button" className="cust-mini-btn primary-soft" onClick={() => setMcpEditorOpen((v) => !v)}>
                    + Add Server
                  </button>
                </div>
              </div>

              {mcpEditorOpen && (
                <div className="cust-editor">
                  <div className="cust-editor-grid">
                    <label className="cust-field">
                      <span>Transport</span>
                      <select
                        className="cust-input"
                        value={mcpForm.transport}
                        onChange={(e) => setMcpForm && setMcpForm({ ...mcpForm, transport: e.target.value })}
                      >
                        <option value="stdio">stdio (local command)</option>
                        <option value="http">http (streamable HTTP)</option>
                        <option value="sse">sse (server-sent events)</option>
                      </select>
                    </label>
                    {mcpForm.transport === 'stdio' ? (
                      <>
                        <label className="cust-field">
                          <span>Command</span>
                          <input
                            className="cust-input"
                            placeholder="npx"
                            value={mcpForm.command}
                            onChange={(e) => setMcpForm && setMcpForm({ ...mcpForm, command: e.target.value })}
                          />
                        </label>
                        <label className="cust-field">
                          <span>Args</span>
                          <input
                            className="cust-input"
                            placeholder="-y @modelcontextprotocol/server-filesystem ."
                            value={mcpForm.args}
                            onChange={(e) => setMcpForm && setMcpForm({ ...mcpForm, args: e.target.value })}
                          />
                        </label>
                      </>
                    ) : (
                      <label className="cust-field">
                        <span>Server URL</span>
                        <input
                          className="cust-input"
                          placeholder="https://mcp.example.com/mcp"
                          value={mcpForm.url}
                          onChange={(e) => setMcpForm && setMcpForm({ ...mcpForm, url: e.target.value })}
                        />
                      </label>
                    )}
                  </div>
                  <div className="cust-editor-foot">
                    <button type="button" className="cust-ghost-btn" onClick={() => setMcpEditorOpen(false)}>Cancel</button>
                    <button
                      type="button"
                      className="primary"
                      onClick={async () => {
                        if (connectMcp) await connectMcp();
                        setMcpEditorOpen(false);
                      }}
                    >
                      Connect Server
                    </button>
                  </div>
                </div>
              )}

              {openSec.mcp && (
                <div className="cust-rows">
                  {mcpRows.map((srv) => {
                    const id = srv.serverId || srv.name;
                    const tools = Array.isArray(srv.tools) ? srv.tools : [];
                    const count = srv.toolCount || tools.length || 0;
                    const expanded = !!expandedMcp[id];
                    return (
                      <div key={id} className="cust-mcp-wrap">
                        <div className="cust-row">
                          <div className="cust-row-main">
                            <span className={'cust-dot ' + (srv.connected === false ? 'off' : 'ok')} />
                            <code className="cust-mono">{srv.name || id}</code>
                            {srv.builtin && <span className="cust-scope-badge bi">Built In</span>}
                            <span className="cust-row-desc">{count} tool{count === 1 ? '' : 's'} enabled</span>
                          </div>
                          <div className="cust-row-actions">
                            {tools.length > 0 && (
                              <button
                                type="button"
                                className="cust-mini-btn"
                                onClick={() => setExpandedMcp((m) => ({ ...m, [id]: !m[id] }))}
                              >
                                {expanded ? 'Hide Tools' : 'Tools'}
                              </button>
                            )}
                            {!srv.builtin && disconnectMcp && (
                              <button type="button" className="icon-btn" title="Disconnect MCP server" onClick={() => disconnectMcp(id)}>
                                <Icon name="Trash" size={13} />
                              </button>
                            )}
                          </div>
                        </div>
                        {expanded && tools.length > 0 && (
                          <div className="cust-tool-chips indented">
                            {tools.slice(0, 24).map((t, idx) => (
                              <span key={idx} className="cust-tool-chip">{typeof t === 'string' ? t : (t.name || JSON.stringify(t))}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

export default CustomizationsHub;
