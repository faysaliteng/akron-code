'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const cronexpr = require('../electron/cronexpr');
const { createScheduler } = require('../electron/scheduler');
const commands = require('../electron/commands');
const sessionDb = require('../electron/session-db');
const createRuntimesController = require('../electron/ipc/ipc-runtimes');
const brandGuard = require('../electron/brand-guard');

test('cronexpr supports CRON_TZ=<IANA> and detectLocalTimezone()', () => {
  const tz = cronexpr.detectLocalTimezone();
  assert.ok(tz.timeZone && tz.offsetLabel && tz.display);
  const v = cronexpr.validate('CRON_TZ=America/New_York 18 7 * * 1-5');
  assert.strictEqual(v.ok, true);
  const from = Date.UTC(2026, 5, 1, 10, 0, 0); // 06:00 EDT in NY
  const nxt = cronexpr.next('CRON_TZ=America/New_York 18 7 * * 1-5', from);
  assert.ok(nxt && nxt > from);
  // 07:18 EDT = 11:18 UTC
  const d = new Date(nxt);
  assert.strictEqual(d.getUTCHours(), 11);
  assert.strictEqual(d.getUTCMinutes(), 18);
});

test('multi-trigger scheduler fires watch trigger on real workspace file change and cleans up cleanly', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-watch-sched-'));
  const watchDir = path.join(tmp, 'repo');
  fs.mkdirSync(watchDir, { recursive: true });
  const sched = createScheduler({
    dataDir: path.join(tmp, 'autobot'),
    durableFile: path.join(tmp, '.claude', 'scheduled_tasks.json'),
  });
  let firedCtx = null;
  try {
    const res = sched.create({
      name: 'Multi Trigger Watcher',
      description: 'Runs on file save + weekdays',
      prompt: 'Check changed file and report issues.',
      cwd: watchDir,
      triggers: [
        { type: 'schedule', cadence: 'weekdays', time: '07:52', timeZone: 'UTC' },
        { type: 'watch', watchGlob: '.js', watchGit: true, debounceMs: 150 },
      ],
      allowedMcpServers: ['rea'],
      notifyMode: 'failure',
      maxSteps: 12,
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.task.triggers.length, 2);
    assert.ok(res.task.nextRunAt > Date.now());

    sched.start(async ({ task, trigger, watchFile }) => {
      firedCtx = { id: task.id, trigger, watchFile };
      return { output: 'Watch OK', convId: 'conv_watch_1', model: 'deepseek-chat', toolsCount: 2 };
    });

    // Give macOS FSEvents watcher a moment to arm, then modify a matching file
    await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(path.join(watchDir, 'app.js'), 'console.log(1);\n');
    const deadline = Date.now() + 6000;
    while (!firedCtx && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(firedCtx, 'file watch trigger should fire on matching .js write');
    assert.strictEqual(firedCtx.trigger, 'watch');
    assert.strictEqual(firedCtx.watchFile, 'app.js');

    const runs = sched.listRuns(res.task.id);
    assert.strictEqual(runs.ok, true);
    assert.strictEqual(runs.runs[0].convId, 'conv_watch_1');
    assert.strictEqual(runs.runs[0].trigger, 'watch');
    assert.strictEqual(runs.runs[0].toolsCount, 2);
  } finally {
    sched.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runScheduledPrompt wires filtered MCP tools, persists convId to SQLite sessionDb, and notifies', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-run-sched-e2e-'));
  const dbPath = path.join(tmp, 'akron.db');
  const workDir = path.join(tmp, 'workspace');
  fs.mkdirSync(workDir, { recursive: true });
  await sessionDb.initSessionDb({ dbPath });

  const notified = [];
  const broadcasts = [];
  const mcpCalls = [];
  const fakeMcp = {
    servers: new Map([
      ['alpha', { name: 'Alpha', fullTools: [{ name: 'ping', description: 'Ping alpha', inputSchema: { type: 'object', properties: {} } }] }],
      ['beta', { name: 'Beta', fullTools: [{ name: 'secret', description: 'Should be filtered out', inputSchema: { type: 'object', properties: {} } }] }],
    ]),
    callTool: async (srv, tool, args) => { mcpCalls.push({ srv, tool, args }); return 'pong'; },
  };
  let seenExtraTools = [];
  const ctrl = createRuntimesController({
    app: { getPath: () => tmp },
    ipcMain: { handle: () => {} },
    store: {
      getSettings: () => ({ provider: { baseURL: 'http://127.0.0.1:9999/v1', apiKey: 'test', model: 'mock-model' } }),
      getOrchestrator: () => ({ enabled: false, providers: [] }),
    },
    workspace: { scratch: () => workDir },
    shells: {},
    freellm: {},
    createRuntimes: () => ({}),
    providertransport: {},
    runAgent: async (opts) => {
      seenExtraTools = (opts.extraTools || []).map((t) => t.name);
      if (opts.emit) {
        opts.emit({ type: 'tool_start', id: 'tc1', name: 'mcp__alpha__ping', args: {} });
        const toolOut = await opts.callMcpTool('mcp__alpha__ping', {});
        opts.emit({ type: 'tool_end', id: 'tc1', name: 'mcp__alpha__ping', result: toolOut });
        opts.emit({ type: 'delta', text: 'Automation summary ready: pong' });
      }
      return [{ role: 'user', content: opts.messages[0].content }, { role: 'assistant', content: 'Automation summary ready: pong', model: 'mock-model' }];
    },
    hydrateProvider: async (p) => p,
    hydrateOrchestrator: async (o) => ({ orch: o, dead: [] }),
    validateOrchestrator: async (o) => o,
    freellmFallbackApiKey: () => '',
    oneLine: (e) => String((e && e.message) || e),
    broadcast: (evt) => broadcasts.push(evt),
    mcp: fakeMcp,
    autoConnectMcp: async () => {},
    sessionDb: {
      upsertConversation: (conv) => sessionDb.upsertConversation(conv, { dbPath }),
    },
    notificationService: { notify: (n) => notified.push(n) },
    proactivity: { loadState: () => ({ quietHours: { enabled: false } }), isInQuietHours: () => false },
    gdrive: { status: () => ({ connected: false }) },
  });

  try {
    const out = await ctrl.runScheduledPrompt({
      task: {
        id: 'daily-alpha',
        name: 'Daily Alpha Check',
        prompt: 'Ping alpha server',
        cwd: workDir,
        allowedMcpServers: ['alpha'],
        notifyMode: 'all',
      },
      trigger: 'manual',
    });
    assert.strictEqual(out.output, 'Automation summary ready: pong');
    assert.ok(out.convId && out.convId.startsWith('sched_daily-alpha_'));
    assert.deepStrictEqual(seenExtraTools, ['mcp__alpha__ping'], 'only allowlisted alpha MCP tool should be exposed');
    assert.strictEqual(mcpCalls.length, 1);

    const saved = await sessionDb.getConversation(out.convId, { dbPath });
    assert.ok(saved, 'scheduled run must persist real session in SQLite');
    assert.strictEqual(saved.automationId, 'daily-alpha');
    assert.strictEqual(saved.messages.length, 2);
    assert.ok(saved.messages[1].tools && saved.messages[1].tools.length === 1);

    assert.strictEqual(notified.length, 1);
    assert.match(notified[0].title, /Automation completed: Daily Alpha Check/);
    assert.ok(broadcasts.some((b) => b.type === 'scheduled-session' && b.convId === out.convId));
  } finally {
    sessionDb.closeSessionDb(dbPath);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('automation skill & slash registry cleanup have zero dead Anthropic entries', () => {
  const skillMd = path.join(ROOT, 'resources', 'skills', 'automation', 'SKILL.md');
  assert.ok(fs.existsSync(skillMd), 'resources/skills/automation/SKILL.md must exist');
  const txt = fs.readFileSync(skillMd, 'utf8');
  assert.ok(/AskUserQuestion/.test(txt) && /scheduled-tasks__create_scheduled_task/.test(txt));

  const uiNames = new Set(commands.listForUi(ROOT).map((c) => c.name));
  assert.ok(uiNames.has('automation'));
  for (const dead of ['install-slack-app', 'web-setup', 'stickers', 'radio', 'pro-trial-expired', 'teleport', 'heapdump']) {
    assert.ok(!uiNames.has(dead), `dead Anthropic UI entry ${dead} should be removed from BUILTIN`);
  }
});

test('AutomationsView, InputBarView, bundle & codebase hygiene satisfy production limits', () => {
  const appLines = fs.readFileSync(path.join(ROOT, 'src', 'App.jsx'), 'utf8').split('\n').length;
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const mainLines = mainSrc.split('\n').length;
  assert.ok(appLines < 3500, `src/App.jsx (${appLines}) must stay under 3500 lines`);
  assert.ok(mainLines < 1600, `electron/main.js (${mainLines}) must stay under 1600 lines`);
  assert.ok(
    mainSrc.includes('process.stdout') && mainSrc.includes('process.stderr') && mainSrc.includes('EPIPE'),
    'electron/main.js must guard stdout/stderr against broken-pipe EPIPE crashes on Windows GUI launch'
  );

  const autoView = fs.readFileSync(path.join(ROOT, 'src', 'components', 'AutomationsView.jsx'), 'utf8');
  assert.ok(/Create with Prompt/.test(autoView) && /scheduled-task-modal/.test(autoView) && /open-run-session-btn/.test(autoView));

  const inputBar = fs.readFileSync(path.join(ROOT, 'src', 'components', 'chat', 'InputBarView.jsx'), 'utf8');
  assert.ok(/composer-skill-pill/.test(inputBar));

  // Verify zero hardcoded /Users/<current-user> paths across committed code & unit tests
  const roots = ['src', 'electron', 'scripts', 'resources'];
  const hits = [];
  const walk = (d, extRe = /\.(js|jsx|mjs|cjs|ts|tsx|css|md|sh|json)$/) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p, extRe);
      else if (extRe.test(ent.name)) {
        const body = fs.readFileSync(p, 'utf8');
        if (body.includes('/Users/' + 'saimon')) hits.push(path.relative(ROOT, p));
      }
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));
  for (const f of fs.readdirSync(path.join(ROOT, 'test'))) {
    if (f.endsWith('.test.js')) {
      const p = path.join(ROOT, 'test', f);
      if (fs.readFileSync(p, 'utf8').includes('/Users/' + 'saimon')) hits.push(path.relative(ROOT, p));
    }
  }
  assert.deepStrictEqual(hits, [], `Hardcoded user paths found in: ${hits.join(', ')}`);

  const seal = brandGuard.verifyBrandIntegrity();
  assert.strictEqual(seal.ok, true);
  assert.strictEqual(seal.checkedFiles, 12);
});
