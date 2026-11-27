'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-cust-home-'));
const tmpAuto = path.join(tmpHome, '.autobot');
const tmpClaude = path.join(tmpHome, '.claude');
const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-cust-cwd-'));

process.env.AUTOBOT_HOME = tmpAuto;
process.env.CLAUDE_CONFIG_DIR = tmpClaude;

const agentdefs = require('../electron/agentdefs');
const outputStyles = require('../electron/output-styles');
const catalogMod = require('../electron/connector-catalog');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name + '\n    ' + (e && e.stack ? e.stack : e));
  }
}

(async () => {
  console.log('\nCustomizations Hub, Custom Agents & Custom Outputs:');

  try {
    await test('agentdefs saveAgentDef / discover / deleteAgentDef round-trip (global & workspace)', () => {
      const saved = agentdefs.saveAgentDef({
        name: 'security-auditor',
        role: 'Security Auditor',
        description: 'Audits diffs for vulnerabilities and leaked secrets.',
        scope: 'autobot',
        model: 'planner',
        tools: ['Read', 'Grep', 'Glob', 'Bash'],
        body: 'You are security-auditor. Inspect every diff carefully.',
      }, tmpCwd);
      assert.strictEqual(saved.ok, true);
      assert(fs.existsSync(saved.file) && saved.file.startsWith(path.join(tmpAuto, 'agents')));

      const list = agentdefs.discover(tmpCwd, { fresh: true });
      const hit = list.find((a) => a.name === 'security-auditor');
      assert(hit, 'Saved custom agent must be discovered');
      assert.strictEqual(hit.role, 'Security Auditor');
      assert.strictEqual(hit.model, 'planner');
      assert.deepStrictEqual(hit.tools, ['Read', 'Grep', 'Glob', 'Bash']);
      assert.strictEqual(hit.custom, true);

      // Built-in delete must be refused
      const delBuiltin = agentdefs.deleteAgentDef({ name: 'Explore' }, tmpCwd);
      assert.strictEqual(delBuiltin.ok, false);

      // Custom delete succeeds cleanly
      const delCustom = agentdefs.deleteAgentDef({ name: 'security-auditor', file: saved.file }, tmpCwd);
      assert.strictEqual(delCustom.ok, true);
      assert(!agentdefs.discover(tmpCwd, { fresh: true }).some((a) => a.name === 'security-auditor'));
    });

    await test('output-styles listOutputStyles / saveOutputStyle / deleteOutputStyle round-trip', () => {
      const initial = outputStyles.listOutputStyles(tmpCwd);
      assert.strictEqual(initial.ok, true);
      assert(initial.styles.length >= 6, 'Expected 6 built-in output styles');

      const saved = outputStyles.saveOutputStyle({
        name: 'Executive Brief',
        hint: 'TL;DR first + impact bullets',
        scope: 'autobot',
        directive: 'Always start with a 2-sentence executive TL;DR and quantified impact.',
        setDefault: true,
      }, tmpCwd);
      assert.strictEqual(saved.ok, true);
      assert.strictEqual(saved.defaultStyleId, 'executive-brief');
      assert(fs.existsSync(saved.file));

      const afterSave = outputStyles.listOutputStyles(tmpCwd);
      assert.strictEqual(afterSave.defaultStyleId, 'executive-brief');
      const customStyle = afterSave.styles.find((s) => s.id === 'executive-brief');
      assert(customStyle && customStyle.custom === true);
      assert(customStyle.directive.includes('2-sentence executive TL;DR'));

      const del = outputStyles.deleteOutputStyle({ id: 'executive-brief', file: saved.file }, tmpCwd);
      assert.strictEqual(del.ok, true);
      assert.strictEqual(del.defaultStyleId, 'default');
      assert(!outputStyles.listOutputStyles(tmpCwd).styles.some((s) => s.id === 'executive-brief'));
    });

    await test('All Marketplace shelf IDs resolve cleanly in connector-catalog.js', () => {
      const requiredIds = [
        'gdocs', 'gsheets', 'gslides', 'gdrive', 'gcal', 'gmail',
        'github', 'firebase', 'cloudflare', 'netlify', 'docker', 'supabase', 'linear', 'jira',
        'figma', 'canva', 'replicate', 'huggingface', 'notion', 'slack',
        'rea', 'sentry', 'datadog', 'postgres',
      ];
      for (const id of requiredIds) {
        assert(catalogMod.BY_ID.has(id), `Missing marketplace catalog entry: ${id}`);
      }
    });

    await test('CustomizationsHub.jsx, App.jsx, InputBarView.jsx, preload.js & ipc-features.js are wired end-to-end', () => {
      const hubSrc = fs.readFileSync(path.join(ROOT, 'src', 'components', 'customizations', 'CustomizationsHub.jsx'), 'utf8');
      const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'App.jsx'), 'utf8');
      const inputSrc = fs.readFileSync(path.join(ROOT, 'src', 'components', 'chat', 'InputBarView.jsx'), 'utf8');
      const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
      const ipcSrc = fs.readFileSync(path.join(ROOT, 'electron', 'ipc', 'ipc-features.js'), 'utf8');
      const helperSrc = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'appHelpers.jsx'), 'utf8');

      // Marketplace + Installed 4 sections
      assert(hubSrc.includes('Marketplace') && hubSrc.includes('Installed') && hubSrc.includes('Search customizations...'));
      assert(hubSrc.includes('Slash Skills') && hubSrc.includes('Custom Agents') && hubSrc.includes('Custom Outputs') && hubSrc.includes('MCP Servers'));
      assert(hubSrc.includes('installPlugin') && hubSrc.includes('saveAgentDef') && hubSrc.includes('saveOutputStyle'));

      // App.jsx top sidebar navigation + full-page panel mount
      assert(appSrc.includes("panel === 'customizations'"));
      assert(appSrc.includes("<CustomizationsHub"));
      assert(appSrc.includes("setPanel('customizations')"));

      // Composer @ mention + Output style picker merge + buildDirectives
      assert(inputSrc.includes('customAgents') && inputSrc.includes('customStyles') && inputSrc.includes('Manage Custom Outputs'));
      assert(helperSrc.includes('opts.customStyles'));

      // Preload + IPC channels
      for (const fn of ['providerAutoHeal', 'listAgentDefs', 'saveAgentDef', 'deleteAgentDef', 'listOutputStyles', 'saveOutputStyle', 'deleteOutputStyle']) {
        assert(preloadSrc.includes(`${fn}:`), `preload.js missing ${fn}`);
      }
      for (const ch of ['autobot:listAgentDefs', 'autobot:saveAgentDef', 'autobot:deleteAgentDef', 'autobot:listOutputStyles', 'autobot:saveOutputStyle', 'autobot:deleteOutputStyle']) {
        assert(ipcSrc.includes(ch), `ipc-features.js missing ${ch}`);
      }
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }

  console.log(`\nCUSTOMIZATIONS_HUB_RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
