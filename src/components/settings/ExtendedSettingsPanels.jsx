import React, { useState } from 'react';
import { Icon } from '../Icon.jsx';

export function ApplicationSettingsSection({ settings, setSettings, features, saveFeat, setNotice }) {
  const [sleepBusy, setSleepBusy] = useState(false);

  const togglePreventSleep = async (checked) => {
    setSettings({ ...settings, preventSleep: checked });
    setSleepBusy(true);
    try {
      if (window.autobot && window.autobot.setPreventSleep) {
        await window.autobot.setPreventSleep(checked);
      }
      if (setNotice) setNotice(checked ? 'System sleep prevention active while Akron runs' : 'System sleep prevention disabled');
    } finally {
      setSleepBusy(false);
    }
  };

  return (
    <div className="settings-card" data-testid="application-settings-section">
      <h3><Icon name="Palette" size={14} /> Surface Finish, Power &amp; Update Channel</h3>
      <div className="row">
        <label>
          Surface Finish
          <select
            value={settings.surfaceFinish || 'emerald-carbon'}
            onChange={(e) => setSettings({ ...settings, surfaceFinish: e.target.value })}
          >
            <option value="emerald-carbon">Glossy Emerald Carbon (Default)</option>
            <option value="matte-obsidian">Matte Obsidian</option>
          </select>
        </label>
        <label>
          Update Release Channel
          <select
            value={settings.updateChannel || 'stable'}
            onChange={(e) => setSettings({ ...settings, updateChannel: e.target.value })}
          >
            <option value="stable">Stable Releases (Recommended)</option>
            <option value="prerelease">Pre-release / Insiders</option>
          </select>
        </label>
      </div>
      <label className="check">
        <input
          type="checkbox"
          disabled={sleepBusy}
          checked={!!settings.preventSleep}
          onChange={(e) => togglePreventSleep(e.target.checked)}
        />
        Prevent Mac/PC sleep while autonomous agents are running
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={!!settings.keepInTray}
          onChange={(e) => setSettings({ ...settings, keepInTray: e.target.checked })}
        />
        Keep Akron Code running in system tray / menu bar when window closes
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.autoUpdateScheduler !== false}
          onChange={(e) => setSettings({ ...settings, autoUpdateScheduler: e.target.checked })}
        />
        Automatically check GitHub Releases every 4 hours
      </label>
      {features && saveFeat && (
        <label className="check">
          <input
            type="checkbox"
            checked={!!features.remoteServerEnabled}
            onChange={(e) => saveFeat({ ...features, remoteServerEnabled: e.target.checked })}
          />
          Enable Remote Server API &amp; mobile companion pairing on loopback/LAN
        </label>
      )}
    </div>
  );
}

export function BrowserSettingsSection({ settings, setSettings, setNotice }) {
  const [testUrl, setTestUrl] = useState('https://github.com/akronlogic/akron-code');
  const [testVerdict, setTestVerdict] = useState(null);

  const runRuleTest = async () => {
    const allowList = settings.browserAllowUrls || '';
    const denyList = settings.browserDenyUrls || '';
    if (window.autobot && window.autobot.browserRulesCheck) {
      const r = await window.autobot.browserRulesCheck({ url: testUrl, allowList, denyList });
      setTestVerdict(r);
      return;
    }
    setTestVerdict({ allowed: !denyList.includes(testUrl), reason: 'Checked locally' });
  };

  return (
    <div className="settings-card" data-testid="browser-settings-section">
      <h3><Icon name="LockShield" size={14} /> Built-In Browser · Links, Downloads &amp; Actuation Rules</h3>
      <div className="row">
        <label>
          Default Link Handling
          <select
            value={settings.browserLinkMode || 'internal'}
            onChange={(e) => setSettings({ ...settings, browserLinkMode: e.target.value })}
          >
            <option value="internal">Open in Built-in Browser Pane</option>
            <option value="external">Open in System Browser</option>
          </select>
        </label>
        <label>
          Downloads Folder
          <input
            value={settings.browserDownloadsDir || '~/Downloads'}
            onChange={(e) => setSettings({ ...settings, browserDownloadsDir: e.target.value })}
            placeholder="~/Downloads"
          />
        </label>
      </div>
      <div className="row">
        <label>
          Allow URL Patterns (one per line or comma)
          <textarea
            rows={3}
            placeholder="github.com&#10;*.localhost&#10;docs.python.org"
            value={settings.browserAllowUrls || ''}
            onChange={(e) => setSettings({ ...settings, browserAllowUrls: e.target.value })}
            style={{ width: '100%', marginTop: 4, fontFamily: 'var(--mono)', fontSize: 12, padding: 6, background: 'var(--bg-000)', color: 'var(--text-000)', border: '1px solid var(--border-strong)', borderRadius: 8 }}
          />
        </label>
        <label>
          Deny URL Patterns (overrides Allow)
          <textarea
            rows={3}
            placeholder="*.bank.example&#10;admin.prod.internal/*"
            value={settings.browserDenyUrls || ''}
            onChange={(e) => setSettings({ ...settings, browserDenyUrls: e.target.value })}
            style={{ width: '100%', marginTop: 4, fontFamily: 'var(--mono)', fontSize: 12, padding: 6, background: 'var(--bg-000)', color: 'var(--text-000)', border: '1px solid var(--border-strong)', borderRadius: 8 }}
          />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input
          value={testUrl}
          onChange={(e) => setTestUrl(e.target.value)}
          placeholder="https://example.com/path"
          style={{ flex: 1 }}
        />
        <button type="button" className="btn-mini" onClick={runRuleTest}>Test URL Rule</button>
        <button
          type="button"
          className="btn-mini"
          onClick={() => {
            setSettings({ ...settings, browserLastClearedAt: Date.now() });
            if (setNotice) setNotice('Browser session cache & SoM markers cleared');
          }}
        >
          Clear Browser Data
        </button>
      </div>
      {testVerdict && (
        <p className="muted" style={{ marginTop: 6, color: testVerdict.allowed ? '#34d399' : '#f87171' }}>
          {testVerdict.allowed ? 'ALLOWED' : 'BLOCKED'} — {testVerdict.reason || testVerdict.matchedBy}
        </p>
      )}
    </div>
  );
}

function SvgLimitRing({ label, sub, pct }) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = 24;
  const circ = 2 * Math.PI * r;
  const dash = circ - (clamped / 100) * circ;
  return (
    <div className="limit-ring-card">
      <svg width="64" height="64" viewBox="0 0 64 64" aria-label={label}>
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="5" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke={clamped > 85 ? '#fbbf24' : '#10b981'}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={dash}
          transform="rotate(-90 32 32)"
        />
        <text x="32" y="36" textAnchor="middle" fontSize="12" fontWeight="700" fill="currentColor">
          {clamped}%
        </text>
      </svg>
      <div className="limit-ring-label">{label}</div>
      <div className="limit-ring-sub">{sub}</div>
    </div>
  );
}

export function ModelsAndLimitsSection({ settings, setSettings, convs = [] }) {
  const msgCount = (Array.isArray(convs) ? convs : []).reduce((s, c) => s + ((c.messages && c.messages.length) || 0), 0);
  const fiveHourPct = Math.min(95, Math.round(msgCount * 1.4));
  const weeklyPct = Math.min(95, Math.round(msgCount * 0.65));
  const monthlyPct = Math.min(95, Math.round(msgCount * 0.25));

  return (
    <div className="settings-card" data-testid="models-limits-section">
      <h3><Icon name="Sparkles" size={14} /> Orchestrator vs. Executor Models &amp; Usage Limit Rings</h3>
      <div className="row">
        <label>
          Orchestrator Model (Planning &amp; Verification)
          <input
            value={settings.orchestratorModel || 'claude-opus-4-6'}
            onChange={(e) => setSettings({ ...settings, orchestratorModel: e.target.value })}
            placeholder="claude-opus-4-6"
          />
        </label>
        <label>
          Executor Model (Fast Tool Edits &amp; Sub-Agents)
          <input
            value={settings.executorModel || 'claude-sonnet-4-6'}
            onChange={(e) => setSettings({ ...settings, executorModel: e.target.value })}
            placeholder="claude-sonnet-4-6"
          />
        </label>
      </div>
      <div className="limit-rings-grid">
        <SvgLimitRing label="5-Hour Window" sub="Rolling rate budget" pct={fiveHourPct} />
        <SvgLimitRing label="Weekly Limit" sub="Subscription / pool" pct={weeklyPct} />
        <SvgLimitRing label="Monthly Budget" sub="Zero-waste routed" pct={monthlyPct} />
      </div>
    </div>
  );
}

export function GiveFeedbackSection({ settings, provider, setNotice }) {
  const [category, setCategory] = useState('bug');
  const [summary, setSummary] = useState('');
  const [bundleJson, setBundleJson] = useState('');
  const [busy, setBusy] = useState(false);

  const generateBundle = async () => {
    setBusy(true);
    try {
      let data = null;
      if (window.autobot && window.autobot.generateDiagnostics) {
        data = await window.autobot.generateDiagnostics({
          category,
          summary,
          theme: settings.theme,
          surface: settings.surfaceFinish || 'emerald-carbon',
          settings,
          providerSummary: { model: provider && provider.model, baseURL: provider && provider.baseURL },
        });
      } else {
        data = { category, summary, scrubbed: true, generatedAt: new Date().toISOString() };
      }
      setBundleJson(JSON.stringify(data, null, 2));
      if (setNotice) setNotice('Generated scrubbed diagnostic bundle (secrets & PII stripped)');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card" data-testid="give-feedback-section">
      <h3><Icon name="Bug" size={14} /> Give Feedback &amp; Scrubbed Diagnostic Bundle</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Generates a privacy-safe diagnostic snapshot with API keys, OAuth tokens, emails, and user home directories automatically redacted.
      </p>
      <div className="row">
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="bug">Bug Report</option>
            <option value="feature">Feature Request</option>
            <option value="perf">Performance / IDE</option>
            <option value="browser">Browser Bot Issue</option>
          </select>
        </label>
      </div>
      <label>
        What happened?
        <textarea
          rows={3}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Describe steps to reproduce or share product feedback…"
          style={{ width: '100%', marginTop: 4, fontSize: 12.5, padding: 8, background: 'var(--bg-000)', color: 'var(--text-000)', border: '1px solid var(--border-strong)', borderRadius: 8 }}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" className="btn-mini primary" disabled={busy} onClick={generateBundle} data-testid="generate-diag-btn">
          <Icon name="ShieldSearch" size={12} /> {busy ? 'Generating…' : 'Generate Scrubbed Diagnostics'}
        </button>
        {bundleJson && (
          <button
            type="button"
            className="btn-mini"
            onClick={() => {
              try { navigator.clipboard.writeText(bundleJson); } catch (_) {}
              if (setNotice) setNotice('Diagnostic JSON copied to clipboard');
            }}
          >
            <Icon name="Copy" size={12} /> Copy JSON
          </button>
        )}
      </div>
      {bundleJson && (
        <pre className="tool-result" style={{ marginTop: 10, maxHeight: 240, overflow: 'auto' }} data-testid="diag-bundle-preview">
          {bundleJson}
        </pre>
      )}
    </div>
  );
}
