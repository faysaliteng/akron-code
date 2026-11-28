import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Icon, ModelLogo } from './Icon.jsx';

function cleanLine(v) {
  return String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

const PROVIDER_META = {
  claude: { label: 'Claude', cliLabel: 'Claude Code CLI', cmd: 'claude auth login', hint: 'Runs native `claude auth login` so your CLI and desktop share one session.' },
  chatgpt: { label: 'ChatGPT / Codex', cliLabel: 'Codex CLI', cmd: 'codex login', hint: 'Runs native `codex login` via ChatGPT Plus/Pro OAuth (or device code).' },
  antigravity: { label: 'Google Gemini / Antigravity', cliLabel: 'Antigravity CLI (agy)', cmd: 'agy acp --login', hint: 'Uses official Antigravity CLI (`agy`) authentication or a GEMINI_API_KEY.' },
  grok: { label: 'Grok', cliLabel: 'Grok CLI', cmd: 'grok login', hint: 'Runs native `grok login` via your xAI / SuperGrok subscription.' },
  kimi: { label: 'Kimi K3 (Kimi Code)', cliLabel: 'Kimi Code CLI', cmd: 'kimi login', hint: 'Runs native `kimi login` device-code authorization for Kimi K3 & K3.1 Pro.' },
  zai: { label: 'Z.ai (GLM Coding Plan)', cliLabel: 'Z.ai Coding Plan', cmd: 'zcode login', hint: 'Uses https://api.z.ai/api/coding/paas/v4 with your Z.ai subscription key (or `zcode` CLI).' },
  copilot: { label: 'GitHub Copilot', cliLabel: 'GitHub Copilot CLI', cmd: 'copilot login --device-code', hint: 'Runs official `copilot login --device-code` (or accepts a fine-grained GitHub PAT with Copilot Requests).' },
};

/**
 * Shared controller hook for One-Click Native CLI Sign-In / Reconnect across
 * all subscription providers (Claude, ChatGPT/Codex, Gemini, Grok, Kimi, Z.ai).
 */
export function useCliLogin({ onSuccess, onNotice } = {}) {
  const [flow, setFlow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;
  const flowRef = useRef(flow);
  flowRef.current = flow;

  useEffect(() => {
    if (!window.autobot || typeof window.autobot.onCliLoginEvent !== 'function') return undefined;
    return window.autobot.onCliLoginEvent(async (evt) => {
      if (!evt || !evt.provider) return;
      const cur = flowRef.current;
      if (!cur || cur.provider !== evt.provider) return;
      if (evt.phase === 'done' && evt.ok) {
        setFlow((prev) => (prev ? { ...prev, status: 'done', error: '' } : prev));
        if (typeof onSuccessRef.current === 'function') {
          try { await onSuccessRef.current(evt); } catch (_) {}
        }
        setTimeout(() => {
          setFlow((prev) => (prev && prev.status === 'done' && prev.flowId === evt.flowId ? null : prev));
        }, 700);
        return;
      }
      if (evt.phase === 'watchdog') {
        setFlow((prev) => (prev ? {
          ...prev,
          watchdogTriggered: true,
          cliCommand: evt.cliCommand || prev.cliCommand,
          lines: Array.isArray(evt.lines) && evt.lines.length ? evt.lines : prev.lines,
        } : prev));
        return;
      }
      if (evt.phase === 'error' || evt.phase === 'cancelled') {
        const msg = cleanLine(evt.error || (evt.cancelled ? 'Sign-in cancelled.' : 'Sign-in did not complete.'));
        setFlow((prev) => (prev ? { ...prev, status: evt.cancelled ? 'cancelled' : 'error', error: msg } : prev));
        if (typeof onNoticeRef.current === 'function') onNoticeRef.current(msg);
        return;
      }
      setFlow((prev) => {
        if (!prev) return prev;
        const nextLines = prev.lines ? prev.lines.slice() : [];
        if (evt.line) {
          nextLines.push(cleanLine(evt.line));
          while (nextLines.length > 6) nextLines.shift();
        }
        return {
          ...prev,
          flowId: evt.flowId || prev.flowId,
          url: evt.url || prev.url,
          userCode: evt.userCode || prev.userCode,
          lines: nextLines,
        };
      });
    });
  }, []);

  const start = useCallback(async (providerId, opts = {}) => {
    const pid = String(providerId || 'claude').toLowerCase();
    const meta = PROVIDER_META[pid] || { label: pid, cliLabel: pid, hint: '' };
    setBusy(true);
    setCodeInput('');
    setCopiedCode(false);
    setFlow({
      provider: pid,
      label: meta.label,
      cliLabel: meta.cliLabel,
      cliCommand: meta.cmd || pid,
      hint: meta.hint,
      watchdogTriggered: false,
      flowId: '',
      url: '',
      userCode: '',
      lines: [],
      status: 'starting',
      error: '',
      mode: 'cli',
      docsUrl: '',
      requiresCodePaste: pid === 'claude',
      supportsDeviceAuth: pid === 'chatgpt',
      sentCode: false,
    });
    try {
      const api = window.autobot || {};
      let res = null;
      if (typeof api.startCliLogin === 'function') {
        res = await api.startCliLogin(pid, opts);
      } else if (pid === 'claude' && typeof api.providerReconnectClaude === 'function') {
        res = await api.providerReconnectClaude();
      } else if (typeof api.providerSignIn === 'function') {
        res = await api.providerSignIn(pid);
      }
      if (!res || res.ok === false) {
        const err = cleanLine((res && res.error) || `Could not start ${meta.label} sign-in.`);
        setFlow((prev) => (prev ? { ...prev, status: 'error', error: err, cliCommand: (res && res.cliCommand) || prev.cliCommand } : prev));
        if (typeof onNoticeRef.current === 'function') onNoticeRef.current(err);
        return res;
      }
      if (res.alreadySignedIn || res.status === 'done') {
        setFlow((prev) => (prev ? { ...prev, status: 'done', error: '', cliCommand: res.cliCommand || prev.cliCommand } : prev));
        if (typeof onSuccessRef.current === 'function') {
          try { await onSuccessRef.current({ ...res, provider: pid, ok: true }); } catch (_) {}
        }
        setTimeout(() => { setFlow((prev) => (prev && prev.status === 'done' ? null : prev)); }, 500);
        return res;
      }
      if (res.mode === 'api-key') {
        setFlow((prev) => (prev ? {
          ...prev,
          mode: 'api-key',
          status: 'waiting',
          docsUrl: res.docsUrl || '',
          url: res.docsUrl || '',
          hint: res.hint || prev.hint,
        } : prev));
        return res;
      }
      setFlow((prev) => (prev ? {
        ...prev,
        flowId: res.flowId || prev.flowId,
        cliCommand: res.cliCommand || prev.cliCommand,
        url: res.url || prev.url,
        userCode: res.userCode || prev.userCode,
        requiresCodePaste: res.requiresCodePaste !== undefined ? !!res.requiresCodePaste : prev.requiresCodePaste,
        supportsDeviceAuth: res.supportsDeviceAuth !== undefined ? !!res.supportsDeviceAuth : prev.supportsDeviceAuth,
        status: res.waiting === false && !res.url ? 'waiting' : 'waiting',
      } : prev));
      return res;
    } catch (e) {
      const err = cleanLine((e && e.message) || 'Could not start sign-in.');
      setFlow((prev) => (prev ? { ...prev, status: 'error', error: err } : prev));
      return { ok: false, error: err };
    } finally {
      setBusy(false);
    }
  }, []);

  const cancel = useCallback(async () => {
    const cur = flowRef.current;
    if (cur && cur.provider && window.autobot) {
      try {
        if (typeof window.autobot.cancelCliLogin === 'function') {
          await window.autobot.cancelCliLogin(cur.provider);
        } else if (cur.provider === 'claude' && typeof window.autobot.providerReconnectClaudeCancel === 'function') {
          await window.autobot.providerReconnectClaudeCancel();
        }
      } catch (_) {}
    }
    setFlow(null);
    setCodeInput('');
  }, []);

  const submitCode = useCallback(async () => {
    const cur = flowRef.current;
    const val = String(codeInput || '').trim();
    if (!cur || !val) return;
    setBusy(true);
    try {
      if (cur.mode === 'api-key') {
        const res = await window.autobot.providerAddBearer(cur.provider, val, cur.label);
        if (!res || res.ok === false) {
          const msg = cleanLine((res && res.error) || 'Invalid API key');
          setFlow((p) => (p ? { ...p, error: msg } : p));
          return;
        }
        setFlow((p) => (p ? { ...p, status: 'done', error: '' } : p));
        if (typeof onSuccessRef.current === 'function') await onSuccessRef.current({ provider: cur.provider, ok: true });
        setTimeout(() => setFlow(null), 500);
        return;
      }
      const fn = window.autobot.submitCliLoginCode || window.autobot.providerReconnectClaudeCode;
      if (typeof fn === 'function') {
        const r = await fn(cur.flowId, val);
        if (r && r.ok === false) {
          setFlow((p) => (p ? { ...p, error: cleanLine(r.error || 'Invalid verification code'), sentCode: false } : p));
          return;
        }
        setFlow((p) => (p ? { ...p, error: '', sentCode: true } : p));
        setCodeInput('');
      }
    } finally {
      setBusy(false);
    }
  }, [codeInput]);

  const copyCode = useCallback(async () => {
    const cur = flowRef.current;
    if (!cur || !cur.userCode) return;
    try {
      if (window.autobot && typeof window.autobot.clipboardWrite === 'function') {
        await window.autobot.clipboardWrite(cur.userCode);
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(cur.userCode);
      }
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 1800);
    } catch (_) {}
  }, []);

  const openLoginLink = useCallback(async () => {
    const cur = flowRef.current;
    const target = (cur && (cur.url || cur.docsUrl)) || '';
    if (!target) return;
    try {
      if (window.autobot && typeof window.autobot.openExternal === 'function') {
        await window.autobot.openExternal(target);
      }
    } catch (_) {}
  }, []);

  const copyTerminalCommand = useCallback(async () => {
    const cur = flowRef.current;
    const cmd = cur && cur.cliCommand;
    if (!cmd) return;
    try {
      if (window.autobot && typeof window.autobot.clipboardWrite === 'function') {
        await window.autobot.clipboardWrite(cmd);
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(cmd);
      }
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 1800);
    } catch (_) {}
  }, []);

  const switchToApiKey = useCallback(() => {
    setFlow((prev) => (prev ? { ...prev, mode: 'api-key', status: 'waiting', error: '' } : prev));
  }, []);

  return {
    flow,
    busy,
    codeInput,
    setCodeInput,
    copiedCode,
    copiedCmd,
    start,
    cancel,
    submitCode,
    copyCode,
    copyTerminalCommand,
    switchToApiKey,
    openLoginLink,
  };
}

export function CliLoginModal({ controller }) {
  if (!controller || !controller.flow) return null;
  const { flow, busy, codeInput, setCodeInput, copiedCode, copiedCmd, cancel, submitCode, copyCode, copyTerminalCommand, switchToApiKey, openLoginLink, start } = controller;
  const isDone = flow.status === 'done';
  const isError = flow.status === 'error';
  const isApiKeyMode = flow.mode === 'api-key';

  return (
    <div className="cli-login-backdrop" data-testid="cli-login-modal" role="dialog" aria-modal="true" aria-label={`Sign in to ${flow.label}`} onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <div className="cli-login-modal">
        <div className="cli-login-head">
          <div className="cli-login-title-wrap">
            <ModelLogo provider={flow.provider} size={22} />
            <div>
              <div className="cli-login-title">
                {isDone ? `${flow.label} Connected` : (isApiKeyMode ? `Configure ${flow.label} API Key` : `Sign in with ${flow.cliLabel}`)}
              </div>
              <div className="cli-login-sub">{flow.hint}</div>
            </div>
          </div>
          <button type="button" className="cli-login-close" onClick={cancel} title="Cancel" aria-label="Cancel"><Icon name="X" size={14} /></button>
        </div>

        <div className="cli-login-body">
          <div className={'cli-login-status ' + flow.status}>
            <span className={'cli-status-dot ' + (isDone ? 'ok' : isError ? 'err' : 'wait')} />
            <span>
              {isDone
                ? 'Authentication complete — models refreshed.'
                : (isError
                  ? (flow.error || 'Sign-in did not complete.')
                  : (flow.status === 'starting'
                    ? `Launching ${flow.cliLabel} sign-in…`
                    : (isApiKeyMode
                      ? `Paste your ${flow.provider === 'zai' ? 'Z.ai Coding Plan API key' : (flow.provider === 'copilot' ? 'GitHub PAT with "Copilot Requests" permission' : `${flow.label} API key`)} (encrypted in local Secret Store).`
                      : (flow.watchdogTriggered
                        ? `Still waiting on \`${flow.cliCommand}\` — complete it below or copy the terminal command.`
                        : 'Complete sign-in in your browser, or use the link/code below…'))))}
            </span>
          </div>

          {flow.userCode && (
            <div className="cli-code-card" data-testid="cli-login-code-box">
              <div className="cli-code-label">One-time verification code</div>
              <div className="cli-code-row">
                <code className="cli-code-val">{flow.userCode}</code>
                <button type="button" className="btn-mini primary" data-testid="cli-login-copy-code" onClick={copyCode}>
                  <Icon name={copiedCode ? 'Check' : 'Copy'} size={12} /> {copiedCode ? 'Copied' : 'Copy Code'}
                </button>
              </div>
            </div>
          )}

          {(flow.requiresCodePaste || isApiKeyMode) && !isDone && (
            <div className="cli-paste-row">
              <input
                type={isApiKeyMode ? 'password' : 'text'}
                className="cli-paste-input"
                data-testid="cli-login-code-input"
                placeholder={isApiKeyMode
                  ? (flow.provider === 'zai' ? 'Paste Z.ai Coding Plan API key…' : (flow.provider === 'copilot' ? 'Paste fine-grained GitHub PAT…' : `Paste ${flow.label} API key…`))
                  : 'Paste browser verification code (e.g. code#state)…'}
                value={codeInput}
                disabled={busy || flow.sentCode}
                onChange={(e) => setCodeInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitCode(); } }}
              />
              <button
                type="button"
                className="btn-mini primary"
                data-testid="cli-login-submit-code"
                disabled={busy || flow.sentCode || !String(codeInput || '').trim()}
                onClick={submitCode}
              >
                {flow.sentCode ? 'Verifying…' : (isApiKeyMode ? 'Save & Connect' : 'Submit Code')}
              </button>
            </div>
          )}

          {flow.lines && flow.lines.length > 0 && (
            <div className="cli-login-log" aria-live="polite">
              {flow.lines.map((ln, idx) => <div key={idx} className="cli-login-log-line">{ln}</div>)}
            </div>
          )}
        </div>

        <div className="cli-login-foot">
          {(flow.url || flow.docsUrl) && (
            <button type="button" className="btn-mini" data-testid="cli-login-open-link" onClick={openLoginLink}>
              <Icon name="ArrowInSquare" size={12} /> {isApiKeyMode ? (flow.provider === 'zai' ? 'Get Z.ai Coding Key' : 'Get API Key') : 'Open Login Link'}
            </button>
          )}
          {!isApiKeyMode && !isDone && flow.cliCommand && (
            <button type="button" className="btn-mini" data-testid="cli-login-copy-cmd" onClick={copyTerminalCommand}>
              <Icon name={copiedCmd ? 'Check' : 'Copy'} size={12} /> {copiedCmd ? 'Copied Command' : 'Copy Terminal Command'}
            </button>
          )}
          {!isApiKeyMode && !isDone && (
            <button type="button" className="btn-mini" data-testid="cli-login-use-apikey" onClick={switchToApiKey}>
              Use API Key Instead
            </button>
          )}
          {flow.supportsDeviceAuth && !isDone && (
            <button
              type="button"
              className="btn-mini"
              disabled={busy}
              onClick={async () => { await cancel(); start(flow.provider, { deviceAuth: true }); }}
            >
              Use Device Code (--device-auth)
            </button>
          )}
          <button type="button" className="btn-mini" data-testid="cli-login-cancel" onClick={cancel} style={{ marginLeft: 'auto' }}>
            {isDone ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default CliLoginModal;
