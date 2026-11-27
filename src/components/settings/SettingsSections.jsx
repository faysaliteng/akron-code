import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Icon } from '../Icon.jsx';
import { normBase, LOCAL_BASE } from '../../providerstatus-ui.mjs';
import { UI_FONT_PRESETS, MONO_FONT_PRESETS, DEFAULT_TYPOGRAPHY, normalizeTypography, resolveUiFontStack, resolveMonoFontStack, applyTypographyToDocument } from '../../typography.js';
import { HARNESS_PROFILES, loadJSON, saveJSON, useDismiss, ProvNotice, contextWindowFor } from '../../utils/appHelpers.jsx';

export function humanText(v) {
  return String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
}

/**
 * The Claude credential belongs to the Claude Code CLI, so this app never runs
 * its own OAuth for Claude — a second grant would mint a competing refresh
 * token and sign the CLI out. Both sign-in surfaces (Settings → Accounts and
 * the composer's model menu) drive the same CLI-owned flow through this hook:
 * start `claude auth login`, surface the URL it prints, forward the pasted
 * `code#state`, then let main adopt the keychain pair the CLI writes.
 *
 * `onChanged` is refreshed after every completed sign-in so the caller can
 * reload its account list without this hook knowing about it.
 */
export function useClaudeReconnect({ t, onChanged }) {
  const [rc, setRc] = useState(null); // { flowId, url, code, sent, line }
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const tRef = useRef(t);
  tRef.current = t;
  const rcRef = useRef(rc);
  rcRef.current = rc;

  const refresh = useCallback(async () => {
    const fn = changed.current;
    if (typeof fn === 'function') { try { await fn(); } catch (_) {} }
  }, []);

  // A Claude reconnect finishes when the CLI exits and we adopt its keychain.
  useEffect(() => {
    if (!window.autobot.onProviderReconnectResult) return undefined;
    return window.autobot.onProviderReconnectResult(async (flowId, result) => {
      setRc((m) => (m && m.flowId === flowId ? null : m));
      if (result && result.ok) { setNotice(''); await refresh(); }
      else setNotice(humanText((result && result.error) || 'sign-in did not complete'));
    });
  }, [refresh]);

  // The CLI judges a pasted code line by line. A rejected code that leaves it
  // waiting produces no result event at all, so quote its own words and hand
  // the box back (`sent: false`) whenever it asks for the full code.
  useEffect(() => {
    if (!window.autobot.onProviderReconnectLine) return undefined;
    return window.autobot.onProviderReconnectLine((flowId, payload) => {
      const line = humanText(payload && payload.line);
      if (!line) return;
      const retry = !!(payload && payload.retryable);
      setRc((m) => {
        if (!m || m.flowId !== flowId) return m;
        return retry ? { ...m, line, sent: false } : { ...m, line };
      });
      if (retry) setNotice('');
    });
  }, []);

  // A flow can be started from the other surface (the model menu vs Settings →
  // Accounts). Main owns the single login child, so on mount adopt whatever it
  // is already waiting on: the same sign-in then shows its paste box in both
  // places instead of looking dead in the one the user happens to be looking at.
  useEffect(() => {
    if (!window.autobot.providerReconnectState) return undefined;
    let stop = false;
    (async () => {
      try {
        const s = await window.autobot.providerReconnectState();
        if (stop || !s || !s.waiting || !s.url) return;
        setRc((m) => (m ? m : { flowId: s.flowId, url: s.url, code: '', sent: false, line: '' }));
      } catch (_) {}
    })();
    return () => { stop = true; };
  }, []);

  // The CLI can exit while the panel still shows a paste box. Ask main whether
  // the login is actually still waiting; a completed sign-in also stops the
  // flow, so only a window still closed a moment later is reported as closed.
  const rcFlowId = rc ? rc.flowId : '';
  const rcSent = !!(rc && rc.sent);
  useEffect(() => {
    if (!rcFlowId || rcSent || !window.autobot.providerReconnectState) return undefined;
    let stop = false;
    const probe = async () => {
      try { return await window.autobot.providerReconnectState(); } catch (_) { return null; }
    };
    const tick = async () => {
      const s = await probe();
      if (stop || !s || s.waiting) return;
      await new Promise((r) => setTimeout(r, 1200));
      if (stop) return;
      const again = await probe();
      if (stop || !again || again.waiting) return;
      setRc((m) => (m && m.flowId === rcFlowId ? null : m));
      setNotice(String(tRef.current ? tRef.current('account.reconnect.closed') : 'The Claude Code sign-in window closed.'));
    };
    const iv = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(iv); };
  }, [rcFlowId, rcSent]);

  const start = useCallback(async () => {
    setBusy(true);
    setNotice('');
    try {
      const r = await window.autobot.providerReconnectClaude();
      if (!r || r.ok === false) {
        setNotice(humanText((r && r.error) || 'could not start Claude Code sign-in'));
        return null;
      }
      setRc({ flowId: r.flowId, url: r.url || '', code: '', sent: false, line: '' });
      try { if (r.url && window.autobot.openExternal) await window.autobot.openExternal(r.url); } catch (_) {}
      return r;
    } catch (e) {
      setNotice(humanText((e && e.message) || 'could not start Claude Code sign-in'));
      return null;
    } finally { setBusy(false); }
  }, []);

  const cancel = useCallback(async () => {
    try { if (window.autobot.providerReconnectClaudeCancel) await window.autobot.providerReconnectClaudeCancel(); } catch (_) {}
    setRc(null);
  }, []);

  const setCode = useCallback((code) => setRc((m) => (m ? { ...m, code } : m)), []);

  const submit = useCallback(async () => {
    const m = rcRef.current;
    if (!m || !String(m.code || '').trim()) return;
    setBusy(true);
    try {
      const r = await window.autobot.providerReconnectClaudeCode(m.flowId, String(m.code).trim());
      if (r && r.ok === false) {
        const said = humanText(r.error || 'paste the code the sign-in page shows');
        // A dead flow is cleared so the panel stops offering a box that cannot
        // accept the code; anything else keeps the box and explains itself in
        // place, where the user is actually looking.
        if (/no longer waiting|window closed|expired/i.test(String(r.error || ''))) {
          setRc(null);
          setNotice(said);
          return;
        }
        setNotice('');
        setRc((cur) => (cur ? { ...cur, line: said, sent: false } : cur));
        return;
      }
      setNotice('');
      setRc({ ...m, code: '', sent: true, line: '' });
    } finally { setBusy(false); }
  }, []);

  return { rc, busy, notice, setNotice, start, cancel, submit, setCode };
}

/** Shared markup for the Claude paste-the-code box (both sign-in surfaces). */
export function ClaudeReconnectPanel({ t, rc, busy, onCancel, onChange, onSubmit }) {
  if (!rc) return null;
  return (
    <div className="prov-token prov-manual">
      <div className="prov-manual-hint">
        {rc.sent ? t('account.manual.checking') : t('account.reconnect.hint')}
      </div>
      {rc.line && <div className={'prov-manual-line' + (rc.sent ? '' : ' warn')}>{rc.line}</div>}
      {rc.url && (
        <button className="prov-link" onClick={async () => { try { await window.autobot.openExternal(rc.url); } catch (_) {} }}>
          {t('account.reconnect.open')}
        </button>
      )}
      <input
        className="prov-token-in"
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={t('account.manual.placeholder')}
        value={rc.code || ''}
        disabled={!!busy || rc.sent}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(); } }}
      />
      <button
        className="prov-link"
        disabled={!!busy || rc.sent || !String(rc.code || '').trim()}
        onClick={onSubmit}
      >{rc.sent ? t('account.manual.submitting') : t('account.manual.submit')}</button>
      <button className="prov-x" title={t('account.cancel')} aria-label={t('account.cancel')} onClick={onCancel}><Icon name="X" size={12} /></button>
    </div>
  );
}

// The real, local account surface. It reads this machine's provider subscriptions
// through the same IPC the model picker uses and drives real sign-in / sign-out /
// import. There is no account backend and no fabricated identity: every row below
// came from a token this app actually holds, so what you see is what will be used.
export function AccountSection({ T, provider, setProvider }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [manual, setManual] = useState(null); // { flowId, provId, code, sent }
  const [token, setToken] = useState({}); // per-provider pasted API key

  const load = useCallback(async () => {
    try {
      const r = await window.autobot.providerStatus();
      setSt(r && r.ok ? r.status : null);
    } catch (_) { setSt(null); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Claude sign-in is CLI-owned; this hook gives the panel the same flow the
  // composer's model menu uses.
  const claude = useClaudeReconnect({ t: T, onChanged: load });

  // Main reports the outcome of a paste-the-code sign-in here.
  useEffect(() => {
    if (!window.autobot.onProviderManualResult) return undefined;
    return window.autobot.onProviderManualResult(async (flowId, result) => {
      setManual((m) => (m && m.flowId === flowId ? null : m));
      if (result && result.ok) { setNotice(''); await load(); }
      else setNotice(humanText((result && result.error) || 'sign-in did not complete'));
    });
  }, [load]);

  // Browser sign-in does not resolve until the round-trip finishes (main waits
  // up to 10 minutes on the loopback listener). Never hold the panel open on
  // it: start the flow, keep the row spinner honest, and refresh when it lands
  // so the paste-a-code fallback stays clickable the whole time.
  const startBrowserSignIn = (id) => {
    setBusy('signin:' + id);
    setNotice('');
    Promise.resolve()
      .then(() => window.autobot.providerSignIn(id))
      .then((r) => {
        if (r && r.cancelled) setNotice('Sign-in cancelled — no account was added.');
        else if (r && r.ok === false) setNotice(humanText(r.error || 'sign-in was refused'));
      })
      .catch((e) => setNotice(humanText((e && e.message) || 'sign-in was refused')))
      .finally(() => { setBusy(''); load(); });
  };

  // Same cancel as the composer picker: the browser can be closed or lost, and
  // waiting out the timeout would look like a hang.
  const cancelBrowserSignIn = async (id) => {
    try { await window.autobot.providerSignInCancel(id); } catch (_) {}
  };

  const act = async (kind, id, account) => {
    if (kind === 'signin') { startBrowserSignIn(id); return null; }
    setBusy(kind + ':' + (id || ''));
    try {
      let r;
      if (kind === 'signout') r = await window.autobot.providerSignOut(id, account);
      else if (kind === 'import') r = await window.autobot.providerImport();
      else if (kind === 'autoheal') r = await window.autobot.providerAutoHeal({ importMissing: true });
      else if (kind === 'bearer') r = await window.autobot.providerAddBearer(id, account);
      if (kind === 'autoheal') {
        if (r && r.ok !== false) {
          const healed = Number(r.healed) || 0;
          const imported = Number(r.imported) || 0;
          const healthy = Number(r.healthy) || 0;
          setNotice(`Auto-Heal complete: repaired ${healed} · imported ${imported} · ${healthy} healthy PC account(s).`);
        } else {
          setNotice(humanText((r && r.error) || 'Auto-Heal failed'));
        }
      } else if (kind === 'import') {
        // Summarise the scan so a successful or all-skipped import is never silent.
        if (r && r.ok !== false && r.result) {
          const im = (r.result.imported || []).length;
          const sk = (r.result.skipped || []).length;
          const er = (r.result.errors || []).length;
          const parts = ['Imported ' + im];
          if (sk) parts.push('already present ' + sk);
          if (er) parts.push('failed ' + er);
          setNotice(parts.join(' · ') + (im ? ' — listed below.' : ' — nothing new to import.'));
        } else if (r && r.error) {
          setNotice(humanText(r.error));
        }
      } else if (r && r.ok === false && r.error) {
        // One human line, never a stack trace or raw markup.
        setNotice(humanText(r.error));
      } else {
        setNotice('');
        if (kind === 'bearer') setToken({});
      }
      await load();
      return r;
    } finally { setBusy(''); }
  };

  // Paste-the-code fallback: no loopback listener; we open the consent page which
  // prints a code, and hand it back here (what the Claude CLI does when the
  // browser cannot reach localhost).
  const signInManual = async (id) => {
    setBusy('manual:' + id);
    try {
      const r = await window.autobot.providerSignInManual(id);
      if (!r || r.ok === false) {
        setNotice(humanText((r && r.error) || 'could not start sign-in'));
        return;
      }
      setNotice('');
      setManual({ flowId: r.flowId, provId: id, url: r.url || '', code: '', sent: false });
    } catch (e) {
      setNotice(humanText((e && e.message) || 'could not start sign-in'));
    } finally { setBusy(''); }
  };

  const submit = async () => {
    const m = manual;
    if (!m || !String(m.code || '').trim()) return;
    setBusy('manual:' + m.provId);
    try {
      const r = await window.autobot.providerSubmitCode(m.flowId, String(m.code).trim());
      if (r && r.ok === false) {
        setNotice(humanText(r.error || 'paste the code the sign-in page shows'));
        return;
      }
      setNotice('');
      setManual({ ...m, code: '', sent: true });
    } finally { setBusy(''); }
  };

  // Selecting an account here does the same thing the composer's model menu
  // does: only the id goes into provider state, and main resolves it to a
  // short-lived bearer at the start of every turn. Pick a model the vendor
  // actually advertises so the first turn is not sent with a foreign id.
  const use = async (pv, a) => {
    if (!setProvider) return;
    const ids = (pv.models || []).map((m) => m.id);
    const dflt = ids.includes(provider.model) ? provider.model : (ids[0] || provider.model || '');
    setProvider((v) => ({
      ...v,
      baseURL: '',
      apiKey: '',
      model: dflt || v.model,
      supportsTools: true,
      oauthProvider: a.id,
      transport: pv.transport,
      oauth: true,
      accessToken: '',
    }));
    try { if (window.autobot.providerSetActive) await window.autobot.providerSetActive(pv.id, a.account); } catch (_) { /* main may not persist */ }
  };

  const providers = (st && st.providers) || [];

  // Secondary line under an account name. Never repeat the plan when the label
  // already carries it ("Claude · max" + "max"), and never show a bare internal
  // token like "oauth" when we know which app the credential came from.
  const SOURCE_NAMES = {
    'claude-code': 'Claude Code app',
    'antigravity-app': 'Antigravity app',
    'codex-cli': 'Codex CLI',
    'grok-cli': 'Grok CLI',
    oauth: T('account.subscription'),
    manual: T('account.keySource'),
  };
  const acctSub = (a) => {
    const label = String(a.label || '');
    // The provider's own name for the plan when it gave us one ("Free", "Plus"),
    // else the internal slug. Both come from a real entitlement check.
    const plan = String(a.planName || a.plan || '');
    const planShown = plan && !label.toLowerCase().includes(plan.toLowerCase());
    if (planShown) return plan;
    return SOURCE_NAMES[a.source] || plan || T('account.signedIn');
  };

  return (
    <div className="account-section">
      <h3><Icon name="Plug" size={14} /> {T('account.title')}</h3>
      <p className="muted" style={{ margin: '2px 0 12px' }}>{T('account.blurb')}</p>

      {!st && <p className="muted">{T('account.loading')}</p>}

      {/* An index that cannot be parsed is not "no accounts". Say so instead of
          rendering an empty list the user would read as their sign-ins being gone. */}
      {st && st.storeError && (
        <ProvNotice warn text={T('account.storeError')} />
      )}

      <div className="acct-prov-list">
      {st && providers.map((pv) => {
        const hasAccounts = pv.accounts && pv.accounts.length > 0;
        const needsAction = !hasAccounts || pv.accounts.some((a) => a.needsSignIn || a.expired);
        return (
        <div key={pv.id} className="prov-group acct-prov">
          <div className="prov-head acct-card-head">
            <div className="acct-title-wrap">
              <span className="prov-name">{pv.label}</span>
              <span className={'acct-count' + (hasAccounts ? ' connected' : '')}>
                {pv.accounts.length === 1 ? '1 account' : (pv.accounts.length ? pv.accounts.length + ' ' + T('account.count') : T('account.none'))}
              </span>
            </div>
            <div className="acct-actions">
              {pv.id === 'claude' && (
                <button type="button" className={needsAction ? 'primary' : ''} disabled={!!busy || claude.busy} onClick={claude.start}>
                  <Icon name="ArrowInSquare" size={13} /> {claude.busy ? T('account.opening') : T('account.reconnect')}
                </button>
              )}
              {pv.id !== 'claude' && pv.canBrowserSignIn && (
                <button
                  type="button"
                  className={needsAction ? 'primary' : ''}
                  disabled={!!busy && busy !== 'signin:' + pv.id}
                  onClick={() => (busy === 'signin:' + pv.id ? cancelBrowserSignIn(pv.id) : act('signin', pv.id))}
                >
                  <Icon name="ArrowInSquare" size={13} /> {busy === 'signin:' + pv.id ? T('account.cancel') : (pv.accounts.length ? T('account.add') : T('account.signIn'))}
                </button>
              )}
              {pv.id !== 'claude' && pv.canManualCode && (
                <button type="button" disabled={!!busy} onClick={() => signInManual(pv.id)}>
                  <Icon name="Clipboard" size={13} /> {busy === 'manual:' + pv.id ? T('account.opening') : T('account.paste')}
                </button>
              )}
            </div>
          </div>

          {hasAccounts && (
            <div className="acct-rows">
              {pv.accounts.map((a) => {
                const on = provider && provider.oauthProvider === a.id;
                return (
                  <div key={a.id} className={'prov-acct' + (on ? ' on' : '')}>
                    <span className={'model-dot ' + (a.needsSignIn || a.expired ? 'out' : 'ok')} />
                    <button
                      type="button"
                      className="prov-pick"
                      title={a.needsSignIn ? T('account.needsSignIn') : (a.expired ? T('account.expired') : (a.label || a.account))}
                      onClick={() => use(pv, a)}
                    >
                      <span className="model-opt-name">{a.label || a.account}</span>
                      <span className="model-opt-prov">{a.needsSignIn ? T('account.needsSignIn') : acctSub(a)}</span>
                      {on && <Icon name="Check" size={13} className="model-check" />}
                    </button>
                    <button type="button" className="prov-x" title={T('account.signOut')} disabled={busy === 'signout:' + pv.id} onClick={() => act('signout', pv.id, a.account)}>
                      <Icon name="Logout" size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {pv.id === 'claude' && (
            <ClaudeReconnectPanel
              t={T}
              rc={claude.rc}
              busy={busy || claude.busy}
              onCancel={claude.cancel}
              onChange={claude.setCode}
              onSubmit={claude.submit}
            />
          )}

          {manual && manual.provId === pv.id && (
            <div className="prov-token prov-manual">
              <div className="prov-manual-hint">
                {manual.sent ? T('account.manual.checking') : T('account.manual.hint')}
              </div>
              <input
                className="prov-token-in"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={T('account.manual.placeholder')}
                value={manual.code || ''}
                disabled={!!busy || manual.sent}
                onChange={(e) => setManual((m) => (m ? { ...m, code: e.target.value } : m))}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
              />
              <button
                type="button"
                className="prov-link"
                disabled={!!busy || manual.sent || !String(manual.code || '').trim()}
                onClick={submit}
              >{manual.sent ? T('account.manual.submitting') : T('account.manual.submit')}</button>
              <button type="button" className="prov-x" title={T('account.cancel')} aria-label={T('account.cancel')} onClick={() => setManual(null)}><Icon name="X" size={12} /></button>
            </div>
          )}

          {pv.canPasteKey && (
            <div className="prov-token acct-key-row">
              <input
                className="prov-token-in"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={T('account.key') + ' ' + pv.vendor + ' ' + T('account.key.suffix')}
                value={token[pv.id] || ''}
                disabled={!!busy}
                onChange={(e) => setToken((m) => ({ ...m, [pv.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter' && (token[pv.id] || '').trim()) { e.preventDefault(); act('bearer', pv.id, (token[pv.id] || '').trim()); } }}
              />
              <button
                type="button"
                className="acct-key-btn"
                disabled={!!busy || !(token[pv.id] || '').trim()}
                onClick={() => act('bearer', pv.id, (token[pv.id] || '').trim())}
              >{busy === 'bearer:' + pv.id ? T('account.key.checking') : T('account.key.add')}</button>
            </div>
          )}
        </div>
        );
      })}
      </div>

      {st && (
        <div className="account-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="primary" disabled={!!busy} onClick={() => act('autoheal')}>
            <Icon name="Refresh" size={13} /> {busy === 'autoheal:' ? 'Healing PC Accounts…' : 'Auto-Heal PC Accounts'}
          </button>
          <button type="button" disabled={!!busy} onClick={() => act('import')}>
            <Icon name="Download" size={13} /> {busy === 'import:' ? T('account.import.scanning') : T('account.import')}
          </button>
        </div>
      )}

      <ProvNotice text={notice || claude.notice} />
    </div>
  );
}

// ---------- Organization compliance (`taint:*` capabilities) ----------
// Desktop reads `memberships[].organization.capabilities` from the account API
// and derives every gate from it. Akron Code has no account backend, so the
// profile is declared here and the main process evaluates the exact same
// arithmetic (`electron/compliance.js`). Toggles map 1:1 onto capability strings.
export function ComplianceSection({ compliance, setCompliance }) {
  const [busy, setBusy] = useState(false);
  const [auditCount, setAuditCount] = useState(null);
  const profile = (compliance && compliance.profile) || { capabilities: [], dataRetention: 'default' };
  const state = (compliance && compliance.state) || null;
  const catalog = (compliance && compliance.catalog) || [];

  useEffect(() => {
    if (!window.autobot || !window.autobot.complianceAudit) return;
    window.autobot.complianceAudit(500).then((rows) => setAuditCount((rows || []).length)).catch(() => {});
  }, [compliance]);

  const save = async (patch) => {
    if (!window.autobot || !window.autobot.complianceSet) return;
    setBusy(true);
    try {
      const snap = await window.autobot.complianceSet(patch);
      setCompliance(snap);
    } catch (_) {} finally { setBusy(false); }
  };

  const reset = async () => {
    if (!window.autobot || !window.autobot.complianceReset) return;
    setBusy(true);
    try {
      const snap = await window.autobot.complianceReset();
      setCompliance(snap);
    } catch (_) {} finally { setBusy(false); }
  };

  const caps = profile.capabilities || [];
  const toggle = (id) => {
    if (id.endsWith('*')) return; // prefix row is documentation only
    const next = caps.includes(id) ? caps.filter((c) => c !== id) : [...caps, id];
    save({ capabilities: next });
  };

  const tone = state ? state.tone : 'unknown';
  const toneLabel = { ok: 'Allowed', warn: 'Marked', blocked: 'Blocked', unknown: 'Unknown' }[tone] || 'Unknown';

  const rows = catalog.filter((r) => !r.prefix);
  const taintRows = rows.filter((r) => String(r.id).startsWith('taint:'));
  const relatedRows = rows.filter((r) => !String(r.id).startsWith('taint:'));

  const derived = state
    ? [
        ['Retention', state.retention],
        ['HIPAA', state.hipaa],
        ['CMEK', state.cmek === null ? 'not applicable' : state.cmek ? 'blocked' : 'available'],
        ['Cloud & model moves', state.cloudMove && state.cloudMove.verdict ? state.cloudMove.verdict + (state.cloudMove.why ? ' · ' + state.cloudMove.why : '') : 'unverified'],
        ['MCP tool toggles', state.toolSwitch && state.toolSwitch.allowed ? 'local only' : 'local only · blocked from sync'],
        ['Session deletion', state.deletion && state.deletion.allowed ? (state.audit ? 'allowed · audited' : 'allowed') : 'refused'],
        ['Product feedback', state.feedback && state.feedback.allowed ? 'allowed' : 'off'],
        ['Deployment', state.deployment + (state.deploymentPending ? ' · pending' : '')],
        ['Chat', state.chat ? (state.chat.allowed ? (state.chat.planAllowed ? 'allowed · paid plan' : 'allowed') : 'refused') : 'unknown'],
      ]
    : [];

  return (
    <>
      <h3><Icon name="WarningShield" size={14} /> Compliance</h3>
      <p className="muted">
        Organization data-classification for this device. Capabilities gate session deletion, cloud moves,
        MCP tool sync and product feedback exactly as the desktop app does. Nothing leaves this machine.
      </p>

      <div className="row">
        <label>Organization
          <input
            value={profile.organization || ''}
            placeholder="Local profile (no account backend)"
            onChange={(e) => save({ organization: e.target.value })}
            disabled={busy}
          />
        </label>
        <label>Data retention
          <select value={profile.dataRetention || 'default'} onChange={(e) => save({ dataRetention: e.target.value })} disabled={busy}>
            <option value="default">default (no agreement)</option>
            <option value="none">none (zero retention)</option>
            <option value="limited">limited</option>
          </select>
        </label>
      </div>

      <div className={'compliance-badge tone-' + tone}>
        <b>{toneLabel}</b>
        <span>{state ? state.headline : 'Loading compliance state…'}</span>
      </div>

      {derived.length > 0 && (
        <div className="compliance-grid">
          {derived.map(([k, v]) => (
            <div key={k} className="compliance-cell"><span>{k}</span><b>{v}</b></div>
          ))}
        </div>
      )}

      <h4 className="compliance-sub">Organization capabilities</h4>
      {taintRows.map((r) => (
        <label className="check" key={r.id} title={r.summary}>
          <input type="checkbox" checked={caps.includes(r.id)} onChange={() => toggle(r.id)} disabled={busy} />
          {r.label}
          <code className="compliance-code">{r.id}</code>
        </label>
      ))}

      <h4 className="compliance-sub">Retention flags</h4>
      {relatedRows.map((r) => (
        <label className="check" key={r.id} title={r.summary}>
          <input type="checkbox" checked={caps.includes(r.id)} onChange={() => toggle(r.id)} disabled={busy} />
          {r.label}
          <code className="compliance-code">{r.id}</code>
        </label>
      ))}

      <div className="row compliance-actions">
        <label className="check">
          <input
            type="checkbox"
            checked={profile.visibilityStatus === 'pending'}
            onChange={(e) => save({ visibilityStatus: e.target.checked ? 'pending' : null })}
            disabled={busy}
          />
          Deployment visibility pending
        </label>
        <span className="muted">Deletion audit records: {auditCount === null ? '—' : auditCount}</span>
        <button onClick={reset} disabled={busy}>Reset profile</button>
      </div>
    </>
  );
}


// ---------- Bundled agent runtimes (Claude Code / Codex / Grok CLI) ----------
// Every CLI the Bash tool can spawn ships inside the DMG and updates itself from
// upstream. This panel is the only place that shows which copy is actually in
// effect, because a stale bundled binary silently degrades every agent run.
export function RuntimesSection() {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ bundledDir: '', error: '' });
  const [busy, setBusy] = useState('');   // runtime id, or '' when idle
  const [live, setLive] = useState({});   // id -> progress line
  const [note, setNote] = useState('');
  const api = (typeof window !== 'undefined' && window.autobot) || {};

  const apply = (r) => {
    if (r && r.runtimes) setRows(r.runtimes);
    if (r && r.bundledDir !== undefined) setMeta({ bundledDir: r.bundledDir || '', error: r.ok === false ? (r.error || '') : '' });
  };

  const refresh = useCallback(async () => {
    if (!api.runtimes) return;
    try { apply(await api.runtimes()); }
    catch (e) { setMeta((m) => ({ ...m, error: String((e && e.message) || e) })); }
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);

  // Live progress + auto-refresh when a background pass promotes something.
  useEffect(() => {
    if (!api.onEvent) return undefined;
    return api.onEvent((evt) => {
      if (!evt) return;
      if (evt.type === 'runtime' && evt.id) {
        setLive((l) => ({ ...l, [evt.id]: evt.message || evt.phase || '' }));
        if (evt.phase === 'done' || evt.phase === 'error') refresh();
      } else if (evt.type === 'runtimes-updated') {
        refresh();
        const n = (evt.results || []).length;
        if (n) setNote('Updated ' + n + ' runtime' + (n === 1 ? '' : 's') + ' in the background.');
      }
    });
  }, [api, refresh]);

  const autoUpdate = rows.length ? rows.every((r) => r.autoUpdate !== false) : true;

  const check = async () => {
    setBusy('check'); setNote('');
    try { const r = await api.runtimesCheck(); apply(r); const n = r && r.updates ? r.updates.length : 0; setNote(n ? (n + ' update' + (n === 1 ? '' : 's') + ' available.') : 'Everything is current.'); }
    catch (e) { setNote(String((e && e.message) || e)); }
    finally { setBusy(''); }
  };

  const update = async (id, force) => {
    setBusy(id || 'all');
    setLive((l) => ({ ...l, [id || 'all']: 'Starting…' }));
    try { const r = await api.runtimesUpdate(id || undefined, !!force); apply(r); if (r && r.ok === false) setNote(r.error || 'Update failed.'); }
    catch (e) { setNote(String((e && e.message) || e)); }
    finally { setBusy(''); setLive((l) => { const n = { ...l }; delete n[id || 'all']; return n; }); }
  };

  const rollback = async (id) => {
    setBusy(id);
    try { const r = await api.runtimesRollback(id); apply(r); if (r && r.ok === false) setNote(r.error || 'Rollback failed.'); }
    catch (e) { setNote(String((e && e.message) || e)); }
    finally { setBusy(''); }
  };

  const toggleAuto = async (on) => {
    try { await api.runtimesAutoUpdate(on); setRows((rs) => rs.map((r) => ({ ...r, autoUpdate: on }))); }
    catch (_) { /* preference is best-effort */ }
  };

  const sourceLabel = (src) => src === 'installed' ? 'self-updated' : src === 'bundled' ? 'bundled in app' : src === 'system' ? 'from PATH' : 'not found';

  return (
    <>
      <h3><Icon name="Settings" size={14} /> Bundled agent runtimes</h3>
      <p className="muted" style={{ marginTop: -6 }}>
        The Claude Code, Codex and Grok CLIs the Bash tool runs. Each ships inside the app and
        updates itself from the vendor&apos;s own release feed.
      </p>
      <label className="check">
        <input type="checkbox" checked={autoUpdate} onChange={(e) => toggleAuto(e.target.checked)} />
        Check for newer versions automatically on launch
      </label>
      <div className="rt-list">
        {rows.length === 0 && <p className="muted">{meta.error || 'Reading runtime status…'}</p>}
        {rows.map((r) => {
          const prog = live[r.id];
          const stale = r.latest && r.version && r.latest !== r.version;
          return (
            <div key={r.id} className={'rt-item' + (r.busy ? ' busy' : '')}>
              <div className="rt-main">
                <span className="rt-name">{r.label || r.id}</span>
                <span className="rt-vendor">{r.vendor}</span>
                <span className={'rt-src rt-src-' + (r.source || 'missing')}>{sourceLabel(r.source)}</span>
              </div>
              <div className="rt-ver">
                <code>{r.version || '—'}</code>
                {stale && <span className="rt-arrow"> → <b>{r.latest}</b></span>}
                {!stale && r.latest && <span className="rt-uptodate"> · latest</span>}
                {r.error && <span className="rt-err" title={r.error}> · {r.error.slice(0, 60)}</span>}
              </div>
              <div className="rt-actions">
                <button type="button" className="btn-mini" disabled={!!busy} onClick={() => update(r.id, r.source !== 'missing' && !stale)}>
                  {busy === r.id ? 'Updating…' : (r.source === 'missing' ? 'Install' : stale ? 'Update' : 'Reinstall')}
                </button>
                {r.source === 'installed' && (
                  <button type="button" className="btn-mini" disabled={!!busy} onClick={() => rollback(r.id)} title="Switch back to the previous version">Rollback</button>
                )}
              </div>
              {prog && <div className="rt-prog">{prog}</div>}
            </div>
          );
        })}
      </div>
      <div className="rt-foot">
        <button type="button" className="btn-mini" disabled={!!busy} onClick={check}>{busy === 'check' ? 'Checking…' : 'Check for updates'}</button>
        <button type="button" className="btn-mini" disabled={!!busy} onClick={() => update('')}>{busy === 'all' ? 'Updating…' : 'Update all'}</button>
        {note && <span className="muted rt-note">{note}</span>}
      </div>
      {meta.bundledDir && <p className="muted rt-path">Bundled copies: <code>{meta.bundledDir}</code></p>}
      {meta.error && !rows.length && <p className="muted rt-path">{meta.error}</p>}
    </>
  );
}

export function DependenciesAndUpdaterSection({ setNotice }) {
  const [deps, setDeps] = useState(null);
  const [installingId, setInstallingId] = useState('');
  const [lspNote, setLspNote] = useState('');
  const [upd, setUpd] = useState(null);
  const [updBusy, setUpdBusy] = useState('');
  const [updProg, setUpdProg] = useState(null);
  const [staged, setStaged] = useState(null);
  const api = (typeof window !== 'undefined' && window.autobot) || {};

  const refreshDeps = useCallback(async () => {
    if (!api.depsStatus) return;
    try {
      const r = await api.depsStatus();
      if (r && r.ok) setDeps(r);
    } catch (_) {}
  }, [api]);

  useEffect(() => { refreshDeps(); }, [refreshDeps]);

  useEffect(() => {
    if (!api.onEvent) return undefined;
    return api.onEvent((evt) => {
      if (!evt) return;
      if (evt.type === 'dep-lsp' && evt.message) setLspNote(evt.message);
      if (evt.type === 'app-update-progress') setUpdProg(evt);
    });
  }, [api]);

  const installLsp = async (id) => {
    if (!api.depsInstallLsp) return;
    setInstallingId(id);
    setLspNote(`Installing ${id} language server…`);
    try {
      const r = await api.depsInstallLsp(id);
      if (r && r.ok) {
        if (r.status) setDeps(r.status);
        setLspNote(`✅ Installed ${id} language server (${r.path || 'ready'})`);
        setNotice && setNotice(`Installed ${id} LSP server`);
      } else {
        setLspNote(`❌ Install failed: ${(r && r.error) || 'unknown'}`);
      }
    } finally {
      setInstallingId('');
    }
  };

  const checkAppUpdate = async () => {
    if (!api.updateCheck) return;
    setUpdBusy('check');
    try {
      const r = await api.updateCheck();
      setUpd(r);
      if (r && r.ok && r.updateAvailable) {
        setNotice && setNotice(`Update available: Akron Code v${r.latestVersion}`);
      }
    } finally {
      setUpdBusy('');
    }
  };

  const downloadUpdate = async () => {
    if (!upd || !upd.asset || !api.updateDownload) return;
    setUpdBusy('download');
    setUpdProg({ percent: 0 });
    try {
      const r = await api.updateDownload({ asset: upd.asset, sumsUrl: upd.sumsUrl });
      if (r && r.ok) {
        setStaged(r);
        setNotice && setNotice(`Verified SHA-256 update ready: ${r.name}`);
      } else {
        setUpd((u) => ({ ...(u || {}), error: (r && r.error) || 'Download failed' }));
      }
    } finally {
      setUpdBusy('');
    }
  };

  const installStagedUpdate = async () => {
    if (!staged || !staged.path || !api.updateApply) return;
    const r = await api.updateApply(staged.path);
    if (r && r.ok) setNotice && setNotice('Launching Akron Code installer…');
  };

  return (
    <>
      <div className="settings-card">
        <h3>App Auto-Update (GitHub Releases)</h3>
        <div className="env-prof-row">
          <div className="env-prof-meta">
            <span className="env-prof-title">Akron Code v{(upd && upd.currentVersion) || '1.0.0'}</span>
            <span className="env-prof-sub">
              {upd
                ? (upd.ok
                  ? (upd.updateAvailable ? `New version v${upd.latestVersion} available (${upd.asset?.name || 'package'})` : `Up to date (latest v${upd.latestVersion})`)
                  : (upd.error || 'Could not check releases'))
                : 'Checks GitHub Releases & verifies SHA-256 checksums (settings & chats preserved).'}
            </span>
          </div>
          <div className="env-prof-actions">
            <button type="button" className="btn-mini primary" disabled={!!updBusy} onClick={checkAppUpdate}>
              {updBusy === 'check' ? 'Checking…' : 'Check for Updates'}
            </button>
            {upd && upd.updateAvailable && upd.asset && !staged && (
              <button type="button" className="btn-mini" disabled={!!updBusy} onClick={downloadUpdate}>
                {updBusy === 'download' ? `Downloading ${updProg?.percent || 0}%` : 'Download & Verify'}
              </button>
            )}
            {staged && (
              <button type="button" className="btn-mini primary" onClick={installStagedUpdate}>
                Install v{upd?.latestVersion || ''}
              </button>
            )}
          </div>
        </div>
        {upd && upd.releaseNotes && (
          <pre className="bic-html" style={{ marginTop: 8 }}>{upd.releaseNotes.slice(0, 600)}</pre>
        )}
      </div>

      <div className="settings-card">
        <h3>Built-in Dependencies &amp; Optional LSP Servers</h3>
        {deps && (
          <p className="muted" style={{ marginTop: -4 }}>
            Core stack: <b>{deps.healthyCount}/{deps.totalBundled}</b> bundled modules healthy
          </p>
        )}
        <div className="env-prof-list">
          {((deps && deps.bundled) || []).map((b) => (
            <div key={b.id} className="env-prof-row">
              <div className="env-prof-meta">
                <span className="env-prof-title">{b.label}</span>
                <span className="env-prof-sub">{b.detail}</span>
              </div>
              <span className={'mc-pill ' + (b.ok ? 'done' : 'err')}>{b.ok ? 'Bundled' : 'Fallback'}</span>
            </div>
          ))}
        </div>

        <h4 style={{ margin: '16px 0 6px', fontSize: 13 }}>Optional Language Servers (LSP)</h4>
        <div className="env-prof-list">
          {((deps && deps.lspServers) || []).map((l) => (
            <div key={l.id} className="env-prof-row">
              <div className="env-prof-meta">
                <span className="env-prof-title">{l.label}</span>
                <span className="env-prof-sub">{l.languages} · {l.installed ? l.path : 'Not installed'}</span>
              </div>
              <div className="env-prof-actions">
                <button
                  type="button"
                  className={'btn-mini ' + (l.installed ? '' : 'primary')}
                  disabled={!!installingId}
                  onClick={() => installLsp(l.id)}
                >
                  {installingId === l.id ? 'Installing…' : (l.installed ? 'Repair / Update' : 'Auto-Install')}
                </button>
              </div>
            </div>
          ))}
        </div>
        {lspNote && <p className="muted" style={{ marginTop: 8 }}>{lspNote}</p>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Orchestrator pool — data-driven checklist
//
// The pool used to be free-text rows (#1 / URL / model / key / "+ Add
// provider"), which meant the user re-typed a provider that the app had
// already signed in and loaded. It is now a checklist of models this machine
// can actually serve: every signed-in subscription account's live catalog plus
// the local/API gateway the composer is pointed at. Ticking a row is the only
// way an entry enters `orchestrator.providers`, so the swarm roster can never
// name an endpoint that was never loaded. Subscription rows persist only
// `oauthProvider`; main resolves the bearer token per turn.
export function orchId(row) {
  return row.oauthProvider
    ? 'oauth|' + row.oauthProvider + '|' + row.model
    : 'gw|' + normBase(row.baseURL) + '|' + row.model;
}

export function OrchModelChecklist({ orchestrator, provider, localModels, localBase, paidProviders = [], saveOrch }) {
  const [cat, setCat] = useState({ status: null, models: {}, busy: false, error: '' });
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setCat((c) => ({ ...c, busy: true, error: '' }));
    let status = null;
    let error = '';
    try {
      const r = await window.autobot.providerStatus();
      if (r && r.ok && r.status) {
        status = r.status;
        if (r.status.storeError) error = String(r.status.storeError);
      } else {
        error = (r && (r.error || r.message)) || 'could not read provider status';
      }
    } catch (e) {
      error = String((e && e.message) || e);
    }
    const models = {};
    if (status) {
      for (const pv of status.providers || []) {
        const accounts = (pv.accounts || []).filter((a) => a.hasToken !== false);
        // Ask per account: plan tiers expose different model sets, and the
        // account key is what the turn will resolve against.
        const keys = accounts.length ? accounts.map((a) => pv.id + ':' + a.account) : [pv.id];
        for (const key of keys) {
          try {
            const r = await window.autobot.providerModels(key);
            if (r && r.ok && (r.models || []).length) models[key] = r.models;
          } catch (_) {}
        }
      }
    }
    setCat({ status, models, busy: false, error });
  }, []);

  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => {
    const out = [];
    const status = cat.status;
    if (status) {
      for (const pv of status.providers || []) {
        const accounts = (pv.accounts || []).filter((a) => a.hasToken !== false);
        for (const a of accounts) {
          const key = pv.id + ':' + a.account;
          const list = cat.models[key] || cat.models[pv.id] || pv.models || [];
          const rows = (list || []).map((m) => ({
            oauthProvider: key,
            transport: pv.transport || '',
            oauth: true,
            baseURL: '',
            apiKey: '',
            model: m.id,
            label: m.label || m.id,
            window: m.windowLabel || '',
            contextWindow: m.contextWindow || 0,
            name: (pv.label || pv.id) + ' · ' + (a.planName || a.plan || a.account) + ' · ' + (m.label || m.id),
          }));
          if (rows.length) {
            out.push({
              key,
              title: (pv.label || pv.id) + ' · ' + (a.planName || a.plan || a.account || ''),
              rows: rows.map((r) => ({ ...r, id: orchId(r) })),
            });
          }
        }
      }
    }
    // Paid & Custom API-key providers: strictly ONLY providers whose API key is configured.
    for (const pp of Array.isArray(paidProviders) ? paidProviders : []) {
      if (!pp || !pp.hasKey || !pp.baseURL) continue;
      const rows = (Array.isArray(pp.models) ? pp.models : []).map((m) => {
        const mid = String(m.id || m.model || m).trim();
        const win = Number(m.contextWindow) || contextWindowFor(mid);
        const winLabel = win >= 1000000 ? (Math.round(win / 100000) / 10 + 'M') : (win ? (Math.round(win / 1000) + 'K') : '');
        const row = {
          oauthProvider: '',
          transport: '',
          oauth: false,
          orchProviderId: pp.id,
          baseURL: pp.baseURL,
          apiKey: '',
          model: mid,
          label: m.label || mid,
          defaultTier: m.tier || 'heavy',
          window: winLabel,
          contextWindow: win,
          name: pp.name + ' · ' + (m.label || mid),
        };
        return { ...row, id: orchId(row) };
      }).filter((r) => r.model);
      if (rows.length) {
        out.push({
          key: 'paid:' + pp.id,
          title: pp.name + ' · Paid API',
          rows,
        });
      }
    }
    // Gateway + local models: whatever the composer is currently pointed at,
    // plus the models this machine's Ollama actually has pulled.
    const gw = [];
    const pb = normBase(provider && provider.baseURL);
    if (pb && !(provider && provider.oauthProvider) && provider.model) {
      gw.push({
        id: orchId({ baseURL: provider.baseURL, model: provider.model }),
        oauthProvider: '', transport: '', oauth: false,
        baseURL: provider.baseURL, apiKey: provider.apiKey || '',
        model: provider.model, label: provider.model,
        window: '', contextWindow: contextWindowFor(provider.model),
        name: 'Gateway · ' + provider.model,
      });
    }
    for (const m of localModels || []) {
      const base = localBase || 'http://localhost:11434/v1';
      const row = {
        id: orchId({ baseURL: base, model: m.name }),
        oauthProvider: '', transport: '', oauth: false,
        baseURL: base, apiKey: '',
        model: m.name, label: m.name,
        window: '', contextWindow: 0,
        name: 'Ollama · ' + m.name,
      };
      if (!gw.some((g) => g.id === row.id)) gw.push(row);
    }
    if (gw.length) out.push({ key: 'gateway', title: 'Local / API gateway', rows: gw });
    return out;
  }, [cat, provider, localModels, localBase, paidProviders]);

  // Rows saved before ids existed get a derived one, so they key, toggle and
  // re-tier individually (an undefined id used to match — and remove — them all).
  const entries = useMemo(() => (orchestrator.providers || []).map((p, i) => (p && p.id ? p : { ...p, id: (p && (p.model || p.baseURL || p.oauthProvider)) ? orchId(p || {}) : 'legacy|' + i })), [orchestrator.providers]);
  const byId = useMemo(() => new Map(entries.map((p) => [p.id, p])), [entries]);
  const known = new Set();
  for (const g of groups) for (const r of g.rows) known.add(r.id);
  // Entries saved before this panel existed (free-text baseURL rows) must stay
  // visible and removable instead of vanishing behind the new checklist.
  const legacy = entries.filter((p) => !known.has(p.id));

  const toggle = (row, on) => {
    const cur = entries;
    if (on) {
      if (cur.some((p) => p.id === row.id)) return;
      const entry = {
        id: row.id,
        name: row.name,
        baseURL: row.baseURL || '',
        apiKey: row.apiKey || '',
        orchProviderId: row.orchProviderId || '',
        model: row.model,
        tier: row.defaultTier || 'heavy',
        oauth: !!row.oauth,
        oauthProvider: row.oauthProvider || '',
        transport: row.transport || '',
        contextWindow: row.contextWindow || 0,
      };
      const ai = orchestrator.activeIndex;
      saveOrch({ ...orchestrator, providers: [...cur, entry], activeIndex: cur.length && ai >= 0 && ai < cur.length ? ai : 0 });
    } else {
      const next = cur.filter((p) => p.id !== row.id);
      // Re-anchor 'start' on the same model: removing a row above it used to
      // shift the index and silently move the start marker to another model.
      const startId = cur[orchestrator.activeIndex] ? cur[orchestrator.activeIndex].id : null;
      let ai = startId ? next.findIndex((p) => p.id === startId) : -1;
      if (ai < 0) ai = next.length ? 0 : -1;
      saveOrch({ ...orchestrator, providers: next, activeIndex: ai });
    }
  };
  const setTier = (id, tier) => saveOrch({ ...orchestrator, providers: entries.map((p) => (p.id === id ? { ...p, tier } : p)) });
  const setActive = (id) => saveOrch({ ...orchestrator, activeIndex: entries.findIndex((p) => p.id === id) });

  const query = q.trim().toLowerCase();
  const match = (r) => !query || String(r.model).toLowerCase().includes(query) || String(r.name).toLowerCase().includes(query);
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const picked = entries.length;

  return (
    <div className="orch-pool">
      <div className="orch-pool-head">
        <span className="orch-count">{picked} of {total} selected</span>
        <input className="orch-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter models…" />
        <button type="button" className="btn-mini" disabled={cat.busy} onClick={load}>
          <Icon name="Refresh" size={12} /> {cat.busy ? 'Loading…' : 'Reload'}
        </button>
      </div>
      {cat.error && <p className="muted orch-err">{cat.error}</p>}
      {!cat.busy && total === 0 && (
        <p className="muted">Nothing loadable yet. Sign in to a provider under Accounts, or point the composer at a gateway, then press Reload.</p>
      )}
      {groups.map((g) => {
        const rows = g.rows.filter(match);
        if (!rows.length) return null;
        return (
          <div key={g.key} className="orch-grp">
            <div className="orch-grp-head">{g.title}</div>
            {rows.map((r) => {
              const entry = byId.get(r.id);
              const on = !!entry;
              return (
                <div key={r.id} className={'orch-row' + (on ? ' on' : '')}>
                  <label className="orch-check" title={r.name}>
                    <input type="checkbox" checked={on} onChange={(e) => toggle(r, e.target.checked)} />
                    <span className="orch-name">{r.label}</span>
                    {r.window ? <span className="orch-win">{r.window}</span> : null}
                  </label>
                  {on && (
                    <>
                      <select className="orch-tier" value={entry.tier || 'heavy'} onChange={(e) => setTier(r.id, e.target.value)} title="Complexity tier this model serves">
                        <option value="small">small</option>
                        <option value="heavy">heavy</option>
                        <option value="critical">critical</option>
                      </select>
                      <label className="orch-radio" title="Start here (failover order + supervisor)">
                        <input type="radio" name="orch-active" checked={entries.indexOf(entry) === orchestrator.activeIndex} onChange={() => setActive(r.id)} /> start
                      </label>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {legacy.length > 0 && (
        <div className="orch-grp">
          <div className="orch-grp-head">Saved earlier</div>
          {legacy.map((p) => (
            <div key={p.id} className="orch-row on">
              <label className="orch-check" title={p.name || p.model}>
                <input type="checkbox" checked onChange={() => toggle({ id: p.id }, false)} />
                <span className="orch-name">{p.model || p.baseURL}</span>
                <span className="orch-win">{p.baseURL ? normBase(p.baseURL).replace(/^https?:\/\//, '') : p.oauthProvider}</span>
              </label>
              <select className="orch-tier" value={p.tier || 'heavy'} onChange={(e) => setTier(p.id, e.target.value)}>
                <option value="small">small</option>
                <option value="heavy">heavy</option>
                <option value="critical">critical</option>
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Role pools (orchestrator.pools) ----------
// One failover list per role, routed through a single OpenAI-compatible gateway.
// Edited as text — one model per line, `model-id @N` caps that model at N
// concurrent calls — and stored as `{ model, max }` objects.
export const POOL_ROLES = [
  { id: 'planner', label: 'Planner / Reasoner' },
  { id: 'coder', label: 'Implementer / Coder' },
  { id: 'vision', label: 'Vision' },
  { id: 'fast', label: 'Fast' },
  { id: 'longctx', label: 'Long context' },
  { id: 'image_gen', label: 'Image Gen' },
  { id: 'video_gen', label: 'Video Gen' },
  { id: 'audio_speech', label: 'Audio / TTS' },
];

export function parsePoolModels(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(.*?)\s*@\s*(\d+)\s*$/);
    const model = (m ? m[1] : line).trim();
    if (!model) continue;
    const max = m ? parseInt(m[2], 10) : 0;
    out.push(max > 0 ? { model, max } : { model });
  }
  return out;
}

export function serializePoolModels(models) {
  return (Array.isArray(models) ? models : [])
    .map((e) => (typeof e === 'string' ? { model: e } : e || {}))
    .filter((e) => e.model)
    .map((e) => e.model + (Number(e.max) > 0 ? ' @' + Number(e.max) : ''))
    .join('\n');
}

export function RolePoolsEditor({ orchestrator, saveOrch }) {
  const pools = (orchestrator && orchestrator.pools) || {};
  const roles = pools.roles || {};
  const gateway = pools.gateway || {};
  // Textareas keep their own text while focused so typing is never reformatted;
  // they commit (parse → save) on blur.
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [health, setHealth] = useState(null);

  useEffect(() => {
    if (!pools.enabled || !window.autobot || !window.autobot.poolStatus) { setHealth(null); return undefined; }
    let alive = true;
    const poll = async () => {
      try {
        const res = await window.autobot.poolStatus();
        if (alive && res) setHealth(res);
      } catch (_) {}
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [pools.enabled, orchestrator]);

  const rowByModel = useMemo(() => {
    const m = new Map();
    for (const r of (health && health.rows) || []) {
      if (r && r.model && !m.has(r.model)) m.set(r.model, r);
    }
    return m;
  }, [health]);

  const savePools = (patch) => {
    const next = { enabled: !!pools.enabled, gateway: { baseURL: gateway.baseURL || '', apiKey: gateway.apiKey || '' }, roles: { ...roles }, ...pools, ...patch };
    saveOrch({ ...orchestrator, pools: next });
  };
  const saveRole = (id, patch) => {
    const def = POOL_ROLES.find((r) => r.id === id);
    const cur = roles[id] || { label: def ? def.label : id, models: [] };
    savePools({ roles: { ...roles, [id]: { ...cur, ...patch } } });
  };
  const commitText = (id) => {
    if (drafts[id] === undefined) return;
    const models = parsePoolModels(drafts[id]);
    setDrafts((d) => { const n = { ...d }; delete n[id]; return n; });
    saveRole(id, { models });
  };
  const loadPreset = async () => {
    if (!window.autobot || !window.autobot.poolsPreset) { setNote('Preset unavailable in this build.'); return; }
    setBusy(true);
    setNote('');
    try {
      const preset = await window.autobot.poolsPreset();
      if (!preset || typeof preset !== 'object' || !preset.roles) { setNote('The preset came back empty.'); return; }
      setDrafts({});
      saveOrch({ ...orchestrator, pools: { ...preset, enabled: preset.enabled !== false } });
      setNote('FreeLLMAPI preset loaded.');
    } catch (e) {
      setNote('Could not load the preset: ' + String((e && e.message) || e).slice(0, 160));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pools-ed">
      <div className="pools-top">
        <label className="pools-toggle">
          <input type="checkbox" checked={!!pools.enabled} onChange={(e) => savePools({ enabled: e.target.checked })} />
          <span>Enable role pools</span>
        </label>
        <button type="button" className="btn-mini" disabled={busy} onClick={loadPreset}>
          <Icon name="Download" size={12} /> {busy ? 'Loading…' : 'Load FreeLLMAPI preset'}
        </button>
      </div>
      <p className="muted pools-help">
        Pools apply only when the session provider is this gateway. Each role fails over downward; the swarm
        supervisor uses Planner, workers use Coder, images use Vision, compaction/titles use Fast, oversized
        prompts use Long context.
      </p>
      {note && <p className="muted pools-note">{note}</p>}
      <div className="pools-gw">
        <label className="pools-field pools-grow">
          <span>Gateway base URL</span>
          <input
            key={'gw-url|' + (gateway.baseURL || '')}
            defaultValue={gateway.baseURL || ''}
            placeholder="http://127.0.0.1:3001/v1"
            spellCheck={false}
            onBlur={(e) => { const v = e.target.value.trim(); if (v !== (gateway.baseURL || '')) savePools({ gateway: { ...gateway, baseURL: v } }); }}
          />
        </label>
        <label className="pools-field pools-key">
          <span>Key (optional)</span>
          <input
            key={'gw-key|' + (gateway.apiKey ? 'set' : '')}
            type="password"
            defaultValue={gateway.apiKey || ''}
            placeholder="reuse session key"
            onBlur={(e) => { const v = e.target.value.trim(); if (v !== (gateway.apiKey || '')) savePools({ gateway: { ...gateway, apiKey: v } }); }}
          />
        </label>
      </div>
      <div className="pools-roles">
        {POOL_ROLES.map((r) => {
          const role = roles[r.id] || {};
          const text = drafts[r.id] !== undefined ? drafts[r.id] : serializePoolModels(role.models);
          const lines = Math.max(2, Math.min(6, text.split('\n').length));
          return (
            <div key={r.id} className="pools-role">
              <div className="pools-role-head">
                <span className="pools-role-name">{role.label || r.label}</span>
                <span className="pools-role-id">{r.id}</span>
                <label className="pools-field pools-max" title="Max parallel calls for this role">
                  <span>max parallel</span>
                  <input
                    type="number"
                    min="1"
                    max="64"
                    value={role.maxConcurrent != null ? role.maxConcurrent : ''}
                    placeholder="—"
                    onChange={(e) => { const n = parseInt(e.target.value, 10); saveRole(r.id, { maxConcurrent: Number.isFinite(n) && n > 0 ? n : undefined }); }}
                  />
                </label>
              </div>
              <textarea
                className="pools-models"
                rows={lines}
                spellCheck={false}
                value={text}
                placeholder={'model-id @2\nfallback-model'}
                onChange={(e) => { const v = e.target.value; setDrafts((d) => ({ ...d, [r.id]: v })); }}
                onBlur={() => commitText(r.id)}
              />
              {pools.enabled && (role.models || []).length > 0 && (
                <div className="pools-health">
                  {(role.models || []).map((entry, idx) => {
                    const mid = typeof entry === 'string' ? entry.split('@')[0].trim() : entry.model;
                    if (!mid) return null;
                    const st = rowByModel.get(mid);
                    const cls = st && st.dead ? 'dead' : (st && st.coolingMs > 0 ? 'cooling' : 'ok');
                    const meta = st && st.dead ? 'dead'
                      : (st && st.coolingMs > 0 ? `${Math.ceil(st.coolingMs / 1000)}s` : (st && st.inflight > 0 ? `${st.inflight} active` : 'ready'));
                    return (
                      <span key={mid + ':' + idx} className={'pools-chip ' + cls} title={st && st.deadWhy ? st.deadWhy : mid}>
                        <span className="pools-chip-dot" />
                        <span>{mid}</span>
                        <span className="pools-chip-meta">{meta}</span>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function EnvironmentsSection({ envState, refreshEnvState, onSwitchEnvironment, setError, setNotice, cwd }) {
  const [sshDraft, setSshDraft] = useState({ name: '', host: '', port: 22, username: '', identityFile: '', remoteCwd: '', secret: '' });
  const [remDraft, setRemDraft] = useState({ name: '', url: '', token: '', remoteCwd: '' });
  const [busy, setBusy] = useState('');
  const [statusOut, setStatusOut] = useState('');
  const [remoteWsList, setRemoteWsList] = useState([]);
  const [hostTokenShown, setHostTokenShown] = useState('');

  const active = (envState && envState.active) || { kind: 'local', label: 'This Computer' };
  const sshProfiles = (envState && envState.sshProfiles) || [];
  const sshConfigHosts = (envState && envState.sshConfigHosts) || [];
  const remoteProfiles = (envState && envState.remoteProfiles) || [];
  const hostServer = (envState && envState.hostServer) || {};

  const saveSsh = async (e) => {
    e && e.preventDefault();
    if (!sshDraft.host.trim()) return;
    setBusy('save-ssh');
    try {
      const r = await window.autobot.envSaveSsh(sshDraft);
      if (r && r.ok) {
        setSshDraft({ name: '', host: '', port: 22, username: '', identityFile: '', remoteCwd: '', secret: '' });
        setStatusOut(`Saved SSH host "${r.profile.name}". Passphrase/password stored in encrypted keychain.`);
        refreshEnvState && refreshEnvState();
      } else setStatusOut((r && r.error) || 'Failed to save SSH host');
    } finally { setBusy(''); }
  };

  const runTestSsh = async (profOrId) => {
    setBusy('test-ssh');
    setStatusOut('Testing SSH connection…');
    try {
      const r = await window.autobot.envTestSsh(profOrId);
      if (r && r.ok) setStatusOut(`✅ SSH connected in ${r.latencyMs}ms · ${r.uname} · pwd: ${r.remoteCwd}`);
      else setStatusOut(`❌ SSH failed (${r?.latencyMs || 0}ms): ${r?.error || 'unknown error'}`);
    } finally { setBusy(''); }
  };

  const saveRemote = async (e) => {
    e && e.preventDefault();
    if (!remDraft.url.trim()) return;
    setBusy('save-rem');
    try {
      const r = await window.autobot.envSaveRemote(remDraft);
      if (r && r.ok) {
        setRemDraft({ name: '', url: '', token: '', remoteCwd: '' });
        setStatusOut(`Saved Remote Server "${r.profile.name}". Auth token encrypted in secret store.`);
        refreshEnvState && refreshEnvState();
      } else setStatusOut((r && r.error) || 'Failed to save Remote Server');
    } finally { setBusy(''); }
  };

  const runTestRemote = async (profOrId) => {
    setBusy('test-rem');
    setStatusOut('Testing Remote Server connection…');
    try {
      const r = await window.autobot.envTestRemote(profOrId);
      if (r && r.ok) {
        setRemoteWsList(r.workspaces || []);
        setStatusOut(`✅ Remote Server ready in ${r.latencyMs}ms · ${r.hostname} (${r.platform}) · ${r.workspaces?.length || 0} workspace(s)`);
      } else {
        setStatusOut(`❌ Remote Server failed (${r?.latencyMs || 0}ms): ${r?.error || 'unreachable'}`);
      }
    } finally { setBusy(''); }
  };

  const toggleHostSrv = async () => {
    setBusy('host-srv');
    try {
      const r = await window.autobot.envToggleHostServer(!hostServer.running, { workspaceRoot: cwd || undefined });
      if (r && r.token) setHostTokenShown(r.token);
      setStatusOut(r && r.running ? `✅ Remote Server host listening at ${r.url}` : 'Host Remote Server stopped');
      refreshEnvState && refreshEnvState();
    } finally { setBusy(''); }
  };

  return (
    <>
      <div className="settings-card">
        <h3>Active Execution Environment</h3>
        <div className={'env-prof-row' + (active.kind !== 'local' ? ' active' : '')}>
          <div className="env-prof-meta">
            <span className="env-prof-title">{active.label || 'This Computer'}</span>
            <span className="env-prof-sub">Mode: {active.kind} · Workspace: {active.cwd || cwd || '~'} · Secrets: {envState?.secretStatus?.backend || 'safeStorage'}</span>
          </div>
          <div className="env-prof-actions">
            {active.kind !== 'local' && (
              <button type="button" className="btn-mini primary" onClick={() => onSwitchEnvironment({ kind: 'local' })}>
                Switch to This Computer
              </button>
            )}
          </div>
        </div>
        {statusOut && <p className="muted" style={{ marginTop: 10 }}>{statusOut}</p>}
      </div>

      <div className="settings-card">
        <h3>SSH Hosts</h3>
        <form onSubmit={saveSsh}>
          <div className="row">
            <label>Display name<input value={sshDraft.name} onChange={(e) => setSshDraft({ ...sshDraft, name: e.target.value })} placeholder="prod-gpu" /></label>
            <label>Hostname / IP<input value={sshDraft.host} onChange={(e) => setSshDraft({ ...sshDraft, host: e.target.value })} placeholder="192.168.1.50" /></label>
          </div>
          <div className="row">
            <label>Username<input value={sshDraft.username} onChange={(e) => setSshDraft({ ...sshDraft, username: e.target.value })} placeholder="ubuntu" /></label>
            <label>Port<input type="number" value={sshDraft.port} onChange={(e) => setSshDraft({ ...sshDraft, port: Number(e.target.value) || 22 })} /></label>
          </div>
          <div className="row">
            <label>Identity key path (optional)<input value={sshDraft.identityFile} onChange={(e) => setSshDraft({ ...sshDraft, identityFile: e.target.value })} placeholder="~/.ssh/id_ed25519" /></label>
            <label>Remote workspace path<input value={sshDraft.remoteCwd} onChange={(e) => setSshDraft({ ...sshDraft, remoteCwd: e.target.value })} placeholder="/home/ubuntu/app" /></label>
          </div>
          <label>Password / key passphrase (stored encrypted in OS keychain)
            <input type="password" value={sshDraft.secret} onChange={(e) => setSshDraft({ ...sshDraft, secret: e.target.value })} placeholder="Optional when using SSH key or agent" />
          </label>
          <div className="row-actions" style={{ marginTop: 6 }}>
            <button type="submit" className="btn-mini primary" disabled={!sshDraft.host.trim() || busy === 'save-ssh'}>Save SSH Host</button>
            <button type="button" className="btn-mini" disabled={!sshDraft.host.trim() || busy === 'test-ssh'} onClick={() => runTestSsh(sshDraft)}>Test Connection</button>
          </div>
        </form>

        {(sshProfiles.length > 0 || sshConfigHosts.length > 0) && (
          <div className="env-prof-list">
            {[...sshProfiles, ...sshConfigHosts].map((p) => {
              const isAct = active.kind === 'ssh' && active.id === p.id;
              return (
                <div key={p.id} className={'env-prof-row' + (isAct ? ' active' : '')}>
                  <div className="env-prof-meta">
                    <span className="env-prof-title">{p.name} {p.source === 'ssh-config' ? '(~/.ssh/config)' : ''}</span>
                    <span className="env-prof-sub">{p.username ? `${p.username}@` : ''}{p.host}:{p.port} {p.remoteCwd ? `· ${p.remoteCwd}` : ''}</span>
                  </div>
                  <div className="env-prof-actions">
                    <button type="button" className="btn-mini" onClick={() => runTestSsh(p.id)}>Test</button>
                    <button
                      type="button"
                      className={'btn-mini ' + (isAct ? '' : 'primary')}
                      onClick={() => onSwitchEnvironment(isAct ? { kind: 'local' } : { kind: 'ssh', id: p.id, cwd: p.remoteCwd || '' })}
                    >
                      {isAct ? 'Disconnect' : 'Connect'}
                    </button>
                    {p.source !== 'ssh-config' && (
                      <button type="button" className="btn-mini" onClick={async () => { await window.autobot.envDeleteSsh(p.id); refreshEnvState && refreshEnvState(); }}>Delete</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="settings-card">
        <h3>Remote Servers</h3>
        <form onSubmit={saveRemote}>
          <div className="row">
            <label>Server name<input value={remDraft.name} onChange={(e) => setRemDraft({ ...remDraft, name: e.target.value })} placeholder="Akron Cloud Runner" /></label>
            <label>Server URL<input value={remDraft.url} onChange={(e) => setRemDraft({ ...remDraft, url: e.target.value })} placeholder="http://127.0.0.1:9477" /></label>
          </div>
          <div className="row">
            <label>Auth Bearer token (stored encrypted)<input type="password" value={remDraft.token} onChange={(e) => setRemDraft({ ...remDraft, token: e.target.value })} placeholder="Bearer token" /></label>
            <label>Remote workspace path<input value={remDraft.remoteCwd} onChange={(e) => setRemDraft({ ...remDraft, remoteCwd: e.target.value })} placeholder="/workspace/project" /></label>
          </div>
          <div className="row-actions" style={{ marginTop: 6 }}>
            <button type="submit" className="btn-mini primary" disabled={!remDraft.url.trim() || busy === 'save-rem'}>Save Remote Server</button>
            <button type="button" className="btn-mini" disabled={!remDraft.url.trim() || busy === 'test-rem'} onClick={() => runTestRemote(remDraft)}>Test Connection</button>
          </div>
        </form>

        {remoteWsList.length > 0 && (
          <div className="row" style={{ marginTop: 10 }}>
            <label>Discovered remote workspaces
              <select value={remDraft.remoteCwd} onChange={(e) => setRemDraft({ ...remDraft, remoteCwd: e.target.value })}>
                <option value="">Select workspace…</option>
                {remoteWsList.map((w) => <option key={w.path} value={w.path}>{w.name} ({w.path})</option>)}
              </select>
            </label>
          </div>
        )}

        {remoteProfiles.length > 0 && (
          <div className="env-prof-list">
            {remoteProfiles.map((r) => {
              const isAct = active.kind === 'remote' && active.id === r.id;
              return (
                <div key={r.id} className={'env-prof-row' + (isAct ? ' active' : '')}>
                  <div className="env-prof-meta">
                    <span className="env-prof-title">{r.name}</span>
                    <span className="env-prof-sub">{r.url} {r.remoteCwd ? `· ${r.remoteCwd}` : ''}</span>
                  </div>
                  <div className="env-prof-actions">
                    <button type="button" className="btn-mini" onClick={() => runTestRemote(r.id)}>Test</button>
                    <button
                      type="button"
                      className={'btn-mini ' + (isAct ? '' : 'primary')}
                      onClick={() => onSwitchEnvironment(isAct ? { kind: 'local' } : { kind: 'remote', id: r.id, cwd: r.remoteCwd || '' })}
                    >
                      {isAct ? 'Disconnect' : 'Connect'}
                    </button>
                    <button type="button" className="btn-mini" onClick={async () => { await window.autobot.envDeleteRemote(r.id); refreshEnvState && refreshEnvState(); }}>Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="settings-card">
        <h3>Host Akron Remote Server on This Machine</h3>
        <p className="muted">Expose this computer&apos;s workspace over an encrypted-token HTTP/WebSocket endpoint on port {hostServer.port || 9477}.</p>
        <div className="row-actions">
          <button type="button" className={'btn-mini ' + (hostServer.running ? '' : 'primary')} onClick={toggleHostSrv}>
            {hostServer.running ? 'Stop Remote Host' : 'Start Remote Host'}
          </button>
          {hostServer.running && (
            <button
              type="button"
              className="btn-mini"
              onClick={async () => {
                const tok = hostTokenShown || (await window.autobot.envGetHostToken());
                if (tok) { navigator.clipboard?.writeText(tok).catch(() => {}); setNotice && setNotice('Remote host token copied'); }
              }}
            >
              Copy Auth Token
            </button>
          )}
        </div>
      </div>
    </>
  );
}


export function PermissionRulesSection({ cwd, setNotice }) {
  const [perms, setPerms] = useState({ allow: [], deny: [], ask: [], customRules: [] });
  const [ruleInput, setRuleInput] = useState('');
  const [ruleList, setRuleList] = useState('allow');
  const [customLabel, setCustomLabel] = useState('');
  const [customPattern, setCustomPattern] = useState('');
  const [customMode, setCustomMode] = useState('ask');
  const [ledgerStatus, setLedgerStatus] = useState(null);
  const [ledgerEntries, setLedgerEntries] = useState([]);
  const [busy, setBusy] = useState(false);

  const loadRules = useCallback(async () => {
    try {
      if (window.autobot && window.autobot.getPermissions) {
        const res = await window.autobot.getPermissions(cwd);
        if (res) setPerms({ allow: res.allow || [], deny: res.deny || [], ask: res.ask || [], customRules: res.customRules || [] });
      }
      if (window.autobot && window.autobot.listAuditLedger) {
        const entries = await window.autobot.listAuditLedger(12);
        if (Array.isArray(entries)) setLedgerEntries(entries);
      }
    } catch (_) {}
  }, [cwd]);

  useEffect(() => { loadRules(); }, [loadRules]);

  const handleAdd = async () => {
    const clean = ruleInput.trim();
    if (!clean || !window.autobot?.addPermissionRule) return;
    setBusy(true);
    try {
      const res = await window.autobot.addPermissionRule({ rule: clean, list: ruleList });
      if (res && res.ok) {
        setRuleInput('');
        await loadRules();
        setNotice && setNotice(`Saved permission rule: ${clean}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (rule, list) => {
    if (!window.autobot?.removePermissionRule) return;
    setBusy(true);
    try {
      await window.autobot.removePermissionRule({ rule, list });
      await loadRules();
    } finally {
      setBusy(false);
    }
  };

  const handleSaveCustom = async () => {
    if (!customPattern.trim() || !window.autobot?.saveCustomRule) return;
    setBusy(true);
    try {
      const r = await window.autobot.saveCustomRule({ label: customLabel.trim() || customPattern.trim(), pattern: customPattern.trim(), mode: customMode });
      if (r && r.ok) {
        setCustomLabel('');
        setCustomPattern('');
        await loadRules();
        setNotice && setNotice(`Saved custom rule: ${r.rule.label}`);
      }
    } finally { setBusy(false); }
  };

  const handleInstallStarter = async () => {
    if (!window.autobot?.installStarterRules) return;
    setBusy(true);
    try {
      const r = await window.autobot.installStarterRules();
      if (r && r.ok) {
        await loadRules();
        setNotice && setNotice(`Installed ${r.installed} Safe Starter Pack rules`);
      }
    } finally { setBusy(false); }
  };

  const handleVerifyLedger = async () => {
    if (!window.autobot?.verifyAuditLedger) return;
    const res = await window.autobot.verifyAuditLedger();
    setLedgerStatus(res);
  };

  const CUSTOM_MODE_LABELS = {
    auto: 'Take action without asking',
    explicit: 'Take action when you say so',
    ask: 'Ask before taking action',
    handoff: 'Hand off to you',
  };

  const groups = [
    { key: 'allow', label: 'Always Allow', rules: perms.allow || [], badge: 'allow' },
    { key: 'ask', label: 'Always Ask', rules: perms.ask || [], badge: 'ask' },
    { key: 'deny', label: 'Always Deny', rules: perms.deny || [], badge: 'deny' },
  ];

  return (
    <div className="perm-rules-card">
      <div className="perm-rules-head">
        <div>
          <h3><Icon name="LockShield" size={14} /> Custom Rules &amp; Guardrails</h3>
          <p className="muted">4-tier autonomous action policy + Safe Starter Pack + scoped rules in <code>~/.autobot/settings.json</code>.</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn-mini primary" onClick={handleInstallStarter} disabled={busy} data-testid="install-starter-pack-btn">
            Install Safe Starter Pack
          </button>
          <button type="button" className="btn-subtle" onClick={loadRules} disabled={busy}>Refresh</button>
        </div>
      </div>

      <div className="perm-rules-add-row" style={{ marginBottom: 10 }}>
        <input
          type="text"
          value={customLabel}
          onChange={(e) => setCustomLabel(e.target.value)}
          placeholder="Rule label (e.g. Deploy script)"
          aria-label="Custom rule label"
        />
        <input
          type="text"
          value={customPattern}
          onChange={(e) => setCustomPattern(e.target.value)}
          placeholder="Tool/Pattern (e.g. Bash(git push:*) or POST)"
          aria-label="Custom rule pattern"
        />
        <select value={customMode} onChange={(e) => setCustomMode(e.target.value)} aria-label="Custom rule mode">
          <option value="auto">Take action without asking</option>
          <option value="explicit">Take action when you say so</option>
          <option value="ask">Ask before taking action</option>
          <option value="handoff">Hand off to you</option>
        </select>
        <button type="button" className="primary" onClick={handleSaveCustom} disabled={busy || !customPattern.trim()}>
          Save Policy
        </button>
      </div>

      {(perms.customRules || []).length > 0 && (
        <div className="perm-rules-list" style={{ marginBottom: 12 }}>
          {(perms.customRules || []).map((cr) => (
            <div key={cr.id || cr.pattern} className={`perm-rule-chip kind-${cr.mode === 'handoff' ? 'deny' : cr.mode === 'auto' ? 'allow' : 'ask'}`}>
              <span><b>{cr.label || cr.pattern}</b> · <code>{cr.pattern}</code> · {CUSTOM_MODE_LABELS[cr.mode] || cr.mode}</span>
              <button
                type="button"
                className="perm-rule-del"
                onClick={() => window.autobot?.deleteCustomRule && window.autobot.deleteCustomRule({ id: cr.id, pattern: cr.pattern }).then(loadRules)}
                title="Remove custom rule"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="perm-rules-add-row">
        <select value={ruleList} onChange={(e) => setRuleList(e.target.value)} aria-label="Rule list">
          <option value="allow">Allow</option>
          <option value="ask">Ask</option>
          <option value="deny">Deny</option>
        </select>
        <input
          type="text"
          value={ruleInput}
          onChange={(e) => setRuleInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
          placeholder="e.g. Bash(lsof:*) or Edit(src/**) or mcp__rea__inspect_analysis_view"
          aria-label="New permission rule"
        />
        <button type="button" className="primary" onClick={handleAdd} disabled={busy || !ruleInput.trim()}>
          Add Rule
        </button>
      </div>

      <div className="perm-rules-groups">
        {groups.map((g) => (
          <div key={g.key} className="perm-rules-group">
            <div className="perm-rules-group-label">{g.label} <span>({g.rules.length})</span></div>
            {g.rules.length === 0 ? (
              <div className="perm-rules-empty">No {g.key} rules configured.</div>
            ) : (
              <div className="perm-rules-list">
                {g.rules.map((r) => (
                  <div key={`${g.key}:${r}`} className={`perm-rule-chip kind-${g.badge}`}>
                    <code>{r}</code>
                    <button
                      type="button"
                      className="perm-rule-del"
                      onClick={() => handleRemove(r, g.key)}
                      title={`Remove ${r}`}
                      aria-label={`Remove rule ${r}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(128,128,128,0.18)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div>
            <strong>Hash-Chained Audit Ledger</strong>
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}><code>~/.autobot/audit-ledger.jsonl</code></span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {ledgerStatus && (
              <span className={`pill ${ledgerStatus.ok ? 'ok' : 'bad'}`} data-testid="audit-ledger-status">
                {ledgerStatus.ok ? `Verified (${ledgerStatus.entries} entries)` : `Integrity Fail (#${ledgerStatus.brokenAt})`}
              </span>
            )}
            <button type="button" className="btn-mini" onClick={handleVerifyLedger} data-testid="verify-audit-ledger-btn">
              Verify Audit Ledger
            </button>
          </div>
        </div>
        {ledgerEntries.length > 0 && (
          <div style={{ fontSize: 11, fontFamily: 'var(--mono-font, monospace)', opacity: 0.8, maxHeight: 96, overflowY: 'auto' }}>
            {ledgerEntries.slice(0, 5).map((e) => (
              <div key={e.seq}>#{e.seq} {e.ts} [{e.event?.type || 'event'}] {e.event?.tool || ''} → {String(e.hash || '').slice(0, 14)}…</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function QuietHoursSection({ setNotice }) {
  const [qh, setQh] = useState({ enabled: false, start: '22:00', end: '08:00' });
  useEffect(() => {
    (async () => {
      try {
        if (window.autobot && window.autobot.proactiveState) {
          const st = await window.autobot.proactiveState();
          if (st && st.quietHours) setQh(st.quietHours);
        }
      } catch (_) {}
    })();
  }, []);
  const saveQh = async (patch) => {
    const next = { ...qh, ...patch };
    setQh(next);
    try {
      if (window.autobot && window.autobot.setQuietHours) {
        await window.autobot.setQuietHours(next);
        setNotice && setNotice(`Quiet hours ${next.enabled ? 'enabled' : 'disabled'}`);
      }
    } catch (_) {}
  };
  return (
    <div>
      <h3 className="oc-sec-title">Proactive Quiet Hours</h3>
      <div className="oc-group">
        <div className="oc-row">
          <div className="oc-row-meta">
            <div className="oc-row-title">Hold overnight proactive nudges</div>
            <div className="oc-row-sub">Suppress non-urgent notifications during quiet hours; high-impact imminent deadlines still notify.</div>
          </div>
          <div className="oc-row-ctrl">
            <button
              type="button"
              role="switch"
              aria-checked={!!qh.enabled}
              className={'oc-switch' + (qh.enabled ? ' on' : '')}
              onClick={() => saveQh({ enabled: !qh.enabled })}
            >
              <span className="oc-switch-knob" />
            </button>
          </div>
        </div>
        <div className="oc-row">
          <div className="oc-row-meta">
            <div className="oc-row-title">Schedule window</div>
            <div className="oc-row-sub">Local wall-clock start and end times</div>
          </div>
          <div className="oc-row-ctrl" style={{ gap: 8 }}>
            <input type="time" value={qh.start || '22:00'} onChange={(e) => saveQh({ start: e.target.value })} />
            <span className="muted">to</span>
            <input type="time" value={qh.end || '08:00'} onChange={(e) => saveQh({ end: e.target.value })} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function MobilePushSection({ setNotice }) {
  const [cfg, setCfg] = useState({ enabled: false, ntfy: { enabled: false, topicUrl: '' }, telegram: { enabled: false, botToken: '', chatId: '' }, webhook: { enabled: false, url: '' }, pairedDevices: [] });
  const [pairInfo, setPairInfo] = useState(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    (async () => {
      try {
        if (window.autobot && window.autobot.pushGetConfig) {
          const c = await window.autobot.pushGetConfig();
          if (c) setCfg(c);
        }
      } catch (_) {}
    })();
  }, []);

  const savePatch = async (patch) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    try {
      if (window.autobot && window.autobot.pushSaveConfig) {
        const r = await window.autobot.pushSaveConfig(patch);
        if (r && r.config) setCfg(r.config);
        setNotice && setNotice('Updated mobile push settings');
      }
    } catch (_) {}
  };

  const genPairing = async () => {
    if (!window.autobot || !window.autobot.pushStartPairing) return;
    const r = await window.autobot.pushStartPairing();
    if (r && r.ok) setPairInfo(r);
  };

  const testPush = async () => {
    if (!window.autobot || !window.autobot.pushTest) return;
    const r = await window.autobot.pushTest();
    setStatus(r && r.ok ? '✅ Test push dispatched' : `⚠ ${(r && (r.error || r.skipped)) || 'No active push endpoint'}`);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        <h3 className="oc-sec-title" style={{ margin: 0 }}>Mobile Push Channels (ntfy · Telegram · Webhook)</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn-mini" onClick={genPairing}>6-Digit Pairing Code</button>
          <button type="button" className="btn-mini" onClick={testPush}>Test Push</button>
        </div>
      </div>
      {pairInfo && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          One-time pairing code: <strong><code>{pairInfo.code}</code></strong> (valid 10 min · supports remote <code>approve &lt;shortId&gt;</code> / <code>deny &lt;shortId&gt;</code>)
        </div>
      )}
      {status && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{status}</div>}
      <div className="oc-group">
        <div className="oc-row">
          <div className="oc-row-meta">
            <div className="oc-row-title">Enable Mobile Push Alerts</div>
            <div className="oc-row-sub">Deliver rate-limited permission, long-run (&ge;30s), and stuck-session alerts cleanly.</div>
          </div>
          <div className="oc-row-ctrl">
            <button type="button" role="switch" aria-checked={!!cfg.enabled} className={'oc-switch' + (cfg.enabled ? ' on' : '')} onClick={() => savePatch({ enabled: !cfg.enabled })}>
              <span className="oc-switch-knob" />
            </button>
          </div>
        </div>
        <div className="oc-row">
          <div className="oc-row-meta">
            <div className="oc-row-title">ntfy Topic URL</div>
            <div className="oc-row-sub">Enable push via ntfy topic endpoint</div>
          </div>
          <div className="oc-row-ctrl" style={{ gap: 6 }}>
            <input placeholder="https://ntfy.sh/my-akron-topic" value={(cfg.ntfy && cfg.ntfy.topicUrl) || ''} onChange={(e) => savePatch({ ntfy: { ...(cfg.ntfy || {}), enabled: !!e.target.value.trim(), topicUrl: e.target.value } })} />
          </div>
        </div>
        <div className="oc-row">
          <div className="oc-row-meta">
            <div className="oc-row-title">Webhook URL</div>
            <div className="oc-row-sub">JSON + HMAC-SHA256 webhook delivery endpoint</div>
          </div>
          <div className="oc-row-ctrl" style={{ gap: 6 }}>
            <input placeholder="https://hooks.example/akron" value={(cfg.webhook && cfg.webhook.url) || ''} onChange={(e) => savePatch({ webhook: { ...(cfg.webhook || {}), enabled: !!e.target.value.trim(), url: e.target.value } })} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function OutboundRelaySection({ setNotice }) {
  const [st, setSt] = useState({ connected: false, relayUrl: '', killSwitchActive: false, killSwitchPath: '~/.autobot/remote.OFF' });
  const [relayUrl, setRelayUrl] = useState('');
  const [token, setToken] = useState('');

  const refresh = useCallback(async () => {
    try {
      if (window.autobot && window.autobot.remoteRelayStatus) {
        const res = await window.autobot.remoteRelayStatus();
        if (res) {
          setSt(res);
          if (res.relayUrl && !relayUrl) setRelayUrl(res.relayUrl);
        }
      }
    } catch (_) {}
  }, [relayUrl]);

  useEffect(() => { refresh(); }, [refresh]);

  const toggleKill = async () => {
    if (!window.autobot || !window.autobot.remoteKillSwitch) return;
    const r = await window.autobot.remoteKillSwitch(!st.killSwitchActive);
    setSt((prev) => ({ ...prev, killSwitchActive: Boolean(r && r.active), connected: r && r.active ? false : prev.connected }));
    setNotice && setNotice(r && r.active ? 'Kill switch engaged (~/.autobot/remote.OFF)' : 'Kill switch cleared');
  };

  const connectRelay = async () => {
    if (!window.autobot || !window.autobot.remoteRelayConfigure) return;
    const r = await window.autobot.remoteRelayConfigure({ action: 'connect', relayUrl, token });
    setSt((prev) => ({ ...prev, ...r }));
    if (r && r.error) setNotice && setNotice(r.error);
  };

  const disconnectRelay = async () => {
    if (!window.autobot || !window.autobot.remoteRelayConfigure) return;
    const r = await window.autobot.remoteRelayConfigure({ action: 'disconnect' });
    setSt((prev) => ({ ...prev, ...r, connected: false }));
  };

  return (
    <div style={{ marginTop: 14 }}>
      <h3 className="oc-sec-title">Outbound Remote Relay &amp; Kill Switch</h3>
      <div className="oc-group">
        <div className="oc-row">
          <div className="oc-row-meta">
            <div className="oc-row-title">Emergency Kill Switch (<code>remote.OFF</code>)</div>
            <div className="oc-row-sub">
              {st.killSwitchActive ? 'ACTIVE — all remote HTTP, WS & Outbound Relay traffic blocked immediately.' : 'Off — remote monitoring allowed when enabled.'}
            </div>
          </div>
          <div className="oc-row-ctrl">
            <button type="button" className={'btn-mini ' + (st.killSwitchActive ? 'primary' : '')} onClick={toggleKill}>
              {st.killSwitchActive ? 'Clear remote.OFF' : 'Engage Kill Switch'}
            </button>
          </div>
        </div>
        <div className="oc-row">
          <div className="oc-row-meta">
            <div className="oc-row-title">Outbound Relay Endpoint</div>
            <div className="oc-row-sub">Connect outbound without opening inbound firewall ports</div>
          </div>
          <div className="oc-row-ctrl" style={{ gap: 6 }}>
            <input placeholder="wss://relay.example/akron" value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} />
            <input type="password" placeholder="Bearer token" value={token} onChange={(e) => setToken(e.target.value)} style={{ width: 120 }} />
            {st.connected ? (
              <button type="button" className="btn-mini" onClick={disconnectRelay}>Disconnect</button>
            ) : (
              <button type="button" className="btn-mini primary" disabled={st.killSwitchActive || !relayUrl.trim()} onClick={connectRelay}>Connect</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function TypographySettingsSection({ typography, onChange, setNotice }) {
  const cfg = normalizeTypography(typography);
  const patch = (next) => onChange(normalizeTypography({ ...cfg, ...next }));
  const resetDefaults = () => {
    onChange({ ...DEFAULT_TYPOGRAPHY });
    setNotice && setNotice('Typography reset to defaults');
  };
  const uiStack = resolveUiFontStack(cfg);
  const monoStack = resolveMonoFontStack(cfg);

  return (
    <div className="typo-card" data-testid="typography-settings-card">
      <div className="typo-head">
        <div>
          <h3><Icon name="Palette" size={14} /> Typography &amp; Fonts</h3>
          <p className="muted">Applies live across chat messages, code blocks, Monaco editor, and integrated terminals.</p>
        </div>
        <button type="button" className="btn-subtle" onClick={resetDefaults}>Reset Defaults</button>
      </div>

      <div className="typo-grid">
        <div className="typo-col">
          <div className="typo-col-title">UI &amp; Chat Prose</div>
          <label>
            Font Family
            <select
              value={cfg.uiPreset}
              onChange={(e) => patch({ uiPreset: e.target.value })}
              aria-label="UI font family"
            >
              {UI_FONT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          {cfg.uiPreset === 'custom' && (
            <label>
              Custom UI Font Name
              <input
                type="text"
                value={cfg.uiCustomFont}
                onChange={(e) => patch({ uiCustomFont: e.target.value })}
                placeholder="e.g. Plus Jakarta Sans, Helvetica Neue"
              />
            </label>
          )}
          <label>
            UI &amp; Chat Size ({cfg.uiSize}px)
            <div className="typo-size-row">
              <input
                type="range"
                min={12}
                max={18}
                step={0.5}
                value={Math.min(18, cfg.uiSize)}
                onChange={(e) => patch({ uiSize: Number(e.target.value) })}
                aria-label="UI font size slider"
              />
              <input
                type="number"
                min={12}
                max={18}
                step={0.5}
                value={Math.min(18, cfg.uiSize)}
                onChange={(e) => patch({ uiSize: Number(e.target.value) })}
                aria-label="UI font size"
                className="typo-size-num"
              />
            </div>
          </label>
        </div>

        <div className="typo-col">
          <div className="typo-col-title">Code, Editor &amp; Terminal</div>
          <label>
            Monospace Family
            <select
              value={cfg.monoPreset}
              onChange={(e) => patch({ monoPreset: e.target.value })}
              aria-label="Code font family"
            >
              {MONO_FONT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          {cfg.monoPreset === 'custom' && (
            <label>
              Custom Monospace Font Name
              <input
                type="text"
                value={cfg.monoCustomFont}
                onChange={(e) => patch({ monoCustomFont: e.target.value })}
                placeholder="e.g. Berkeley Mono, Victor Mono"
              />
            </label>
          )}
          <label>
            Code &amp; Editor Size ({cfg.monoSize}px)
            <div className="typo-size-row">
              <input
                type="range"
                min={11}
                max={20}
                step={0.5}
                value={cfg.monoSize}
                onChange={(e) => patch({ monoSize: Number(e.target.value) })}
                aria-label="Code font size slider"
              />
              <input
                type="number"
                min={11}
                max={20}
                step={0.5}
                value={cfg.monoSize}
                onChange={(e) => patch({ monoSize: Number(e.target.value) })}
                aria-label="Code font size"
                className="typo-size-num"
              />
            </div>
          </label>
          <label className="check" style={{ marginTop: 6 }}>
            <input
              type="checkbox"
              checked={!!cfg.ligatures}
              onChange={(e) => patch({ ligatures: e.target.checked })}
            />
            Enable code font ligatures (<code>!= === =&gt; -&gt;</code>)
          </label>
        </div>
      </div>

      <div className="typo-preview-box">
        <div className="typo-preview-label">Live Preview</div>
        <div className="typo-preview-prose" style={{ fontFamily: uiStack, fontSize: `${cfg.uiSize}px` }}>
          Akron Code updates prose and code metrics immediately — crisp, readable, zero flash on reload.
        </div>
        <pre
          className="typo-preview-code"
          style={{
            fontFamily: monoStack,
            fontSize: `${cfg.monoSize}px`,
            fontVariantLigatures: cfg.ligatures ? 'normal' : 'none',
            fontFeatureSettings: cfg.ligatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0',
          }}
        >{`const check = (x) => x !== null && x >= 1 ? 'ready' : 'idle';`}</pre>
      </div>
    </div>
  );
}

// ComputerUseModal, CommandPalette, FindBar, GoogleDriveModal extracted to src/features/AppModals.jsx
