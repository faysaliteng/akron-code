'use strict';
const computer = require('../computer');
const chrome = require('../chrome');
const browser = require('../browser');
const untrusted = require('../untrusted');

module.exports = function buildBrowserAndCuExecutors({ truncate }) {
  return {
  // ---- Computer Use ----
  async computer_screenshot({ dir }) {
    const r = await computer.screenshot({ dir });
    return `Screenshot saved: ${r.path} (${r.size} bytes)`;
  },
  async computer_click({ x, y, button, double }) {
    await computer.click(Number(x), Number(y), button, !!double);
    return `Clicked at (${x}, ${y}).`;
  },
  async computer_move({ x, y }) {
    await computer.move(Number(x), Number(y));
    return `Moved mouse to (${x}, ${y}).`;
  },
  async computer_drag({ x1, y1, x2, y2 }) {
    await computer.drag(Number(x1), Number(y1), Number(x2), Number(y2));
    return `Dragged from (${x1},${y1}) to (${x2},${y2}).`;
  },
  async computer_scroll({ direction, amount }) {
    await computer.scroll(direction, amount);
    return 'Scrolled.';
  },
  async computer_type({ text }) {
    await computer.type(text);
    return 'Typed.';
  },
  async computer_key({ keys }) {
    await computer.key(keys);
    return 'Key pressed.';
  },
  async computer_screen_size() {
    const s = await computer.screenSize();
    return `Screen: ${s.width}x${s.height}`;
  },

  // ---- Chrome (CDP) ----
  async chrome_list_tabs() {
    const ts = await chrome.getTargets();
    return ts.length ? untrusted.wrapUntrusted(ts.map((t) => `- ${t.id}: ${t.title} (${t.url})`).join('\n'), { source: 'ChromeCDP' }) : '(no Chrome tabs found)';
  },
  async chrome_navigate({ url, targetId }) {
    const { cdp } = await chrome.connectToTarget(targetId);
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url });
    cdp.close();
    return `Navigated to ${url}`;
  },
  async chrome_evaluate({ expression, targetId }) {
    const { cdp } = await chrome.connectToTarget(targetId);
    const v = await chrome.evaluate(cdp, expression);
    cdp.close();
    return untrusted.wrapUntrusted(String(v), { source: 'ChromeCDP' });
  },
  async chrome_screenshot({ targetId }) {
    const { cdp } = await chrome.connectToTarget(targetId);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    cdp.close();
    return r && r.data ? `base64 PNG (length ${r.data.length})` : '(no screenshot)';
  },

  // ---- Built-in Browser (the in-app <webview> pane) ----
  async browser_open({ url, cwd }) {
    const r = await browser.loadURL(url, cwd);
    if (!r.ok) return 'Browser error: ' + r.error;
    return `Opened ${r.url} in the built-in browser.`;
  },
  async browser_navigate({ url, cwd }) {
    const r = await browser.loadURL(url, cwd);
    if (!r.ok) return 'Browser error: ' + r.error;
    return `Navigated to ${r.url}.`;
  },
  async browser_back() {
    const r = await browser.goBack();
    return r.ok ? `Went back to ${r.url || 'previous page'}.` : 'Browser error: ' + r.error;
  },
  async browser_forward() {
    const r = await browser.goForward();
    return r.ok ? `Went forward to ${r.url || 'next page'}.` : 'Browser error: ' + r.error;
  },
  async browser_reload() {
    const r = await browser.reload();
    return r.ok ? 'Reloaded.' : 'Browser error: ' + r.error;
  },
  async browser_stop() {
    const r = await browser.stop();
    return r.ok ? 'Stopped.' : 'Browser error: ' + r.error;
  },
  async browser_read() {
    const r = await browser.read();
    if (!r.ok) return 'Browser error: ' + r.error;
    const gate = require('./browser-bot-v2').detectHumanGate({ url: r.url, title: r.title, text: r.text });
    const notice = gate.gated ? `\n[HUMAN_HANDOFF_REQUIRED (${gate.gateType})]: ${gate.reason}\n` : '';
    return untrusted.wrapUntrusted(truncate(`PAGE: ${r.title}\nURL: ${r.url}${notice}\n\n${r.text || '(no visible text)'}`), { source: 'BrowserDOM', url: r.url || '' });
  },
  async browser_snapshot(args = {}) {
    if (args.compactAx !== false && typeof browser.snapshotAx === 'function') {
      const ax = await browser.snapshotAx({ som: !!args.som, somFallback: args.somFallback !== false, maxItems: args.maxItems });
      if (ax && ax.ok && ax.snapshotText) {
        const notice = ax.gate && ax.gate.gated ? `\n[HUMAN_HANDOFF_REQUIRED (${ax.gate.gateType})]: ${ax.gate.reason}\n` : '';
        const somNote = ax.som && ax.som.count ? `\n[Set-of-Marks visual badges active: ${ax.som.count} targets]` : '';
        return untrusted.wrapUntrusted(truncate(`${ax.snapshotText}${somNote}${notice}`), { source: 'BrowserAX', url: ax.url || '' });
      }
      if (ax && !ax.ok) return 'Browser error: ' + ax.error;
    }
    const r = await browser.read();
    if (!r.ok) return 'Browser error: ' + r.error;
    const lines = [`PAGE: ${r.title}`, `URL: ${r.url}`];
    if (r.links && r.links.length) { lines.push('\nLINKS:'); r.links.forEach((l) => lines.push('- ' + l)); }
    if (r.buttons && r.buttons.length) { lines.push('\nBUTTONS:'); r.buttons.forEach((b) => lines.push('- ' + b)); }
    if (r.inputs && r.inputs.length) { lines.push('\nINPUTS:'); r.inputs.forEach((i) => lines.push(`- <${i.tag}> name="${i.name}" type="${i.type}" placeholder="${i.placeholder}"`)); }
    return untrusted.wrapUntrusted(truncate(lines.join('\n')), { source: 'BrowserDOM', url: r.url || '' });
  },
  async browser_vault_autofill({ origin, selectors } = {}) {
    const v2 = require('./browser-bot-v2');
    const pageUrl = browser.getURL();
    const res = await v2.vaultAutofill({
      pageUrl,
      expectedOrigin: origin || pageUrl,
      selectors: selectors || {},
      injectFn: async (assignments) => {
        const applied = [];
        for (const item of assignments) {
          const r = await browser.type(item.selector, item.value);
          if (r && r.ok && r.found) applied.push(item.field);
        }
        return { applied };
      },
    });
    return JSON.stringify(res);
  },
  async browser_replay_skill({ name, skipStartUrl } = {}) {
    const skills = require('./browser-skills');
    const sk = skills.loadSkill(name);
    if (!sk) return `Browser skill "${name}" not found.`;
    const res = await skills.replaySkill(sk, {
      navigate: (u) => browser.loadURL(u),
      click: (t) => browser.click(t),
      type: (t, v) => browser.type(t, v),
      select: (t, v) => browser.select(t, v),
      press: (k) => browser.press(k),
      hover: (t) => browser.hover(t),
      snapshot: () => browser.snapshotAx(),
    }, { skipStartUrl: !!skipStartUrl });
    return JSON.stringify(res);
  },
  async browser_click({ selector, index }) {
    const r = await browser.click(selector, index);
    if (!r.ok) return 'Browser error: ' + r.error;
    if (!r.found) return `No element matched selector "${selector}" at index ${Number(index) || 0}.`;
    return `Clicked <${r.tag}> "${r.text}".`;
  },
  async browser_type({ selector, text }) {
    const r = await browser.type(selector, text);
    if (!r.ok) return 'Browser error: ' + r.error;
    if (!r.found) return `No element matched selector "${selector}".`;
    return `Typed into ${selector}.`;
  },
  async browser_press({ key }) {
    const r = await browser.press(key);
    return r.ok ? `Pressed "${key}".` : 'Browser error: ' + r.error;
  },
  async browser_js({ code }) {
    const r = await browser.executeJS(code, true);
    if (!r.ok) return 'Browser error: ' + r.error;
    return typeof r.result === 'object' ? JSON.stringify(r.result, null, 2) : String(r.result);
  },
  async browser_hover({ selector, index }) {
    const r = await browser.hover(selector, index);
    if (!r.ok) return 'Browser error: ' + r.error;
    if (!r.found) return `No element matched selector "${selector}" at index ${Number(index) || 0}.`;
    return `Hovered <${r.tag}> "${r.text}".`;
  },
  async browser_select({ selector, value }) {
    const r = await browser.select(selector, value);
    if (!r.ok) return 'Browser error: ' + r.error;
    if (!r.found) return `No <select> matched selector "${selector}".`;
    return `Selected "${r.value}" in ${selector}.`;
  },
  async browser_scroll({ direction, amount, selector }) {
    const r = await browser.scroll(direction, amount, selector);
    if (!r.ok) return 'Browser error: ' + r.error;
    const pos = r.scrollY != null ? `scrollY=${r.scrollY}` : `scrollTop=${r.scrollTop}`;
    return `Scrolled ${String(direction || 'down')} ${amount == null ? 600 : amount}px (${pos}).`;
  },
  async browser_wait_for({ selector, timeoutMs }) {
    const r = await browser.waitFor(selector, timeoutMs);
    if (!r.ok) return 'Browser error: ' + r.error;
    return r.found ? `Element "${selector}" appeared after ${r.waited}ms.` : `Timed out after ${r.waited}ms waiting for "${selector}".`;
  },
  async browser_screenshot({ fullPage }) {
    const r = await browser.screenshot(!!fullPage);
    if (!r.ok) return 'Browser error: ' + r.error;
    let previewDataUrl = '';
    let cachePath = '';
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const crypto = require('crypto');
      if (r.path && fs.existsSync(r.path)) {
        const cacheDir = path.join(os.homedir(), '.autobot', 'media-cache');
        fs.mkdirSync(cacheDir, { recursive: true });
        const hash = crypto.createHash('sha1').update(r.path).digest('hex').slice(0, 8);
        cachePath = path.join(cacheDir, `${Date.now()}-${hash}-${path.basename(r.path)}`);
        fs.copyFileSync(r.path, cachePath);
        const buf = fs.readFileSync(r.path);
        if (buf.length <= 4 * 1024 * 1024) {
          previewDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
        }
      }
    } catch (_) {}
    return JSON.stringify({
      ok: true,
      path: r.path,
      cachePath,
      previewDataUrl,
      width: r.width,
      height: r.height,
      fullPage: !!fullPage,
      summary: `Screenshot saved: ${r.path} (${r.width}x${r.height}${fullPage ? ', full page' : ''}).`,
    }, null, 2);
  },
  async browser_tabs({ action, url, index }) {
    const act = String(action || 'list').toLowerCase();
    if (act === 'list') {
      const r = browser.listTabs();
      if (!r.tabs || !r.tabs.length) return 'No browser tabs (pane closed).';
      return 'TABS:\n' + r.tabs.map((t, i) => `${i + 1}. ${t.title || '(untitled)'} — ${t.url}${t.id === r.activeId ? ' [active]' : ''}`).join('\n');
    }
    if (act === 'new') {
      const r = browser.sendTabCommand({ type: 'new', url: url ? browser.normalizeUrl(url) : undefined });
      if (!r.ok) return 'Browser error: ' + r.error;
      await new Promise((res) => setTimeout(res, 1500));
      const st = browser.listTabs();
      const t = (st.tabs || []).find((x) => x.id === st.activeId);
      return t ? `Opened new tab: ${t.title || t.url} — ${t.url}` : 'Opened a new tab.';
    }
    const state = browser.listTabs();
    if (act === 'close' || act === 'switch') {
      const tabs = state.tabs || [];
      const target = tabs[Number(index)] || tabs.find((t) => t.id === state.activeId) || null;
      if (!target) return 'No such tab.';
      const r = browser.sendTabCommand({ type: act, tabId: target.id });
      if (!r.ok) return 'Browser error: ' + r.error;
      await new Promise((res) => setTimeout(res, act === 'switch' ? 400 : 700));
      if (act === 'switch') {
        const wid = browser.getGuest();
        const u = wid ? (() => { try { return wid.getURL(); } catch (e) { return ''; } })() : '';
        return `Switched to tab "${target.title || target.url}"${u ? ' — ' + u : ''}.`;
      }
      return `Closed tab "${target.title || target.url}".`;
    }
    return `Unknown action "${action}". Use list, new, switch, or close.`;
  },

  };
};