'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');

function loadBrowserWithMockElectron() {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        webContents: { fromId: () => null },
      };
    }
    return origLoad.apply(this, arguments);
  };
  try {
    return require(path.join(ROOT, 'electron', 'browser.js'));
  } finally {
    Module._load = origLoad;
  }
}

function makeFakeDom() {
  const elementsById = new Map();
  const listeners = new Map();
  const logs = [];

  class FakeElement {
    constructor(tagName, id = '', className = '', parent = null) {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.className = className;
      this.parentElement = parent;
      this.children = [];
      this.nodeType = 1;
      this.style = {};
      this.textContent = '';
      this.innerText = 'Sign Up Now';
      this.outerHTML = `<${tagName} id="${id}" class="${className}">Sign Up Now</${tagName}>`;
      this._rect = { left: 40, top: 80, width: 420, height: 180, right: 460, bottom: 260 };
    }
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      if (child.id) elementsById.set(child.id, child);
      return child;
    }
    remove() {
      if (this.id) elementsById.delete(this.id);
    }
    getBoundingClientRect() {
      return this._rect;
    }
  }

  const htmlEl = new FakeElement('html');
  const bodyEl = new FakeElement('body', '', '', htmlEl);
  const cardBtn = new FakeElement('div', '', 'card featured', bodyEl);
  htmlEl.appendChild(bodyEl);
  bodyEl.appendChild(cardBtn);

  const document = {
    title: 'Akron Test Page',
    documentElement: htmlEl,
    body: bodyEl,
    createElement(tag) { return new FakeElement(tag); },
    getElementById(id) { return elementsById.get(id) || null; },
    elementFromPoint() { return cardBtn; },
    addEventListener(type, fn, cap) {
      const k = `${type}:${!!cap}`;
      if (!listeners.has(k)) listeners.set(k, new Set());
      listeners.get(k).add(fn);
    },
    removeEventListener(type, fn, cap) {
      const k = `${type}:${!!cap}`;
      if (listeners.has(k)) listeners.get(k).delete(fn);
    },
  };

  const sandbox = {
    window: null,
    document,
    location: { href: 'https://example.test/pricing' },
    console: { debug: (m) => logs.push(String(m)) },
    CSS: { escape: (s) => s },
    getComputedStyle: () => ({ display: 'flex', backgroundColor: 'rgb(16, 185, 129)', fontSize: '14px' }),
    devicePixelRatio: 2,
    innerWidth: 1280,
    innerHeight: 800,
  };
  sandbox.window = sandbox;
  sandbox.window.getComputedStyle = sandbox.getComputedStyle;
  return { sandbox, listeners, logs, elementsById, cardBtn };
}

(function run() {
  const browser = loadBrowserWithMockElectron();
  assert.strictEqual(typeof browser.INSPECT_INJECT_SCRIPT, 'string');
  assert.strictEqual(typeof browser.INSPECT_CLEANUP_SCRIPT, 'string');
  assert.strictEqual(typeof browser.setInspectMode, 'function');
  assert.strictEqual(typeof browser.captureElementRect, 'function');
  assert.strictEqual(typeof browser.toggleDevTools, 'function');

  // Verify DOM inspect injection, hover label, click navigation block, and Esc cleanup
  const { sandbox, listeners, logs, elementsById, cardBtn } = makeFakeDom();
  const injectRes = vm.runInNewContext(browser.INSPECT_INJECT_SCRIPT, sandbox);
  assert(injectRes && injectRes.injected, 'Inspect overlay must inject');
  assert(elementsById.has('__akron_inspect_root__'), 'Inspect root must exist');
  assert(typeof sandbox.__AKRON_INSPECT_CLEANUP__ === 'function', 'Cleanup hook must exist');

  // Hover updates highlight box and floating label
  for (const fn of listeners.get('mousemove:true') || []) {
    fn({ clientX: 60, clientY: 100, target: cardBtn });
  }
  const tip = elementsById.get('__akron_inspect_tip__');
  assert(tip.textContent.includes('div.card.featured · 420×180'), `Expected dimension pill, got ${tip.textContent}`);

  // Click blocks default navigation and emits structured payload
  let defaultPrevented = false;
  let stopped = false;
  for (const fn of listeners.get('click:true') || []) {
    fn({
      clientX: 60,
      clientY: 100,
      target: cardBtn,
      preventDefault: () => { defaultPrevented = true; },
      stopPropagation: () => { stopped = true; },
      stopImmediatePropagation: () => {},
    });
  }
  assert(defaultPrevented && stopped, 'Click in inspect mode must block navigation');
  const selectMsg = logs.find((l) => l.includes('"type":"select"'));
  assert(selectMsg, 'Inspect click must emit __AKRON_INSPECT__ select message');
  const parsed = JSON.parse(selectMsg.slice('__AKRON_INSPECT__:'.length));
  assert(parsed.selector.includes('div.card.featured'), `Unexpected selector: ${parsed.selector}`);
  assert.strictEqual(parsed.rect.width, 420);
  assert.strictEqual(parsed.rect.height, 180);

  // Escape cleans up everything and logs exit
  for (const fn of listeners.get('keydown:true') || []) {
    fn({
      key: 'Escape',
      preventDefault: () => {},
      stopPropagation: () => {},
      stopImmediatePropagation: () => {},
    });
  }
  assert(!elementsById.has('__akron_inspect_root__'), 'Escape must remove inspect overlay');
  assert(logs.some((l) => l.includes('"type":"exit"')), 'Escape must notify host exit');
  assert.strictEqual(sandbox.__AKRON_INSPECT_CLEANUP__, undefined);

  // Re-inject & explicit cleanup helper
  vm.runInNewContext(browser.INSPECT_INJECT_SCRIPT, sandbox);
  const cleaned = vm.runInNewContext(browser.INSPECT_CLEANUP_SCRIPT, sandbox);
  assert(cleaned && cleaned.ok && cleaned.cleaned, 'Cleanup script must remove overlay');
  assert(!elementsById.has('__akron_inspect_root__'));

  // Verify IPC & UI wiring
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'App.jsx'), 'utf8');
  assert(mainSrc.includes('autobot:browserInspectSet'));
  assert(mainSrc.includes('autobot:browserCaptureElement'));
  assert(mainSrc.includes('autobot:browserToggleDevTools'));
  assert(preloadSrc.includes('browserInspectSet'));
  assert(preloadSrc.includes('browserCaptureElement'));
  assert(preloadSrc.includes('browserToggleDevTools'));
  assert(appSrc.includes('Exit Inspect Mode'));
  assert(appSrc.includes('Send to Agent'));
  assert(appSrc.includes('browser-devtools-btn'));

  console.log('BROWSER_INSPECT_ALL_PASS');
})();
