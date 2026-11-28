import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Icon, ModelLogo } from '../Icon.jsx';
import { CliLoginModal, useCliLogin } from '../CliLoginModal.jsx';
import { ProvNotice, contextWindowFor } from '../../utils/appHelpers.jsx';
import { normBase, presetStatus } from '../../providerstatus-ui.mjs';
import {
  DEFAULT_MODEL_PICKER_PREFS,
  loadModelPickerPrefs,
  saveModelPickerPrefs,
  resetModelPickerPrefs,
  togglePinnedModel,
  toggleHiddenProvider,
  toggleHiddenModel,
  modelVisibilityKey,
  isModelHidden,
  isModelPinned,
  fmtContextWindowBadge,
} from '../../utils/modelPickerPrefs.js';

const SUBSCRIPTION_TIERS = {
  claude: 'CLI · Max/Pro',
  chatgpt: 'CLI · Plus/Pro',
  antigravity: 'CLI · Google',
  grok: 'CLI · SuperGrok',
  kimi: 'CLI · Kimi Code',
  zai: 'Coding Plan',
};

export function ModelPickerPopover({
  modelMenuRef,
  effectiveRoutingMode,
  provider,
  orchestrator,
  setOrchestrator,
  setModelMenuOpen,
  openSettings,
  onOpenTutorial,
  hasDeepSeekKey,
  selectAutoMode,
  orchExpanded,
  setOrchExpanded,
  orchModelChoices,
  activateOrchestratorSupervisor,
  keyProbing,
  keyStatus,
  keyFor,
  pickerRows,
  ollama,
  ollamaEmpty,
  ollamaBusy,
  connectOllama,
  configurePreset,
  pickModel,
  provOauth,
  provModels,
  loadProvOauth,
  provBusy,
  providerAction,
  pickOauthAccount,
  provNotice,
  settings,
  T,
}) {
  const [prefs, setPrefs] = useState(() => loadModelPickerPrefs(settings));
  const [search, setSearch] = useState('');
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [collapsedProviders, setCollapsedProviders] = useState({});
  const [kbIdx, setKbIdx] = useState(0);
  const searchInputRef = useRef(null);

  useEffect(() => {
    setPrefs(loadModelPickerPrefs(settings));
  }, [settings?.modelPicker]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try { searchInputRef.current?.focus(); } catch (_) {}
  }, []);

  const updatePrefs = useCallback((next) => {
    const saved = saveModelPickerPrefs(next);
    setPrefs(saved);
  }, []);

  const cliLogin = useCliLogin({
    onSuccess: async () => {
      if (typeof loadProvOauth === 'function') await loadProvOauth();
    },
  });

  // Build normalized Subscription groups (Claude, ChatGPT, Gemini, Grok, Kimi K3, Z.ai)
  const subscriptionGroups = useMemo(() => {
    const provs = (provOauth && Array.isArray(provOauth.providers)) ? provOauth.providers : [];
    return provs.map((pv) => {
      const accounts = Array.isArray(pv.accounts) ? pv.accounts : [];
      const activeAcct = accounts.find((a) => a && a.account === pv.active) || accounts[0] || null;
      const acctKey = activeAcct ? `${pv.id}:${activeAcct.account}` : pv.id;
      const live = provModels[acctKey] || provModels[pv.id];
      const rawModels = (live && Array.isArray(live.models) && live.models.length ? live.models : (pv.models || []));
      const models = rawModels.map((m) => {
        const id = String((m && m.id) || m || '').trim();
        const win = Number(m && m.contextWindow) || contextWindowFor(id);
        const winLabel = (m && m.windowLabel) || fmtContextWindowBadge(win);
        return {
          id,
          label: String((m && m.label) || id),
          windowLabel: winLabel,
          contextWindow: win,
          group: (m && m.group) || '',
          kind: 'oauth',
          prov: pv,
          account: activeAcct ? activeAcct.account : 'cli',
          providerKey: pv.id,
          pinKey: modelVisibilityKey(pv.id, id),
        };
      }).filter((m) => m.id);
      const connected = accounts.some((a) => a && a.hasToken !== false && !a.needsSignIn && !a.expired);
      const planBadge = (activeAcct && activeAcct.plan) || SUBSCRIPTION_TIERS[pv.id] || 'CLI';
      return {
        id: pv.id,
        label: pv.label,
        vendor: pv.vendor,
        pv,
        accounts,
        activeAcct,
        connected,
        planBadge,
        models,
      };
    });
  }, [provOauth, provModels]);

  // Split API / local rows into configured vs unconfigured, deduplicated
  const { configuredRows, unconfiguredRows, providerCatalog } = useMemo(() => {
    const conf = [];
    const unconf = [];
    const provMap = new Map();
    for (const sg of subscriptionGroups) {
      provMap.set(sg.id, { id: sg.id, label: sg.label, kind: 'subscription', configured: sg.connected });
    }
    for (const r of pickerRows || []) {
      if (!r || !r.preset) continue;
      const base = normBase(r.preset.baseURL);
      const isOllama = /:11434\b/.test(base);
      const scan = ollama[base];
      const ollamaDown = isOllama && !(scan && scan.ok && scan.models && scan.models.length);
      const st = presetStatus(r.preset, { keyFor, status: keyStatus, probing: keyProbing });
      const isConfigured = Boolean(r.local) || (st.row !== 'dim' && !ollamaDown && base !== '');
      const provId = `api:${String(r.preset.name || base || r.model).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      if (!provMap.has(provId)) {
        provMap.set(provId, { id: provId, label: r.preset.name || r.prov || 'API Provider', kind: 'api', configured: isConfigured });
      }
      const item = {
        id: r.model,
        label: r.label,
        windowLabel: r.ctxBadge || '',
        kind: 'preset',
        row: r,
        st,
        ollamaDown,
        isConfigured,
        providerKey: provId,
        providerLabel: r.preset.name || r.prov || 'Custom',
        pinKey: modelVisibilityKey(provId, r.model),
      };
      if (isConfigured) conf.push(item);
      else unconf.push(item);
    }
    return {
      configuredRows: conf,
      unconfiguredRows: unconf,
      providerCatalog: Array.from(provMap.values()),
    };
  }, [subscriptionGroups, pickerRows, ollama, keyFor, keyStatus, keyProbing]);

  const query = search.trim().toLowerCase();
  const matchesQuery = useCallback((m, provLabel = '') => {
    if (!query) return true;
    const hay = `${m.id || ''} ${m.label || ''} ${provLabel || ''}`.toLowerCase();
    return hay.includes(query);
  }, [query]);

  // Visible subscription & API items respecting hide/show preferences & search
  const visibleSubscriptions = useMemo(() => {
    return subscriptionGroups
      .filter((sg) => !prefs.hiddenProviders.includes(sg.id))
      .map((sg) => ({
        ...sg,
        models: sg.models.filter((m) => !isModelHidden(prefs, sg.id, m.id) && matchesQuery(m, sg.label)),
      }))
      .filter((sg) => !query || sg.models.length > 0 || sg.label.toLowerCase().includes(query));
  }, [subscriptionGroups, prefs, query, matchesQuery]);

  const visibleConfigured = useMemo(() => {
    return configuredRows.filter((item) => (
      !prefs.hiddenProviders.includes(item.providerKey)
      && !isModelHidden(prefs, item.providerKey, item.id)
      && matchesQuery(item, item.providerLabel)
    ));
  }, [configuredRows, prefs, matchesQuery]);

  const visibleUnconfigured = useMemo(() => {
    if (prefs.hideUnconfiguredProviders && !query) return [];
    if (prefs.hideUnconfiguredProviders && query) {
      // Even when hidden by default, allow unconfigured results ONLY if hideUnconfiguredProviders is explicitly OFF
      return [];
    }
    return unconfiguredRows.filter((item) => (
      !prefs.hiddenProviders.includes(item.providerKey)
      && !isModelHidden(prefs, item.providerKey, item.id)
      && matchesQuery(item, item.providerLabel)
    ));
  }, [unconfiguredRows, prefs, query, matchesQuery]);

  // Pinned models resolved across subscriptions + configured APIs
  const pinnedItems = useMemo(() => {
    const out = [];
    const seen = new Set();
    const consider = (item) => {
      if (!item || seen.has(item.pinKey)) return;
      if (!isModelPinned(prefs, item.providerKey, item.id)) return;
      if (prefs.hiddenProviders.includes(item.providerKey) || isModelHidden(prefs, item.providerKey, item.id)) return;
      if (!matchesQuery(item, item.providerLabel || (item.prov && item.prov.label) || '')) return;
      seen.add(item.pinKey);
      out.push(item);
    };
    for (const sg of subscriptionGroups) for (const m of sg.models) consider(m);
    for (const c of configuredRows) consider(c);
    for (const u of unconfiguredRows) consider(u);
    return out;
  }, [subscriptionGroups, configuredRows, unconfiguredRows, prefs, matchesQuery]);

  const selectItem = useCallback((item) => {
    if (!item) return;
    if (item.kind === 'oauth') {
      if (item.prov && item.prov.accounts && item.prov.accounts.length) {
        pickOauthAccount(item.prov, item.account, item.id);
      } else if (item.prov) {
        cliLogin.start(item.prov.id);
      }
      return;
    }
    if (item.kind === 'preset' && item.row) {
      if (item.row.local) return pickModel(item.row.preset, item.row.model);
      if (item.ollamaDown) return connectOllama();
      if (item.st && item.st.row === 'dim') return configurePreset(item.row.preset);
      pickModel(item.row.preset, item.row.model);
    }
  }, [pickOauthAccount, cliLogin, pickModel, connectOllama, configurePreset]);

  const isItemActive = useCallback((item) => {
    if (!item || effectiveRoutingMode !== 'direct') return false;
    if (item.kind === 'oauth') {
      return Boolean(
        provider.oauthProvider
        && String(provider.oauthProvider).split(':')[0] === item.providerKey
        && provider.model === item.id
      );
    }
    if (item.kind === 'preset' && item.row) {
      return normBase(provider.baseURL) === normBase(item.row.preset.baseURL) && provider.model === item.row.model;
    }
    return false;
  }, [effectiveRoutingMode, provider.oauthProvider, provider.model, provider.baseURL]);

  // Flat list for keyboard arrow navigation
  const flatNavItems = useMemo(() => {
    const flat = [];
    for (const p of pinnedItems) flat.push(p);
    for (const sg of visibleSubscriptions) {
      if (!collapsedProviders[sg.id]) {
        for (const m of sg.models) flat.push(m);
      }
    }
    for (const c of visibleConfigured) flat.push(c);
    for (const u of visibleUnconfigured) flat.push(u);
    return flat;
  }, [pinnedItems, visibleSubscriptions, visibleConfigured, visibleUnconfigured, collapsedProviders]);

  useEffect(() => {
    setKbIdx((i) => (flatNavItems.length ? Math.min(i, flatNavItems.length - 1) : 0));
  }, [flatNavItems.length]);

  const onSearchKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (customizeOpen) setCustomizeOpen(false);
      else if (search) setSearch('');
      else setModelMenuOpen(false);
      return;
    }
    if (!flatNavItems.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setKbIdx((i) => (i + 1) % flatNavItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setKbIdx((i) => (i - 1 + flatNavItems.length) % flatNavItems.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = flatNavItems[kbIdx] || flatNavItems[0];
      if (target) selectItem(target);
    }
  };

  const renderModelItem = (item, idxKey, kbTarget = null) => {
    const active = isItemActive(item);
    const pinned = isModelPinned(prefs, item.providerKey, item.id);
    const focused = kbTarget && flatNavItems[kbIdx] === kbTarget;
    const badgeCtx = item.windowLabel || fmtContextWindowBadge(item.contextWindow);

    if (prefs.layout === 'grid') {
      return (
        <div key={idxKey} className={'mp-grid-card' + (active ? ' on' : '') + (focused ? ' kb-focus' : '')} data-testid={`model-item-${item.id}`}>
          <div className="mp-grid-top">
            <button type="button" className="mp-grid-main" onClick={() => selectItem(item)} title={item.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <ModelLogo model={item.id} label={item.label} provider={item.providerKey} baseURL={item.row?.preset?.baseURL} size={15} />
                <span className="mp-grid-title">{item.label}</span>
              </div>
              <div className="mp-grid-sub">
                <span className="mp-pill plan">{item.providerLabel || (item.prov && item.prov.label) || item.providerKey}</span>
                {badgeCtx && <span className="mp-pill ctx">{badgeCtx}</span>}
              </div>
            </button>
            <button
              type="button"
              className={'mp-star-btn' + (pinned ? ' on' : '')}
              data-testid={`pin-model-${item.id}`}
              title={pinned ? 'Unpin from favorites' : 'Pin to top'}
              onClick={(e) => { e.stopPropagation(); updatePrefs(togglePinnedModel(prefs, item.pinKey)); }}
            >
              {pinned ? '★' : '☆'}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div key={idxKey} className={'mp-model-row' + (active ? ' on' : '') + (focused ? ' kb-focus' : '')} data-testid={`model-item-${item.id}`}>
        <button type="button" className="mp-model-pick" onClick={() => selectItem(item)} title={`${item.id}${badgeCtx ? ' · ' + badgeCtx : ''}`}>
          <ModelLogo model={item.id} label={item.label} provider={item.providerKey} baseURL={item.row?.preset?.baseURL} size={15} />
          <span className="mp-model-label">{item.label}</span>
          <span className="mp-badges">
            {prefs.layout === 'compact' && (
              <span className="mp-pill cli">{item.providerLabel || (item.prov && item.prov.vendor) || item.providerKey}</span>
            )}
            {badgeCtx && <span className="mp-pill ctx">{badgeCtx}</span>}
          </span>
          {active && <Icon name="Check" size={13} className="model-check" />}
        </button>
        <button
          type="button"
          className={'mp-star-btn' + (pinned ? ' on' : '')}
          data-testid={`pin-model-${item.id}`}
          title={pinned ? 'Unpin from favorites' : 'Pin to top'}
          onClick={(e) => { e.stopPropagation(); updatePrefs(togglePinnedModel(prefs, item.pinKey)); }}
        >
          {pinned ? '★' : '☆'}
        </button>
      </div>
    );
  };

  // All models available for Customize visibility list
  const allCustomizableModels = useMemo(() => {
    const out = [];
    for (const sg of subscriptionGroups) {
      for (const m of sg.models.slice(0, 8)) {
        out.push({ key: m.pinKey, label: m.label, sub: sg.label });
      }
    }
    for (const c of configuredRows.slice(0, 12)) {
      out.push({ key: c.pinKey, label: c.label, sub: c.providerLabel });
    }
    return out;
  }, [subscriptionGroups, configuredRows]);

  return (
    <div className={`model-menu model-picker-v2 layout-${prefs.layout}`} ref={modelMenuRef} data-testid="model-picker-popover">
      {/* 1. Search + Layout Switcher + Customize Gear Header */}
      <div className="mp-toolbar">
        <div className="mp-search-box">
          <Icon name="Search" size={13} />
          <input
            ref={searchInputRef}
            type="text"
            data-testid="model-picker-search"
            className="mp-search-in"
            placeholder="Search models, CLIs, providers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          {search && (
            <button type="button" className="mp-search-clear" onClick={() => setSearch('')} title="Clear search">
              <Icon name="X" size={11} />
            </button>
          )}
        </div>

        <div className="mp-layout-tabs" role="group" aria-label="Model picker layout mode">
          {[
            { id: 'compact', label: 'List', fullLabel: 'Compact List', icon: 'Menu' },
            { id: 'cards', label: 'Cards', fullLabel: 'Grouped Cards', icon: 'Layers' },
            { id: 'grid', label: 'Grid', fullLabel: 'Quick-Switch Bar', icon: 'Grid' },
          ].map((m) => (
            <button
              key={m.id}
              type="button"
              data-testid={`layout-mode-${m.id}`}
              className={'mp-layout-btn' + (prefs.layout === m.id ? ' on' : '')}
              onClick={() => updatePrefs({ ...prefs, layout: m.id })}
              title={`Switch to ${m.fullLabel} layout`}
              aria-label={m.fullLabel}
            >
              <Icon name={m.icon} size={12} />
              <span>{m.label}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          data-testid="model-picker-customize-btn"
          className={'mp-gear-btn' + (customizeOpen ? ' on' : '')}
          onClick={() => setCustomizeOpen((v) => !v)}
          title="Customize Model Picker (layout, show/hide providers & models)"
          aria-expanded={customizeOpen}
        >
          <Icon name="Settings" size={14} />
        </button>
      </div>

      {/* Customize Drawer ("What to Show & What to Hide") */}
      {customizeOpen && (
        <div className="mp-customize-drawer" data-testid="model-picker-customize-drawer">
          <div className="mp-section-head">
            <span>Customize Model Picker</span>
            <button
              type="button"
              data-testid="model-picker-reset-btn"
              className="mp-signin-btn"
              onClick={() => updatePrefs(resetModelPickerPrefs())}
            >
              Reset to defaults
            </button>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[
              { id: 'compact', label: 'Compact List' },
              { id: 'cards', label: 'Grouped Cards' },
              { id: 'grid', label: 'Quick-Switch Bar' },
            ].map((m) => (
              <button
                key={'drawer:' + m.id}
                type="button"
                data-testid={`drawer-layout-${m.id}`}
                className={'mp-signin-btn' + (prefs.layout === m.id ? ' primary' : '')}
                onClick={() => updatePrefs({ ...prefs, layout: m.id })}
              >
                {m.label}
              </button>
            ))}
          </div>

          <label className="mp-cust-row">
            <span>Hide unconfigured providers (No API key)</span>
            <input
              type="checkbox"
              data-testid="toggle-hide-unconfigured"
              checked={!!prefs.hideUnconfiguredProviders}
              onChange={(e) => updatePrefs({ ...prefs, hideUnconfiguredProviders: e.target.checked })}
            />
          </label>

          <div>
            <div className="mp-section-head" style={{ paddingLeft: 0 }}><span>Show / Hide Providers</span></div>
            <div className="mp-cust-grid">
              {providerCatalog.map((pv) => {
                const shown = !prefs.hiddenProviders.includes(pv.id);
                return (
                  <label key={pv.id} className="mp-cust-check">
                    <input
                      type="checkbox"
                      data-testid={`toggle-provider-${pv.id}`}
                      checked={shown}
                      onChange={() => updatePrefs(toggleHiddenProvider(prefs, pv.id))}
                    />
                    <span title={pv.label}>{pv.label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {allCustomizableModels.length > 0 && (
            <div>
              <div className="mp-section-head" style={{ paddingLeft: 0 }}><span>Show / Hide Models</span></div>
              <div className="mp-cust-grid">
                {allCustomizableModels.map((cm) => {
                  const shown = !prefs.hiddenModels.includes(cm.key);
                  return (
                    <label key={cm.key} className="mp-cust-check" title={`${cm.label} (${cm.sub})`}>
                      <input
                        type="checkbox"
                        checked={shown}
                        onChange={() => updatePrefs(toggleHiddenModel(prefs, cm.key))}
                      />
                      <span>{cm.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main Scroll Area */}
      <div className="mp-scroll">
        {/* 2. Pinned Favorites / Quick-Switch Bar */}
        {pinnedItems.length > 0 && (
          <div data-testid="mp-pinned-section">
            <div className="mp-section-head">
              <span>★ Pinned Favorites</span>
              <span>{pinnedItems.length}</span>
            </div>
            {prefs.layout === 'grid' ? (
              <div className="mp-pinned-bar">
                {pinnedItems.map((item) => {
                  const active = isItemActive(item);
                  return (
                    <button
                      key={'pinpill:' + item.pinKey}
                      type="button"
                      className={'mp-pin-pill' + (active ? ' on' : '')}
                      onClick={() => selectItem(item)}
                    >
                      <ModelLogo model={item.id} provider={item.providerKey} size={13} />
                      <span>{item.label}</span>
                      {item.windowLabel && <span className="mp-pill ctx">{item.windowLabel}</span>}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div>{pinnedItems.map((item) => renderModelItem(item, 'pin:' + item.pinKey, item))}</div>
            )}
          </div>
        )}

        {/* 3. Active Subscription & Coding Plan Accounts FIRST */}
        {visibleSubscriptions.length > 0 && (
          <div data-testid="mp-subscriptions-section">
            <div className="mp-section-head">
              <span>Subscription CLIs &amp; Coding Plans</span>
              <button
                type="button"
                className="prov-link"
                onClick={async () => {
                  try {
                    if (window.autobot?.refreshModelCatalogs) await window.autobot.refreshModelCatalogs();
                    if (loadProvOauth) await loadProvOauth();
                  } catch (_) {}
                }}
              >
                <Icon name="Refresh" size={11} /> Refresh
              </button>
            </div>
            {provOauth && provOauth.storeError && <ProvNotice warn text={T('account.storeError')} />}

            {prefs.layout === 'compact' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {visibleSubscriptions.map((sg) => (
                  <React.Fragment key={sg.id}>
                    <div className="mp-model-row" style={{ justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                        <ModelLogo provider={sg.id} size={15} />
                        <span className="mp-model-label">{sg.label}</span>
                        <span className={'mp-pill ' + (sg.connected ? 'plan' : 'cli')}>
                          {sg.connected ? (sg.activeAcct?.plan || 'Connected') : sg.planBadge}
                        </span>
                      </div>
                      <button type="button" data-testid={`picker-signin-${sg.id}`} className={'mp-signin-btn' + (!sg.connected ? ' primary' : '')} onClick={() => cliLogin.start(sg.id)}>
                        {sg.connected ? 'Reconnect' : 'Sign in'}
                      </button>
                    </div>
                    {sg.models.map((m) => renderModelItem(m, `cmp:${sg.id}:${m.id}`, m))}
                  </React.Fragment>
                ))}
              </div>
            ) : prefs.layout === 'grid' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="mp-acct-chip-row">
                  {visibleSubscriptions.map((sg) => (
                    <button
                      key={'qsign:' + sg.id}
                      type="button"
                      data-testid={`picker-signin-${sg.id}`}
                      className={'mp-signin-btn' + (!sg.connected ? ' primary' : '')}
                      onClick={() => cliLogin.start(sg.id)}
                    >
                      {sg.label.split(' ')[0]} · {sg.connected ? 'Reconnect' : 'Sign in'}
                    </button>
                  ))}
                </div>
                <div className="mp-grid">
                  {visibleSubscriptions.flatMap((sg) => sg.models.slice(0, query ? 20 : 4).map((m) => renderModelItem(m, `grd:${sg.id}:${m.id}`, m)))}
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {visibleSubscriptions.map((sg) => {
                  const isCollapsed = !!collapsedProviders[sg.id] && !query;
                  return (
                    <div key={sg.id} className={'mp-sub-card' + (sg.connected ? ' connected' : '')} data-testid={`sub-card-${sg.id}`}>
                      <div className="mp-sub-head">
                        <button
                          type="button"
                          className="mp-sub-title-btn"
                          onClick={() => setCollapsedProviders((c) => ({ ...c, [sg.id]: !c[sg.id] }))}
                          aria-expanded={!isCollapsed}
                        >
                          <ModelLogo provider={sg.id} size={16} />
                          <span className="mp-sub-name">{sg.label}</span>
                          <span className={'mp-pill ' + (sg.connected ? 'plan' : 'cli')}>
                            {sg.connected ? (sg.activeAcct?.plan || 'Connected') : sg.planBadge}
                          </span>
                          <Icon name={isCollapsed ? 'CaretRight' : 'CaretDown'} size={11} />
                        </button>
                        <button
                          type="button"
                          data-testid={`picker-signin-${sg.id}`}
                          className={'mp-signin-btn' + (!sg.connected ? ' primary' : '')}
                          onClick={() => cliLogin.start(sg.id)}
                        >
                          {sg.connected ? 'Reconnect' : 'Sign in'}
                        </button>
                      </div>

                      {sg.accounts.length > 0 && (
                        <div className="mp-acct-chip-row">
                          {sg.accounts.map((a) => {
                            const on = provider.oauthProvider === a.id;
                            return (
                              <div key={a.id} className={'mp-acct-chip' + (on ? ' on' : '')}>
                                <button type="button" className="mp-acct-chip-pick" onClick={() => pickOauthAccount(sg.pv, a.account)}>
                                  <span className={'model-dot ' + (a.expired || a.needsSignIn ? 'out' : 'ok')} />
                                  <span>{a.label || a.account}</span>
                                </button>
                                <button type="button" className="mp-acct-chip-x" title="Sign out" disabled={!!provBusy} onClick={() => providerAction('signout', sg.id, a.account)}>
                                  <Icon name="X" size={11} />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {!isCollapsed && (
                        <div>
                          {sg.models.slice(0, query ? 30 : 8).map((m) => renderModelItem(m, `crd:${sg.id}:${m.id}`, m))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 4. Routing Modes (Auto DeepSeek & Orchestrator) */}
        <div className="model-menu-divider" />
        <div>
          <div className="mp-section-head">
            <span>Routing mode</span>
            {onOpenTutorial && (
              <button type="button" data-testid="open-mode-guide-btn" className="prov-link" onClick={() => { setModelMenuOpen(false); onOpenTutorial('guide'); }}>
                Quick Guide →
              </button>
            )}
          </div>

          <div className={'routing-mode-wrap' + (effectiveRoutingMode === 'auto' ? ' on' : '')}>
            <button type="button" data-testid="routing-mode-auto" className={'model-opt routing-mode-card' + (effectiveRoutingMode === 'auto' ? ' on' : '')} onClick={selectAutoMode}>
              <ModelLogo model="deepseek" size={18} className="routing-mode-logo" />
              <div className="routing-mode-main">
                <span className="model-opt-name">⚡ Auto (DeepSeek V4.1 Flash)</span>
                <span className="routing-mode-sub">
                  {hasDeepSeekKey
                    ? 'DeepSeek Dispatcher active — picks Fast, Coder, Frontier, Vision, or 1M model per prompt'
                    : 'Offline heuristic fallback ready — configure a DeepSeek key for ~150ms AI task dispatch'}
                </span>
              </div>
              {effectiveRoutingMode === 'auto' && <Icon name="Check" size={13} className="model-check" />}
            </button>
            {!hasDeepSeekKey && (
              <div className="routing-mode-config-bar">
                <button type="button" data-testid="configure-deepseek-key-btn" className="configure-deepseek-pill" onClick={() => { setModelMenuOpen(false); openSettings({ section: 'system', focus: 'deepseek-router' }); }}>
                  Setup Free Key →
                </button>
              </div>
            )}
          </div>

          <div className={'orch-picker-box' + (effectiveRoutingMode === 'orchestrator' ? ' on' : '')} data-testid="routing-mode-orchestrator">
            <div className="orch-picker-head">
              <button type="button" className="orch-picker-toggle" onClick={() => setOrchExpanded((v) => !v)} aria-expanded={orchExpanded}>
                <ModelLogo model="orchestrator" size={16} />
                <span className="model-opt-name">🛰️ Orchestrator Models</span>
                {effectiveRoutingMode === 'orchestrator' && <span className="orch-active-tag">On</span>}
                <Icon name={orchExpanded ? 'CaretUp' : 'CaretDown'} size={11} />
              </button>
              <button type="button" data-testid="orch-configure-btn" className="orch-config-link" onClick={() => { setModelMenuOpen(false); openSettings({ section: 'orchestrator' }); }}>
                Configure…
              </button>
            </div>
            {(orchExpanded || effectiveRoutingMode === 'orchestrator') && (() => {
              const hasMatchingOrchRow = effectiveRoutingMode === 'orchestrator' && orchModelChoices.some((r) => provider.model === r.model && String(provider.oauthProvider || '') === String(r.oauthProvider || ''));
              return (
                <div className="orch-picker-body">
                  <button type="button" data-testid="orch-use-supervisor" className={'model-opt orch-supervisor-btn' + (effectiveRoutingMode === 'orchestrator' && !hasMatchingOrchRow ? ' on' : '')} onClick={() => activateOrchestratorSupervisor(null)}>
                    <ModelLogo model="orchestrator" size={14} />
                    <span className="model-opt-name">Activate Orchestrator (Use Selected Model as Supervisor)</span>
                    {effectiveRoutingMode === 'orchestrator' && !hasMatchingOrchRow && <Icon name="Check" size={13} className="model-check" />}
                  </button>
                  {orchModelChoices.length > 0 ? orchModelChoices.slice(0, 12).map((row) => {
                    const rowActive = effectiveRoutingMode === 'orchestrator' && provider.model === row.model && String(provider.oauthProvider || '') === String(row.oauthProvider || '');
                    return (
                      <button key={`${row.model}|${row.oauthProvider || row.baseURL || ''}`} type="button" className={'model-opt' + (rowActive ? ' on' : '')} onClick={() => activateOrchestratorSupervisor(row)}>
                        <span className="model-dot ok" />
                        <ModelLogo model={row.model} provider={row.oauthProvider || row.name} baseURL={row.baseURL} size={14} />
                        <span className="model-opt-name">{row.model.split('/').pop()}</span>
                        <span className="model-opt-prov" title={row.roleHint || row.name || 'Orchestrator'}>{row.roleHint || row.name || 'Orchestrator'}</span>
                        {rowActive && <Icon name="Check" size={13} className="model-check" />}
                      </button>
                    );
                  }) : (
                    <div className="prov-none">No Orchestrator models selected — click Configure… to connect CLIs or API keys</div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>

        {/* 5. Configured Local / Paid API Endpoints */}
        {(visibleConfigured.length > 0 || ollamaEmpty) && (
          <div data-testid="mp-configured-section">
            <div className="mp-section-head">
              <span>Configured API &amp; Local Endpoints{keyProbing ? ' · checking…' : ''}</span>
              <span>{visibleConfigured.length}</span>
            </div>
            {ollamaEmpty && (
              <button type="button" className="model-opt model-connect" disabled={ollamaBusy} onClick={connectOllama}>
                <ModelLogo provider="ollama" size={15} />
                <span className="model-opt-name">{ollamaBusy ? 'Connecting to Ollama…' : 'Connect Ollama (local)'}</span>
                <span className="model-opt-prov">{ollamaBusy ? '' : 'starts server'}</span>
              </button>
            )}
            <div className={prefs.layout === 'grid' ? 'mp-grid' : ''}>
              {visibleConfigured.slice(0, query ? 80 : 24).map((item) => renderModelItem(item, item.row.key, item))}
            </div>
          </div>
        )}

        {/* 6. Unconfigured Providers (Hidden by default!) */}
        {prefs.hideUnconfiguredProviders && unconfiguredRows.length > 0 && (
          <div className="mp-hidden-bar" data-testid="mp-hidden-unconfigured-bar">
            <span>{unconfiguredRows.length} unconfigured provider{unconfiguredRows.length === 1 ? '' : 's'} hidden (No API key)</span>
            <button type="button" className="mp-signin-btn" onClick={() => updatePrefs({ ...prefs, hideUnconfiguredProviders: false })}>
              Show
            </button>
          </div>
        )}

        {!prefs.hideUnconfiguredProviders && visibleUnconfigured.length > 0 && (
          <div data-testid="mp-unconfigured-section">
            <div className="mp-section-head">
              <span>Unconfigured API Presets</span>
              <button type="button" className="prov-link" onClick={() => updatePrefs({ ...prefs, hideUnconfiguredProviders: true })}>Hide</button>
            </div>
            <div className={prefs.layout === 'grid' ? 'mp-grid' : ''}>
              {visibleUnconfigured.map((item) => renderModelItem(item, item.row.key, item))}
            </div>
          </div>
        )}

        <ProvNotice text={provNotice} />
      </div>

      {/* Footer Actions */}
      <div className="mp-foot">
        <button type="button" className="btn-mini" disabled={!!provBusy} onClick={() => providerAction('import')}>
          <Icon name="Refresh" size={11} /> {provBusy === 'import:' ? 'Syncing…' : 'Sync CLIs'}
        </button>
        <button type="button" className="btn-mini" onClick={() => { setModelMenuOpen(false); openSettings(); }}>
          <Icon name="Settings" size={11} /> Manage providers…
        </button>
      </div>

      <CliLoginModal controller={cliLogin} />
    </div>
  );
}

export default ModelPickerPopover;
