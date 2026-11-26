import React, { useEffect, useState } from 'react';
import akronMark3d from '../assets/akron-mark-3d.webp';

const FALLBACK_LICENSE = `# Akron Code Source-Available & Open Ecosystem License

Copyright (c) 2026 AkronLogic (https://akronlogic.com). All rights reserved.

1. Open Use & Open Ecosystem Grant: Free for personal, educational, internal business, and commercial software development. You are encouraged to build, publish, monetize, or open-source Skills, Plugins, Extensions, MCP Servers, Custom Agent Tools, Agent Notes, and Remote Server adapters under any license (MIT, Apache-2.0, GPL, or proprietary).
2. Brand, Attribution & Anti-Tamper Restrictions: Retain Akron Code, Akron Browser Bot, "by Akronlogic.com" attribution, AkronLogic copyright notices, LICENSE.md, TRADEMARKS.md, the About panel, brand logos, brand-seal verification, and Electron security fuses. White-labeling or rebranded redistribution is prohibited.
3. Warranty Disclaimer: Provided "AS IS" without warranty of any kind.`;

const FALLBACK_TRADEMARKS = `# AkronLogic Trademark Policy

Akron Code, Akron Browser Bot, AkronLogic, akronlogic.com, and the Akron brand marks are protected trademarks and brand assets of AkronLogic.
- Permitted: Truthful reference in tutorials, reviews, and labeling third-party add-ons as "Works with Akron Code" or "MCP Server for Akron Code".
- Prohibited: White-labeling, removing attribution/About/brand assets, or implying unofficial distributions are official AkronLogic releases.`;

const HIGHLIGHTS = [
  {
    title: 'Native Multi-Agent Coding IDE',
    desc: 'Built-in Monaco editor, symbol outline, multi-PTY terminal, Git worktree manager, and inline code review workbench.',
  },
  {
    title: 'Swarm & Multi-Model Pools',
    desc: 'Orchestrate planner, coder, vision, and fast-model failover tiers with FreeLLMAPI pools, OAuth subscriptions, or local Ollama.',
  },
  {
    title: '146+ Tools, MCP & REA Runtime',
    desc: 'First-class MCP connectors, custom creator tools, and built-in REA reverse-engineering inspection across binaries and apps.',
  },
  {
    title: 'Browser Bot, SSH & Offline Voice',
    desc: 'Inspect Element DOM capture, zero-key Chrome extension bridge, encrypted-token remote/SSH execution, and local ONNX Whisper dictation.',
  },
];

export function AboutSection({ theme, setNotice }) {
  const isLight = theme === 'light';
  const [ver, setVer] = useState(null);
  const [brand, setBrand] = useState(null);
  const [docs, setDocs] = useState({
    license: FALLBACK_LICENSE,
    trademarks: FALLBACK_TRADEMARKS,
    copyright: 'Copyright (c) 2026 AkronLogic (https://akronlogic.com). All rights reserved.',
  });
  const [activeDoc, setActiveDoc] = useState('license');

  useEffect(() => {
    let alive = true;
    const api = typeof window !== 'undefined' ? window.autobot : null;
    if (!api) return undefined;
    Promise.allSettled([
      api.getVersion ? api.getVersion() : Promise.resolve(null),
      api.brandStatus ? api.brandStatus() : Promise.resolve(null),
      api.getLegalDocs ? api.getLegalDocs() : Promise.resolve(null),
    ]).then(([vRes, bRes, dRes]) => {
      if (!alive) return;
      if (vRes.status === 'fulfilled' && vRes.value) setVer(vRes.value);
      if (bRes.status === 'fulfilled' && bRes.value) setBrand(bRes.value);
      if (dRes.status === 'fulfilled' && dRes.value && dRes.value.ok) {
        setDocs((prev) => ({
          license: dRes.value.license || prev.license,
          trademarks: dRes.value.trademarks || prev.trademarks,
          copyright: dRes.value.copyright || prev.copyright,
        }));
      }
    });
    return () => { alive = false; };
  }, []);

  const appVersion = (ver && ver.app) || '1.0.0';
  const openExternal = (url) => {
    try {
      if (window.autobot && window.autobot.openExternal) window.autobot.openExternal(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch (_) {}
  };

  const copyDiagnostics = () => {
    const lines = [
      `Akron Code v${appVersion} (by AkronLogic / akronlogic.com)`,
      `Electron: ${(ver && ver.electron) || 'n/a'}`,
      `Chromium: ${(ver && ver.chrome) || 'n/a'}`,
      `Node.js: ${(ver && ver.node) || 'n/a'}`,
      `Platform: ${(ver && ver.platform) || 'desktop'} (${(ver && ver.arch) || 'unknown'})`,
      `Brand Seal: ${brand && brand.ok ? `Verified (${brand.checkedFiles} assets, ${String(brand.sealDigest || '').slice(0, 12)})` : 'Unavailable'}`,
    ].join('\n');
    try {
      navigator.clipboard?.writeText(lines);
      if (setNotice) setNotice('System diagnostics copied');
    } catch (_) {}
  };

  const activeText = activeDoc === 'trademarks' ? docs.trademarks : docs.license;
  const copyLegalText = () => {
    try {
      navigator.clipboard?.writeText(activeText);
      if (setNotice) setNotice(activeDoc === 'trademarks' ? 'TRADEMARKS.md copied' : 'LICENSE.md copied');
    } catch (_) {}
  };

  const wordStart = isLight ? '#334155' : '#f8fafc';
  const wordEnd = isLight ? '#0f172a' : '#cbd5e1';
  const subColor = isLight ? '#5b6b82' : '#94a3b8';

  return (
    <>
      <div className="settings-card about-hero">
        <div className="about-lockup-wrap">
          <svg
            className="about-lockup-svg"
            viewBox="0 0 500 120"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label="Akron Logic — Global Tech & Infrastructure"
          >
            <defs>
              <linearGradient id="akron-word" x1="0" y1="0" x2="0.3" y2="1">
                <stop offset="0%" stopColor={wordStart} />
                <stop offset="100%" stopColor={wordEnd} />
              </linearGradient>
            </defs>
            <g transform="translate(8, 10)">
              <image
                href={akronMark3d}
                x="0"
                y="0"
                width="100"
                height="100"
                preserveAspectRatio="xMidYMid meet"
                data-intrinsic="518x508"
              />
            </g>
            <text
              x="126"
              y="62"
              fontFamily="'Plus Jakarta Sans', 'Inter', ui-sans-serif, system-ui, sans-serif"
              fontWeight="800"
              fontSize="42"
              letterSpacing="1.5"
              fill="url(#akron-word)"
            >
              AKRON<tspan fill="#0284c7">LOGIC</tspan>
            </text>
            <text
              x="128"
              y="88"
              fontFamily="'Inter', 'Work Sans', ui-sans-serif, system-ui, sans-serif"
              fontWeight="600"
              fontSize="12"
              letterSpacing="4.2"
              fill={subColor}
            >
              GLOBAL TECH &amp; INFRASTRUCTURE
            </text>
          </svg>
        </div>

        <div className="about-hero-meta">
          <div className="about-title-row">
            <div>
              <h3 className="about-product-name">Akron Code</h3>
              <p className="about-product-sub">Autonomous multi-agent coding IDE by Akronlogic.com</p>
            </div>
            <div className="about-badges">
              <span className="about-badge">v{appVersion}</span>
              {brand && brand.ok ? (
                <span className="about-badge ok">Brand Seal Verified • {brand.checkedFiles} assets</span>
              ) : (
                <span className="about-badge warn">Brand Seal: {brand ? 'Attention Needed' : 'Checking…'}</span>
              )}
            </div>
          </div>

          <div className="about-actions">
            <button type="button" className="btn-mini primary" onClick={() => openExternal('https://akronlogic.com')}>
              akronlogic.com
            </button>
            <button type="button" className="btn-mini" onClick={() => openExternal('https://github.com/faysaliteng/akron-code/releases')}>
              GitHub Releases
            </button>
            <button type="button" className="btn-mini" onClick={copyDiagnostics}>
              Copy Diagnostics
            </button>
            <button type="button" className="btn-mini" onClick={() => window.autobot?.openAbout?.()}>
              About Window
            </button>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <h3>About Akron Code</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Engineered by <strong>AkronLogic</strong> as an end-to-end desktop coding workstation combining multi-agent swarms,
          direct local &amp; remote repository execution, visual browser automation, and deep binary inspection in one unified workspace.
        </p>
        <div className="about-feature-grid">
          {HIGHLIGHTS.map((item) => (
            <div key={item.title} className="about-feature-item">
              <div className="about-feature-title">{item.title}</div>
              <div className="about-feature-desc">{item.desc}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="settings-card">
        <h3>Runtime &amp; Build Details</h3>
        <div className="about-meta-grid">
          <div className="about-meta-cell">
            <span>Application</span>
            <strong>Akron Code v{appVersion}</strong>
          </div>
          <div className="about-meta-cell">
            <span>Publisher</span>
            <strong>AkronLogic (akronlogic.com)</strong>
          </div>
          <div className="about-meta-cell">
            <span>Electron</span>
            <strong>{(ver && ver.electron) || 'Bundled'}</strong>
          </div>
          <div className="about-meta-cell">
            <span>Chromium / Node.js</span>
            <strong>{ver ? `${ver.chrome} / ${ver.node}` : 'Bundled'}</strong>
          </div>
          <div className="about-meta-cell">
            <span>Platform &amp; Arch</span>
            <strong>{ver ? `${ver.platform} (${ver.arch})` : 'Desktop'}</strong>
          </div>
          <div className="about-meta-cell">
            <span>Cryptographic Brand Seal</span>
            <strong>
              {brand && brand.ok
                ? `Verified • ${brand.checkedFiles} assets (${String(brand.sealDigest || '').slice(0, 12)}…)`
                : 'Local verification active'}
            </strong>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <h3>License &amp; Trademarks</h3>
        <p className="muted" style={{ marginTop: 0 }}>{docs.copyright}</p>

        <div className="about-license-split">
          <div className="about-license-box">
            <div className="about-license-head">Open Use &amp; Open Ecosystem Grant</div>
            <ul>
              <li>Free for personal, educational, internal business, and commercial development.</li>
              <li>Build, publish, monetize, or open-source Skills, Plugins, Extensions, MCP Servers, Custom Tools &amp; Remote Adapters under any license (MIT, Apache-2.0, GPL, or proprietary).</li>
              <li>Inspect source code, build locally, and contribute fixes upstream.</li>
            </ul>
          </div>
          <div className="about-license-box">
            <div className="about-license-head">Brand, Attribution &amp; Integrity</div>
            <ul>
              <li>Preserve <strong>Akron Code</strong>, <strong>Akron Browser Bot</strong>, <strong>by Akronlogic.com</strong> attribution, logos, and license/trademark notices.</li>
              <li>White-labeling or redistributing modified binaries under a different product name or icon set is not permitted.</li>
              <li>Do not bypass brand-seal verification or Electron security fuses in distributed builds.</li>
            </ul>
          </div>
        </div>

        <div className="about-legal-bar">
          <div className="about-legal-tabs" role="tablist" aria-label="Legal documents">
            <button
              type="button"
              role="tab"
              aria-selected={activeDoc === 'license'}
              className={'btn-mini' + (activeDoc === 'license' ? ' primary' : '')}
              onClick={() => setActiveDoc('license')}
            >
              License (LICENSE.md)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeDoc === 'trademarks'}
              className={'btn-mini' + (activeDoc === 'trademarks' ? ' primary' : '')}
              onClick={() => setActiveDoc('trademarks')}
            >
              Trademarks (TRADEMARKS.md)
            </button>
          </div>
          <div className="about-legal-actions">
            <button type="button" className="btn-mini" onClick={copyLegalText}>
              Copy Text
            </button>
            <button type="button" className="btn-mini" onClick={() => window.autobot?.openLegalDoc?.(activeDoc)}>
              Open File
            </button>
          </div>
        </div>

        <pre className="about-legal-doc">{activeText}</pre>
      </div>
    </>
  );
}
