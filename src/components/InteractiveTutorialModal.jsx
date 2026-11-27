import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon.jsx';
import { BEGINNER_PRESETS, STARTER_MISSIONS, detectActivePreset } from '../utils/tutorialPresets.js';

const GUIDE_SECTIONS = [
  {
    id: 'everyday',
    title: '1. Best Settings for 95% of Tasks ("Set & Forget")',
    keywords: 'recommended default beginner everyday settings setup auto swarm permissions thinking',
    icon: 'CheckCircle',
    bullets: [
      'Routing Mode: Smart Auto (or Lead + Builder / Orchestrator if you want your strongest model to plan every task).',
      'Swarm Pill: Keep Swarm OFF for normal Q&A, debugging, and 1–3 file edits. Flip Swarm ON only when building big apps or running full audits.',
      'Thinking Level: Keep on Auto so Akron decides when to think deeply vs answer quickly.',
      'Permissions: Keep on Auto (runs safe workspace commands/edits smoothly and still asks before risky actions).',
    ],
  },
  {
    id: 'modes',
    title: '2. How the 4 Modes Work (Auto vs Orchestrator vs Swarm vs Direct)',
    keywords: 'auto orchestrator swarm direct routing failover supervisor executor model',
    icon: 'Orbit',
    bullets: [
      'Smart Auto: Inspects each prompt and sends easy questions to a fast model, edits to a coder model, and tough bugs to a frontier model.',
      'Orchestrator (Lead + Builder): Your Supervisor model plans and checks quality while worker models run parallel read/search/code steps — with automatic backup failover if a model hits a rate limit.',
      'Swarm ON: Adds a Supervisor + 3–5 specialist teammates in isolated Git worktrees communicating on a shared Mission Board. Best for large tasks; turn OFF afterward so quick questions stay instant.',
      'Direct (Single Model): Locks Akron Code to the one exact model you clicked, with zero automatic model switching.',
    ],
  },
  {
    id: 'sessions',
    title: '3. Parallel Chats, Live Steering Queue & Instant Stop',
    keywords: 'new chat parallel session queue send now pause stop freeze stuck multiple tabs',
    icon: 'Chat',
    bullets: [
      'True Parallel Sessions: Click "+ New chat" (Cmd+N) or "+" in the top tab bar anytime — even while a heavy Swarm is running. Every session runs in isolation.',
      'Live Message Queue: Keep typing while Akron streams. New messages queue cleanly below the composer; click "Send now" to interrupt & deliver immediately, or reorder/pause queued items.',
      'Pause (||) vs Stop: Pause lets you inject mid-run steering feedback and resume; Stop aborts the active stream immediately without losing your transcript.',
    ],
  },
  {
    id: 'tools',
    title: '4. Built-in Browser, Code IDE, Worktrees, Live Browser Bot & Paradev',
    keywords: 'browser ide code terminal chrome extension 8766 paradev mcp worktree diff',
    icon: 'Globe',
    bullets: [
      'Left Sidebar Dock: Switch instantly between Code (files), Terminal, Built-in Browser, or click "IDE" in the top bar (Cmd+Shift+E) for the full Monaco code editor + debugger.',
      'Live Chrome Extension (:8766): Install the Akron Browser Bot extension or connect in Settings -> Browser Extension to control your already signed-in browser tabs.',
      'Paradev Cloud & MCP (Settings -> MCP Connectors): Connects live Paradev workspaces, tasks, and cloud MCP tools automatically when your Paradev API key is saved.',
      'Git Worktrees (Settings -> Worktrees): Isolate parallel Swarm agents cleanly so unfinished edits never collide.',
    ],
  },
  {
    id: 'shortcuts',
    title: '5. Essential Commands & Keyboard Shortcuts',
    keywords: 'slash commands plan review compact doctor tutorial guide shortcuts cmd k n @',
    icon: 'CommandLine',
    bullets: [
      '/plan <task> — Explore read-only and show a clear step-by-step plan before touching any files.',
      '/tutorial or /guide — Re-open this Interactive Tutorial & 1-Click Mode Setup anytime.',
      '/swarm on | off — Toggle Swarm AI Team right from the message box.',
      '/review & /doctor — Inspect Git diffs or diagnose model/MCP/permission readiness in 1 command.',
      '@filename or @agent — Attach files or target a specialist subagent right inside your prompt.',
      'Cmd+N (New Chat) · Cmd+K (Command Palette) · Cmd+Shift+E (Switch Agent / Full IDE) · Cmd+Shift+F (Search History).',
    ],
  },
];

export function WelcomeQuickStartBar({ provider, orchestrator, swarmEnabled, onApplyPreset, onOpenTutorial, onFillPrompt }) {
  const [dismissed, setDismissed] = useState(false);
  const active = detectActivePreset({ provider, orchestrator, swarmEnabled });

  if (dismissed) {
    return (
      <div className="welcome-quickstart-collapsed">
        <button type="button" className="wqs-reopen-btn" onClick={() => onOpenTutorial && onOpenTutorial('tour')}>
          <Icon name="GraduationCap" size={13} />
          <span>Interactive Tutorial &amp; Guide</span>
        </button>
      </div>
    );
  }

  return (
    <div className="welcome-quickstart" data-testid="welcome-quickstart">
      <div className="wqs-top">
        <span className="wqs-tip">{active.tip}</span>
        <div className="wqs-top-actions">
          <button type="button" className="wqs-btn" data-testid="open-tutorial-btn" onClick={() => onOpenTutorial && onOpenTutorial('tour')}>
            <Icon name="GraduationCap" size={13} />
            <span>Tour</span>
          </button>
          <button type="button" className="wqs-btn" data-testid="open-guide-btn" onClick={() => onOpenTutorial && onOpenTutorial('guide')}>
            <Icon name="Book" size={13} />
            <span>Guide</span>
          </button>
          <button type="button" className="icon-btn wqs-hide" title="Hide quick setup bar" aria-label="Hide quick setup bar" onClick={() => setDismissed(true)}>
            <Icon name="X" size={12} />
          </button>
        </div>
      </div>

      <div className="wqs-preset-grid" role="group" aria-label="1-Click Mode Presets">
        {BEGINNER_PRESETS.map((p) => {
          const isCurrent = active.id === p.id;
          return (
            <button
              key={p.id}
              type="button"
              data-testid={'wqs-preset-' + p.id}
              className={'wqs-card' + (isCurrent ? ' on' : '')}
              onClick={() => onApplyPreset && onApplyPreset(p.id)}
              title={p.bestFor}
            >
              <span className="wqs-card-ico"><Icon name={p.icon} size={13} /></span>
              <span className="wqs-card-title">{p.shortName}</span>
            </button>
          );
        })}
      </div>

      <div className="wqs-starters">
        <span className="wqs-starters-label">Try:</span>
        {STARTER_MISSIONS.map((m) => (
          <button
            key={m.id}
            type="button"
            className="wqs-starter-pill"
            title={m.desc}
            onClick={() => {
              onApplyPreset && onApplyPreset(m.presetId);
              onFillPrompt && onFillPrompt(m.prompt);
            }}
          >
            <Icon name={m.icon} size={11} />
            <span>{m.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function InteractiveTutorialModal({
  initialTab = 'tour',
  provider,
  orchestrator,
  swarmEnabled,
  permissions,
  cwd,
  mcpServers = [],
  providerKeys = {},
  onApplyPreset,
  onClose,
  onOpenSettings,
  onNewChat,
  onTogglePane,
  onPickFolder,
  onFillPrompt,
  onRunPrompt,
}) {
  const [tab, setTab] = useState(initialTab === 'guide' ? 'guide' : 'tour');
  const [step, setStep] = useState(0);
  const [guideQuery, setGuideQuery] = useState('');
  const [statusSnap, setStatusSnap] = useState({ oauthCount: 0, providers: [], extConnected: false });

  useEffect(() => {
    setTab(initialTab === 'guide' ? 'guide' : 'tour');
  }, [initialTab]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    (async () => {
      let oauthCount = 0;
      let providers = [];
      let extConnected = false;
      try {
        const st = window.autobot && window.autobot.providerStatus ? await window.autobot.providerStatus() : null;
        const list = (st && st.status && st.status.providers) || [];
        for (const pv of list) {
          const accts = pv.accounts || [];
          if (accts.length) {
            oauthCount += accts.length;
            providers.push(`${pv.label || pv.id} (${accts.length})`);
          }
        }
      } catch (_) {}
      try {
        const ext = window.autobot && window.autobot.extBridgeStatus ? await window.autobot.extBridgeStatus() : null;
        extConnected = Boolean(ext && (ext.connected || (Array.isArray(ext.tabs) && ext.tabs.length > 0)));
      } catch (_) {}
      if (alive) setStatusSnap({ oauthCount, providers, extConnected });
    })();
    return () => { alive = false; };
  }, []);

  const active = detectActivePreset({ provider, orchestrator, swarmEnabled });
  const totalOrchModels = (orchestrator && Array.isArray(orchestrator.providers) ? orchestrator.providers.filter((r) => r && r.enabled !== false).length : 0);
  const apiKeyCount = Object.values(providerKeys || {}).filter((v) => typeof v === 'string' && v.trim().length > 4).length;

  const filteredGuide = useMemo(() => {
    const q = guideQuery.trim().toLowerCase();
    if (!q) return GUIDE_SECTIONS;
    return GUIDE_SECTIONS.filter((s) => (
      s.title.toLowerCase().includes(q)
      || s.keywords.toLowerCase().includes(q)
      || s.bullets.some((b) => b.toLowerCase().includes(q))
    ));
  }, [guideQuery]);

  const TOUR_STEPS = [
    { id: 'mode', label: '1. Choose Mode' },
    { id: 'ready', label: '2. Ready Check' },
    { id: 'parallel', label: '3. Parallel Chats' },
    { id: 'tools', label: '4. Workspace & Plan' },
    { id: 'launch', label: '5. Try It Live' },
  ];

  const handleLaunchMission = (mission, autoSend) => {
    if (onApplyPreset) onApplyPreset(mission.presetId);
    if (onClose) onClose();
    if (autoSend && onRunPrompt) onRunPrompt(mission.prompt);
    else if (onFillPrompt) onFillPrompt(mission.prompt);
  };

  return (
    <div className="tutorial-overlay" role="dialog" aria-modal="true" aria-label="Akron Code Interactive Tutorial and How-To Guide" onClick={() => onClose && onClose()}>
      <div className="tutorial-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tutorial-header">
          <div className="tutorial-brand">
            <span className="tutorial-ico"><Icon name="GraduationCap" size={18} /></span>
            <div>
              <h2>Akron Code Quick Start &amp; How-To Guide</h2>
              <p>Learn how modes, Swarm, parallel sessions, and tools work together in under 2 minutes.</p>
            </div>
          </div>
          <div className="tutorial-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'tour'} className={'tutorial-tab' + (tab === 'tour' ? ' on' : '')} onClick={() => setTab('tour')}>
              <Icon name="Play" size={13} /> Interactive Hands-On Tour
            </button>
            <button type="button" role="tab" aria-selected={tab === 'guide'} className={'tutorial-tab' + (tab === 'guide' ? ' on' : '')} onClick={() => setTab('guide')}>
              <Icon name="Book" size={13} /> How-To Guide &amp; Settings
            </button>
          </div>
          <button type="button" className="icon-btn tutorial-close" title="Close" aria-label="Close tutorial" onClick={() => onClose && onClose()}>
            <Icon name="X" size={16} />
          </button>
        </div>

        {tab === 'tour' ? (
          <div className="tutorial-body">
            <div className="tutorial-stepper" role="tablist" aria-label="Tutorial steps">
              {TOUR_STEPS.map((st, idx) => (
                <button
                  key={st.id}
                  type="button"
                  role="tab"
                  aria-selected={step === idx}
                  className={'tutorial-step-btn' + (step === idx ? ' on' : '') + (idx < step ? ' done' : '')}
                  onClick={() => setStep(idx)}
                >
                  {idx < step ? <Icon name="Check" size={12} /> : null}
                  <span>{st.label}</span>
                </button>
              ))}
            </div>

            {step === 0 && (
              <div className="tutorial-pane">
                <div className="tutorial-lead">
                  <h3>Step 1 — Pick How Akron Thinks (1 Click, Instant Switch)</h3>
                  <p>Most confusion comes from leaving <b>Swarm ON</b> for simple chat, or wondering what <b>Auto</b> vs <b>Orchestrator</b> does. Click any card below to configure Akron live right now:</p>
                </div>
                <div className="tutorial-preset-grid">
                  {BEGINNER_PRESETS.map((p) => {
                    const isActive = active.id === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        data-testid={'tutorial-preset-' + p.id}
                        className={'tutorial-preset-card' + (isActive ? ' on' : '')}
                        onClick={() => onApplyPreset && onApplyPreset(p.id)}
                      >
                        <div className="tpc-top">
                          <span className="tpc-ico"><Icon name={p.icon} size={16} /></span>
                          <span className="tpc-title">{p.title}</span>
                          <span className={'tpc-badge' + (isActive ? ' on' : '')}>{isActive ? 'Active Now ✓' : p.badge}</span>
                        </div>
                        <p className="tpc-summary">{p.plainSummary}</p>
                        <div className="tpc-meta">
                          <span><b>Best for:</b> {p.bestFor}</span>
                          <span><b>Speed/Quota:</b> {p.costSpeed}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="tutorial-flow-diagram" aria-label="Active mode workflow">
                  <div className="tfd-label">How <b>{active.shortName}</b> runs right now:</div>
                  <div className="tfd-nodes">
                    {active.flow.map((label, i) => (
                      <React.Fragment key={label}>
                        <span className="tfd-node">{label}</span>
                        {i < active.flow.length - 1 && <Icon name="ArrowRight" size={12} className="tfd-arrow" />}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="tutorial-pane">
                <div className="tutorial-lead">
                  <h3>Step 2 — Check What Is Ready on This Mac</h3>
                  <p>Akron Code works with your signed-in subscriptions (Antigravity, Claude, ChatGPT), local Ollama, or API keys — and remembers all settings across restarts.</p>
                </div>
                <div className="tutorial-check-grid">
                  <div className="tc-card">
                    <div className="tc-head">
                      <Icon name={statusSnap.oauthCount > 0 || apiKeyCount > 0 || provider?.apiKey ? 'CheckCircle' : 'Warning'} size={16} />
                      <strong>AI Models &amp; Accounts</strong>
                      <span className={'tc-stat' + (statusSnap.oauthCount > 0 || apiKeyCount > 0 || provider?.apiKey ? ' ok' : ' warn')}>
                        {statusSnap.oauthCount > 0 ? statusSnap.providers.join(' · ') : (apiKeyCount > 0 ? `${apiKeyCount} key(s) saved` : 'Needs Sign-In or Key')}
                      </span>
                    </div>
                    <p>Active pill model: <code>{(provider && provider.model) || 'auto'}</code> · Mode: <b>{active.shortName}</b> · Permissions: <b>{permissions || 'auto'}</b>.</p>
                    <button type="button" className="tc-btn" onClick={() => { onClose && onClose(); onOpenSettings && onOpenSettings('providers'); }}>
                      <Icon name="Settings" size={13} /> Open Models &amp; Providers
                    </button>
                  </div>

                  <div className="tc-card">
                    <div className="tc-head">
                      <Icon name={totalOrchModels > 0 ? 'CheckCircle' : 'Info'} size={16} />
                      <strong>Orchestrator &amp; Backup Failover Pool</strong>
                      <span className={'tc-stat' + (totalOrchModels > 0 ? ' ok' : '')}>
                        {totalOrchModels > 0 ? `${totalOrchModels} pooled models` : 'Using Signed-In Accounts'}
                      </span>
                    </div>
                    <p>If one model hits a rate limit, Orchestrator automatically cools it down and continues on the next model in your pool.</p>
                    <button type="button" className="tc-btn" onClick={() => { onClose && onClose(); onOpenSettings && onOpenSettings('orchestrator'); }}>
                      <Icon name="Orbit" size={13} /> Configure Orchestrator Pool
                    </button>
                  </div>

                  <div className="tc-card">
                    <div className="tc-head">
                      <Icon name={cwd ? 'CheckCircle' : 'Folder'} size={16} />
                      <strong>Workspace Project Folder</strong>
                      <span className="tc-stat ok">{cwd ? cwd.split('/').pop() || cwd : 'Not picked yet'}</span>
                    </div>
                    <p>Current folder: <code>{cwd || '~'}</code>. Always pick your project folder so tools and <code>@file</code> search stay focused.</p>
                    <button type="button" className="tc-btn" onClick={() => onPickFolder && onPickFolder()}>
                      <Icon name="Folder" size={13} /> Choose Project Folder
                    </button>
                  </div>

                  <div className="tc-card">
                    <div className="tc-head">
                      <Icon name={statusSnap.extConnected || mcpServers.length > 0 ? 'CheckCircle' : 'Globe'} size={16} />
                      <strong>Browser Bridge (:8766) &amp; MCP Connectors</strong>
                      <span className={'tc-stat' + (statusSnap.extConnected || mcpServers.length > 0 ? ' ok' : '')}>
                        {statusSnap.extConnected ? 'Browser Connected' : 'Standby'} · {mcpServers.length} MCP
                      </span>
                    </div>
                    <p>Connect Paradev MCP, GitHub, or your live Chrome tabs through Settings whenever needed.</p>
                    <button type="button" className="tc-btn" onClick={() => { onClose && onClose(); onOpenSettings && onOpenSettings('mcp'); }}>
                      <Icon name="Sliders" size={13} /> Manage MCP &amp; Browser Bridge
                    </button>
                  </div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="tutorial-pane">
                <div className="tutorial-lead">
                  <h3>Step 3 — Parallel Chats &amp; Instant Live Controls</h3>
                  <p>Never wait for one big coding task to finish before asking another question. Every chat tab owns its own background agent stream.</p>
                </div>
                <div className="tutorial-hands-grid">
                  <div className="th-card">
                    <div className="th-title"><Icon name="Add" size={15} /> Parallel Sessions (<code>Cmd+N</code>)</div>
                    <p>Click <b>+ New chat</b> in the sidebar or <b>+</b> on the top tab strip while another task is running. Both conversations run independently side by side.</p>
                    <button type="button" className="tc-btn" onClick={() => { onClose && onClose(); onNewChat && onNewChat(); }}>
                      <Icon name="Add" size={13} /> Try Opening a New Parallel Tab
                    </button>
                  </div>
                  <div className="th-card">
                    <div className="th-title"><Icon name="Checklist" size={15} /> Message Queue + &quot;Send now&quot;</div>
                    <p>Type another message while Akron is working. It sits in the green <b>QUEUED</b> tray above the box — click <b>Send now</b> to interrupt cleanly, or <b>Pause</b> the queue.</p>
                  </div>
                  <div className="th-card">
                    <div className="th-title"><Icon name="Pause" size={15} /> Pause vs <Icon name="Stop" size={15} /> Stop</div>
                    <p><b>Pause (||)</b> holds the run so you can add a steering note. <b>Stop (red square)</b> cancels instantly (&lt;50ms) and unlocks the composer.</p>
                  </div>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="tutorial-pane">
                <div className="tutorial-lead">
                  <h3>Step 4 — Safe Planning, Code/IDE, Browser &amp; Shortcuts</h3>
                  <p>Practice the 3 highest-value workflows users rely on every day — try any button below right now:</p>
                </div>
                <div className="tutorial-hands-grid">
                  <div className="th-card">
                    <div className="th-title"><Icon name="LockShield" size={15} /> Safe Mode: <code>/plan</code></div>
                    <p>Start big edits with <code>/plan</code>. Akron reads files and shows a step-by-step plan for approval before modifying a single line.</p>
                    <button type="button" className="tc-btn" onClick={() => { onClose && onClose(); onFillPrompt && onFillPrompt('/plan '); }}>
                      <Icon name="CommandLine" size={13} /> Try <code>/plan</code> in Composer
                    </button>
                  </div>
                  <div className="th-card">
                    <div className="th-title"><Icon name="Globe" size={15} /> Built-In Browser &amp; Diff Review</div>
                    <p>Preview local web apps in the right pane, attach inspected elements directly to chat, or review every line changed before committing.</p>
                    <button type="button" className="tc-btn" onClick={() => { onClose && onClose(); onTogglePane && onTogglePane('browser'); }}>
                      <Icon name="Globe" size={13} /> Open Browser Side Pane
                    </button>
                  </div>
                  <div className="th-card">
                    <div className="th-title"><Icon name="Code" size={15} /> Switch to Full IDE View</div>
                    <p>Press <code>Cmd+Shift+E</code> or click <b>IDE</b> in the top bar for Monaco code editing, file tree, git diff, and built-in terminal alongside the agent.</p>
                    <button type="button" className="tc-btn" onClick={() => { onClose && onClose(); onTogglePane && onTogglePane('files'); }}>
                      <Icon name="Code" size={13} /> Open Files Side Pane
                    </button>
                  </div>
                </div>
              </div>
            )}

            {step === 4 && (
              <div className="tutorial-pane">
                <div className="tutorial-lead">
                  <h3>Step 5 — Launch a Hands-On First Mission</h3>
                  <p>Pick any starter mission below. Clicking it sets the recommended mode preset, prepares the prompt, and puts you right in control:</p>
                </div>
                <div className="tutorial-mission-grid">
                  {STARTER_MISSIONS.map((m) => (
                    <div key={m.id} className="tm-card">
                      <div className="tm-top">
                        <span className="tm-ico"><Icon name={m.icon} size={15} /></span>
                        <strong>{m.title}</strong>
                        <span className="tm-badge">{m.badge} · {m.duration}</span>
                      </div>
                      <p>{m.desc}</p>
                      <div className="tm-prompt">{m.prompt}</div>
                      <div className="tm-actions">
                        <button type="button" className="tc-btn" onClick={() => handleLaunchMission(m, false)}>
                          Load in Box
                        </button>
                        <button type="button" className="tc-btn primary" onClick={() => handleLaunchMission(m, true)}>
                          <Icon name="Play" size={12} /> Run Mission Now
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="tutorial-body tutorial-guide-body">
            <div className="tg-toolbar">
              <div className="tg-search">
                <Icon name="Search" size={14} />
                <input
                  type="text"
                  placeholder="Search guide (e.g. swarm, permissions, parallel chats, /plan, browser)…"
                  value={guideQuery}
                  onChange={(e) => setGuideQuery(e.target.value)}
                />
                {guideQuery && (
                  <button type="button" className="icon-btn" onClick={() => setGuideQuery('')} aria-label="Clear filter">
                    <Icon name="X" size={12} />
                  </button>
                )}
              </div>
              <button type="button" className="tc-btn primary" data-testid="apply-recommended-btn" onClick={() => onApplyPreset && onApplyPreset('auto')}>
                <Icon name="CheckCircle" size={13} /> Apply Everyday Recommended Settings
              </button>
            </div>

            <div className="tutorial-guide-grid">
              {filteredGuide.map((sec) => (
                <div key={sec.id} className="tg-card">
                  <h3><Icon name={sec.icon} size={15} /> {sec.title}</h3>
                  <ul>
                    {sec.bullets.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
              ))}
              {filteredGuide.length === 0 && (
                <div className="env-empty">No guide sections match &ldquo;{guideQuery}&rdquo;. Try clearing the search box.</div>
              )}
            </div>
          </div>
        )}

        <div className="tutorial-footer">
          <div className="tf-left">
            <span className="tf-active">Active Preset: <b>{active.shortName}</b> · Permissions: <b>{permissions || 'auto'}</b></span>
          </div>
          <div className="tf-right">
            {tab === 'tour' && step > 0 && (
              <button type="button" className="tc-btn" onClick={() => setStep((s) => Math.max(0, s - 1))}>
                <Icon name="ArrowLeft" size={13} /> Back
              </button>
            )}
            {tab === 'tour' && step < TOUR_STEPS.length - 1 ? (
              <button type="button" className="tc-btn primary" onClick={() => setStep((s) => Math.min(TOUR_STEPS.length - 1, s + 1))}>
                Next <Icon name="ArrowRight" size={13} />
              </button>
            ) : (
              <button type="button" className="tc-btn primary" data-testid="tutorial-done-btn" onClick={() => onClose && onClose()}>
                <Icon name="Check" size={13} /> Finish &amp; Start Chatting
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
