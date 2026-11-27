import React, { useState, useEffect, useCallback } from 'react';
import { Icon } from '../Icon.jsx';

export function OrchPaidProvidersPanel({ orchestrator, saveOrch, onProvidersLoaded, onPoolMutated }) {
  const [providers, setProviders] = useState([]);
  const [selectedId, setSelectedId] = useState('openrouter');
  const [draftName, setDraftName] = useState('');
  const [draftBase, setDraftBase] = useState('');
  const [draftKey, setDraftKey] = useState('');
  const [newModelId, setNewModelId] = useState('');
  const [newModelTier, setNewModelTier] = useState('heavy');
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const [creatingCustom, setCreatingCustom] = useState(false);

  const loadProviders = useCallback(async () => {
    if (!window.autobot || !window.autobot.orchPaidProvidersGet) return;
    try {
      const res = await window.autobot.orchPaidProvidersGet();
      if (res && res.ok && Array.isArray(res.providers)) {
        setProviders(res.providers);
        if (onProvidersLoaded) onProvidersLoaded(res.providers);
      }
    } catch (_) {}
  }, [onProvidersLoaded]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const selected = creatingCustom
    ? null
    : (providers.find((p) => p.id === selectedId) || providers[0] || null);

  useEffect(() => {
    if (creatingCustom) {
      setDraftName('');
      setDraftBase('https://');
      setDraftKey('');
      return;
    }
    if (selected) {
      setDraftName(selected.name || '');
      setDraftBase(selected.baseURL || '');
      setDraftKey('');
    }
  }, [creatingCustom, selected?.id, selected?.name, selected?.baseURL]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async ({ autoAdd = false } = {}) => {
    setBusy(true);
    setErrMsg('');
    setStatusMsg('');
    try {
      const id = creatingCustom
        ? (draftName || 'custom-provider').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || ('custom-' + Date.now().toString(36))
        : (selected && selected.id);
      if (!id) {
        setErrMsg('Select or name a provider first.');
        return;
      }
      const modelsList = creatingCustom
        ? (newModelId.trim() ? [{ id: newModelId.trim(), label: newModelId.trim(), tier: newModelTier }] : [])
        : ((selected && selected.models) || []);
      const res = await window.autobot.orchPaidProviderSave({
        id,
        name: draftName.trim() || (selected && selected.name) || id,
        baseURL: draftBase.trim(),
        apiKey: draftKey.trim(),
        models: modelsList,
        autoAddModels: autoAdd ? modelsList.slice(0, 6) : undefined,
      });
      if (!res || !res.ok) {
        setErrMsg((res && res.error) || 'Failed to save provider');
        return;
      }
      if (Array.isArray(res.providers)) {
        setProviders(res.providers);
        if (onProvidersLoaded) onProvidersLoaded(res.providers);
      }
      if (res.orchestrator && saveOrch && autoAdd) {
        saveOrch(res.orchestrator);
      }
      setCreatingCustom(false);
      if (res.savedId) setSelectedId(res.savedId);
      setDraftKey('');
      if (newModelId.trim() && creatingCustom) setNewModelId('');
      setStatusMsg(autoAdd ? 'Key saved & models added to Orchestrator pool.' : 'Provider configuration saved.');
      if (onPoolMutated) onPoolMutated();
    } catch (e) {
      setErrMsg(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };

  const handleClearKey = async () => {
    if (!selected) return;
    setBusy(true);
    setErrMsg('');
    setStatusMsg('');
    try {
      const res = await window.autobot.orchPaidProviderSave({
        id: selected.id,
        name: selected.name,
        baseURL: selected.baseURL,
        clearKey: true,
        models: selected.models || [],
      });
      if (!res || !res.ok) {
        setErrMsg((res && res.error) || 'Failed to clear API key');
        return;
      }
      if (Array.isArray(res.providers)) {
        setProviders(res.providers);
        if (onProvidersLoaded) onProvidersLoaded(res.providers);
      }
      if (res.orchestrator && saveOrch) saveOrch(res.orchestrator);
      setDraftKey('');
      setStatusMsg('API key cleared & disabled from active pool.');
      if (onPoolMutated) onPoolMutated();
    } catch (e) {
      setErrMsg(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteCustom = async () => {
    if (!selected || !selected.custom) return;
    setBusy(true);
    setErrMsg('');
    setStatusMsg('');
    try {
      const res = await window.autobot.orchPaidProviderDelete({ id: selected.id });
      if (!res || !res.ok) {
        setErrMsg((res && res.error) || 'Failed to remove provider');
        return;
      }
      if (Array.isArray(res.providers)) {
        setProviders(res.providers);
        if (onProvidersLoaded) onProvidersLoaded(res.providers);
      }
      if (res.orchestrator && saveOrch) saveOrch(res.orchestrator);
      setSelectedId('openrouter');
      setStatusMsg('Custom provider removed.');
      if (onPoolMutated) onPoolMutated();
    } catch (e) {
      setErrMsg(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };

  const handleFetchModels = async () => {
    if (!selected && !creatingCustom) return;
    setFetching(true);
    setErrMsg('');
    setStatusMsg('');
    try {
      const id = creatingCustom
        ? ((draftName || 'custom').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'custom')
        : selected.id;
      const res = await window.autobot.orchPaidProviderFetchModels({
        id,
        name: draftName.trim() || (selected && selected.name) || id,
        baseURL: draftBase.trim(),
        apiKey: draftKey.trim(),
      });
      if (!res || !res.ok) {
        setErrMsg((res && res.error) || 'Could not fetch /models from endpoint');
        return;
      }
      if (Array.isArray(res.providers)) {
        setProviders(res.providers);
        if (onProvidersLoaded) onProvidersLoaded(res.providers);
      }
      setStatusMsg(`Fetched ${res.fetchedCount || (res.models && res.models.length) || 0} live models from endpoint.`);
    } catch (e) {
      setErrMsg(String((e && e.message) || e));
    } finally {
      setFetching(false);
    }
  };

  const handleAddModel = async () => {
    const mid = newModelId.trim();
    if (!mid || !selected) return;
    setBusy(true);
    setErrMsg('');
    setStatusMsg('');
    try {
      const prevModels = Array.isArray(selected.models) ? selected.models : [];
      const exists = prevModels.some((m) => m.id === mid);
      const nextModels = exists
        ? prevModels
        : [{ id: mid, label: mid, tier: newModelTier, contextWindow: 0 }, ...prevModels];
      const res = await window.autobot.orchPaidProviderSave({
        id: selected.id,
        name: draftName.trim() || selected.name,
        baseURL: draftBase.trim() || selected.baseURL,
        apiKey: draftKey.trim(),
        models: nextModels,
        autoAddModels: selected.hasKey || draftKey.trim() ? [{ id: mid, label: mid, tier: newModelTier }] : undefined,
      });
      if (!res || !res.ok) {
        setErrMsg((res && res.error) || 'Could not add model');
        return;
      }
      if (Array.isArray(res.providers)) {
        setProviders(res.providers);
        if (onProvidersLoaded) onProvidersLoaded(res.providers);
      }
      if (res.orchestrator && saveOrch) saveOrch(res.orchestrator);
      setNewModelId('');
      setStatusMsg(`Added ${mid} (${newModelTier}).`);
      if (onPoolMutated) onPoolMutated();
    } catch (e) {
      setErrMsg(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };

  const configuredCount = providers.filter((p) => p.hasKey).length;

  return (
    <div className="orch-paid-box" data-testid="orch-paid-providers">
      <div className="orch-paid-head">
        <div>
          <div className="orch-paid-title">Paid &amp; Custom API Providers</div>
          <div className="orch-paid-sub">
            Add keys for OpenRouter, DeepSeek, GLM/Z.ai, GhostMetal, OpenAI, Anthropic, Gemini, xAI or any OpenAI-compatible API. Keyed models appear in the checklist below and work without FreeLLMAPI role pools.
          </div>
        </div>
        <span className="orch-paid-badge">{configuredCount} keyed</span>
      </div>

      <div className="orch-paid-pills">
        {providers.map((p) => {
          const isSel = !creatingCustom && selected && selected.id === p.id;
          return (
            <button
              key={p.id}
              type="button"
              className={'orch-paid-pill' + (isSel ? ' sel' : '') + (p.hasKey ? ' ready' : '')}
              onClick={() => { setCreatingCustom(false); setSelectedId(p.id); setErrMsg(''); setStatusMsg(''); }}
              title={p.hasKey ? `${p.name} · Key saved (${p.keyHint})` : `${p.name} · Set API key`}
            >
              <span className={'orch-paid-dot' + (p.hasKey ? ' ok' : '')} />
              <span>{p.name.replace(/\s*\([^)]*\)/, '')}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={'orch-paid-pill custom-btn' + (creatingCustom ? ' sel' : '')}
          onClick={() => { setCreatingCustom(true); setErrMsg(''); setStatusMsg(''); }}
        >
          <Icon name="Plus" size={11} /> Custom Provider
        </button>
      </div>

      {(selected || creatingCustom) && (
        <div className="orch-paid-editor">
          <div className="orch-paid-grid">
            <label className="orch-paid-field">
              <span>Provider Name</span>
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="e.g. GhostMetal Production"
                disabled={!creatingCustom && selected && !selected.custom && selected.id !== 'ghostmetal'}
              />
            </label>
            <label className="orch-paid-field">
              <span>Base URL (OpenAI-compatible /v1)</span>
              <input
                value={draftBase}
                onChange={(e) => setDraftBase(e.target.value)}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
              />
            </label>
          </div>

          <label className="orch-paid-field">
            <span>API Key {selected && selected.hasKey ? `(saved ${selected.keyHint})` : '(encrypted in Secret Store)'}</span>
            <input
              type="password"
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              placeholder={selected && selected.hasKey ? `Saved (${selected.keyHint}) — paste new key to replace` : 'sk-…'}
              autoComplete="off"
            />
          </label>

          {!creatingCustom && selected && (
            <div className="orch-paid-addmodel">
              <input
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
                placeholder="Add custom model ID (e.g. deepseek/deepseek-v4, glm-5, ghostmetal-pro)"
                spellCheck={false}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddModel(); } }}
              />
              <select value={newModelTier} onChange={(e) => setNewModelTier(e.target.value)} aria-label="Model tier">
                <option value="small">small</option>
                <option value="heavy">heavy</option>
                <option value="critical">critical</option>
              </select>
              <button type="button" className="btn-mini" disabled={busy || !newModelId.trim()} onClick={handleAddModel}>
                + Add Model
              </button>
            </div>
          )}

          <div className="orch-paid-actions">
            <button
              type="button"
              className="btn-mini primary"
              disabled={busy || (!draftKey.trim() && !(selected && selected.hasKey))}
              onClick={() => handleSave({ autoAdd: true })}
            >
              {busy ? 'Saving…' : 'Save Key & Add Models to Pool'}
            </button>
            <button
              type="button"
              className="btn-mini"
              disabled={busy}
              onClick={() => handleSave({ autoAdd: false })}
            >
              Save Endpoint / Key Only
            </button>
            <button
              type="button"
              className="btn-mini"
              disabled={fetching || (!draftKey.trim() && !(selected && selected.hasKey) && !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(draftBase))}
              onClick={handleFetchModels}
            >
              <Icon name="Refresh" size={11} /> {fetching ? 'Fetching…' : 'Fetch Live /models'}
            </button>
            {selected && selected.hasKey && !creatingCustom && (
              <button type="button" className="btn-mini danger" disabled={busy} onClick={handleClearKey}>
                Clear Key
              </button>
            )}
            {selected && selected.custom && !creatingCustom && (
              <button type="button" className="btn-mini danger" disabled={busy} onClick={handleDeleteCustom}>
                Delete
              </button>
            )}
          </div>

          {errMsg && <p className="orch-paid-msg err">{errMsg}</p>}
          {statusMsg && <p className="orch-paid-msg ok">{statusMsg}</p>}
        </div>
      )}
    </div>
  );
}
