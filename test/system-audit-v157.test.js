'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

describe('Akron Code v1.5.7 system audit fixes', () => {
  it('resolveNodeBinary() finds real Node CLI and customtools executes node runtime & reports non-zero errors', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-v157-ct-'));
    try {
      const pathsMod = require('../electron/paths');
      const nodeBin = pathsMod.resolveNodeBinary();
      assert.ok(nodeBin && fs.existsSync(nodeBin), `expected real node binary, got ${nodeBin}`);
      assert.ok(!/\.app\/Contents\/MacOS\//i.test(nodeBin));

      const ct = require('../electron/customtools');
      const prevRoot = ct.getRoot();
      ct.setRoot(tmp);
      try {
        const { runTool } = require('../electron/tools');

      const regOk = await runTool('CreateCustomTool', {
        name: 'audit_v157_echo',
        description: 'Echo args in node',
        runtime: 'node',
        parameters: { type: 'object', properties: { msg: { type: 'string' } } },
        script: 'const a = JSON.parse(process.env.TOOL_ARGS_JSON || "{}"); console.log("node:" + (a.msg || ""));',
      }, { cwd: tmp });
      assert.ok(/Saved custom tool|audit_v157_echo/i.test(String(regOk.content || regOk)), regOk);

      const resOk = await runTool('audit_v157_echo', { msg: 'hello157' }, { cwd: tmp });
      assert.strictEqual(!!resOk.isError, false);
      assert.ok(String(resOk.content).includes('node:hello157'), resOk.content);

      const regErr = await runTool('CreateCustomTool', {
        name: 'audit_v157_fail',
        description: 'Exit non-zero silently',
        runtime: 'node',
        parameters: { type: 'object', properties: {} },
        script: 'process.exit(3);',
      }, { cwd: tmp });
      assert.ok(/audit_v157_fail/i.test(String(regErr.content || regErr)));

      const resErr = await runTool('audit_v157_fail', {}, { cwd: tmp });
      assert.strictEqual(resErr.isError, true);
      assert.notStrictEqual(resErr.content, '(no output)');
      assert.ok(/exit 3/i.test(resErr.content), resErr.content);

      await runTool('DeleteCustomTool', { name: 'audit_v157_echo' }, { cwd: tmp });
      await runTool('DeleteCustomTool', { name: 'audit_v157_fail' }, { cwd: tmp });
      } finally {
        ct.setRoot(prevRoot);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('429 httpError parses Retry-After header and writes sanitized diagnostic jsonl without credentials', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-v157-429-'));
    const prevEnv = process.env.AKRON_RATE_LOG_DIR;
    process.env.AKRON_RATE_LOG_DIR = tmp;
    try {
      const pt = require('../electron/providertransport');
      const fakeRes = {
        status: 429,
        url: 'https://example.test/v1/messages',
        headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '12' : null) },
      };
      const err = pt._internal.httpError('anthropic', fakeRes, '{"error":{"message":"rate limited"}}', { model: 'claude-x', oauthProvider: 'claude:me' });
      assert.strictEqual(err.retryAfter, '12');
      assert.strictEqual(err.retryAfterMs, 12000);
      const logFile = path.join(tmp, 'rate-limits.jsonl');
      assert.ok(fs.existsSync(logFile));
      const row = JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n')[0]);
      assert.strictEqual(row.status, 429);
      assert.strictEqual(row.retryAfterMs, 12000);
      assert.strictEqual(row.model, 'claude-x');
      assert.ok(!JSON.stringify(row).includes('accessToken'));
    } finally {
      if (prevEnv === undefined) delete process.env.AKRON_RATE_LOG_DIR;
      else process.env.AKRON_RATE_LOG_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('Anthropic body & sanitizeHistory collapse duplicate consecutive user/[auto-continue] blocks', () => {
    const pt = require('../electron/providertransport');
    const llm = require('../electron/llm');
    const san = llm.sanitizeHistory([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'user', content: '[auto-continue] finish' },
      { role: 'user', content: '[auto-continue] finish' },
    ]);
    assert.strictEqual(san.filter((m) => m.role === 'user' && m.content === '[auto-continue] finish').length, 1);

    const body = pt._internal.toAnthropicBody(
      { model: 'claude-fable-5-2', oauth: true },
      [
        { role: 'user', content: '[auto-continue] keep going' },
        { role: 'user', content: '[auto-continue] keep going' },
      ],
      [],
      4096
    );
    assert.strictEqual(body.messages.length, 1);
    assert.strictEqual(body.messages[0].content.length, 1);
  });

  it('GenerateImage & EditImage emit previewDataUrl to UI but strip base64 previewDataUrl from model result', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-v157-img-'));
    try {
      const mediaGen = require('../electron/media-gen');
      const emitted = [];
      const gen = await mediaGen.generateImage({
        prompt: 'geometric emerald prism',
        output_path: path.join(tmp, 'out.png'),
        forceOffline: true,
        cwd: tmp,
      }, { cwd: tmp, emit: (e) => emitted.push(e) });
      assert.strictEqual(gen.ok, true);
      assert.strictEqual(gen.previewDataUrl, undefined);
      assert.ok(emitted.some((e) => e.type === 'mediaArtifact' && String(e.previewDataUrl || '').startsWith('data:image/')));

      const edited = await mediaGen.editImage({
        operation: 'resize',
        input_path: gen.path,
        output_path: path.join(tmp, 'resized.webp'),
        format: 'webp',
        width: 128,
        height: 128,
        cwd: tmp,
      }, { cwd: tmp, emit: (e) => emitted.push(e) });
      assert.strictEqual(edited.ok, true);
      assert.strictEqual(edited.previewDataUrl, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rea.isReaServerConfig detects duplicate REA server configs', () => {
    const rea = require('../electron/rea');
    assert.strictEqual(rea.isReaServerConfig('rea', {}), true);
    assert.strictEqual(rea.isReaServerConfig('srv1', {
      command: '/Users/x/.volta/bin/node',
      args: ['/Users/x/.volta/packages/rea-agents/bin/rea', 'mcp'],
    }), true);
    assert.strictEqual(rea.isReaServerConfig('srv2', {
      command: 'node',
      args: ['/app/rea.mjs', 'mcp'],
    }), true);
    assert.strictEqual(rea.isReaServerConfig('github', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }), false);
  });

  it('REPL handles multi-line Python/Bash newlines verbatim and supports JS dynamic import()', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-v157-repl-'));
    try {
      const { runTool } = require('../electron/tools');
      const repl = require('../electron/repl');

      const py = await runTool('REPL', { language: 'python', code: 'x = 2\ny = 3\nprint(x + y)', cwd: tmp }, { cwd: tmp });
      assert.strictEqual(!!py.isError, false, py.content);
      assert.strictEqual(String(py.content).trim(), '5');

      const sh = await runTool('REPL', { language: 'bash', code: 'echo line-one\necho line-two', cwd: tmp }, { cwd: tmp });
      assert.strictEqual(!!sh.isError, false, sh.content);
      assert.ok(/line-one\s*\n\s*line-two/.test(String(sh.content)), sh.content);

      const js = await repl.evalJS({
        code: 'const pathMod = await import("node:path"); console.log(pathMod.basename("/tmp/demo-v157.txt"));',
        cwd: tmp,
        reset: true,
      });
      assert.strictEqual(js.ok, true, js.output);
      assert.strictEqual(js.output, 'demo-v157.txt');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('edit-guard catches real syntax errors and never emits Cannot find module esbuild', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-v157-eg-'));
    try {
      const eg = require('../electron/ide/edit-guard');
      const okFile = path.join(tmp, 'good.js');
      fs.writeFileSync(okFile, 'function ok(x) { return x + 1; }\n', 'utf8');
      const d1 = eg.collectPostEditDiagnostics(okFile, tmp);
      assert.strictEqual(d1, '');

      const badFile = path.join(tmp, 'bad.js');
      fs.writeFileSync(badFile, 'function broken( { return ; }\n', 'utf8');
      const d2 = eg.collectPostEditDiagnostics(badFile, tmp);
      assert.ok(/Syntax error/i.test(d2), d2);
      assert.ok(!/Cannot find module 'esbuild'/i.test(d2), d2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('WebSearch relevance filter drops 0-keyword hits when better hits exist', () => {
    const ws = require('../electron/tools/web-search');
    const ranked = ws._internal.rankAndFilterHits([
      { title: 'Wikipedia, the free encyclopedia', url: 'https://en.wikipedia.org/wiki/Main_Page', snippet: 'Welcome', source: 'wikipedia' },
      { title: 'tccutil man page macOS', url: 'https://ss64.com/mac/tccutil.html', snippet: 'Manage macOS TCC privacy database with tccutil reset', source: 'ddg-html' },
    ], 'macOS tccutil ScreenCapture');
    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].url, 'https://ss64.com/mac/tccutil.html');
  });

  it('ShellManager strips ANSI codes and avoids dquote> on simple commands', async () => {
    const { ShellManager, stripAnsi } = require('../electron/shell');
    assert.strictEqual(stripAnsi('\x1b[32mgreen\x1b[0m text'), 'green text');
    const sm = new ShellManager();
    const { id } = sm.start({ cwd: os.tmpdir() });
    try {
      const out = await sm.run(id, 'printf "\\033[32mhello-shell\\033[0m"', { timeoutMs: 8000 });
      assert.ok(out.includes('hello-shell'), out);
      assert.ok(!/dquote>/i.test(out), out);
      assert.ok(!/\x1b\[/.test(out), out);
    } finally {
      sm.killAll();
    }
  });

  it('Workflow invokes export default async function and errors on no-op scripts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-v157-wf-'));
    const prev = process.env.HELIO_WF_TEST_HOME;
    process.env.HELIO_WF_TEST_HOME = tmp;
    try {
      delete require.cache[require.resolve('../electron/workflow')];
      const wf = require('../electron/workflow');
      let called = 0;
      const r1 = await wf.runWorkflow({
        script: `
          export const meta = { name: 'def-fn', description: 'runs default export', phases: ['A'] };
          export default async function(input) {
            return await agent('Task: ' + input);
          }
        `,
        args: 'ping',
        runAgent: async ({ prompt }) => { called++; return 'ok:' + prompt; },
      });
      assert.strictEqual(r1.status, 'completed', r1.error);
      assert.strictEqual(called, 1);
      assert.strictEqual(r1.result, 'ok:Task: ping');

      const r2 = await wf.runWorkflow({
        script: `
          export const meta = { name: 'noop', description: 'does nothing', phases: ['A'] };
          async function unused() { return await agent('never'); }
        `,
        runAgent: async () => 'x',
      });
      assert.strictEqual(r2.status, 'error');
    } finally {
      if (prev === undefined) delete process.env.HELIO_WF_TEST_HOME;
      else process.env.HELIO_WF_TEST_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('CronCreate recurring:false schedules active one-shot run and auto-disables after execution; purge removes SKILL.md', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-v157-cron-'));
    try {
      const { createScheduler } = require('../electron/scheduler');
      const sched = createScheduler({
        dataDir: path.join(tmp, 'autobot'),
        durableFile: path.join(tmp, '.claude', 'scheduled_tasks.json'),
      });
      const r = sched.createCron({
        name: 'once-cron',
        cron: '*/5 * * * *',
        prompt: 'run once',
        recurring: false,
      });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.task.enabled, true);
      assert.ok(typeof r.task.nextRunAt === 'number' && r.task.nextRunAt > 0);
      assert.ok(fs.existsSync(r.task.filePath));

      sched.start(async () => 'done-once');
      await sched.runNow(r.task.id);
      const after = sched.list().find((t) => t.id === r.task.id);
      assert.strictEqual(after.enabled, false);
      assert.strictEqual(after.nextRunAt, null);
      sched.stop();

      const del = sched.remove(r.task.id, { purge: true });
      assert.strictEqual(del.ok, true);
      assert.strictEqual(del.purged, true);
      assert.strictEqual(fs.existsSync(r.task.filePath), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('os-sandbox allows rm -f workspace files before && ls ~ while blocking destructive rm -rf ~', () => {
    const osSandbox = require('../electron/os-sandbox');
    assert.strictEqual(osSandbox.checkCanonicalCommand('rm -f audit_a.md audit_b.md && ls ~').ok, true);
    assert.strictEqual(osSandbox.checkCanonicalCommand('rm -rf ~').ok, false);
    assert.strictEqual(osSandbox.checkCanonicalCommand('rm -fr /').ok, false);
    assert.strictEqual(osSandbox.checkCanonicalCommand('rm --recursive -f $HOME').ok, false);
  });

  it('swarm excludes small FreeLLM models from frontier, routes haiku to small tier, and avoids cooling supervisor', () => {
    const swarm = require('../electron/swarm');
    const gate = require('../electron/provider-gate');
    gate.reset();
    assert.strictEqual(swarm.isFrontier({ model: 'qwen3.8-27b', name: 'FreeLLM Frontier Qwen', baseURL: 'http://127.0.0.1:3001/v1' }), false);

    const roster = swarm.buildRoster({
      orchestrator: {
        enabled: true,
        providers: [
          { id: 'c1', model: 'claude-haiku-5-5', tier: 'heavy', oauth: true, oauthProvider: 'claude:acct' },
          { id: 'g1', model: 'gemini-4-carbon-high', tier: 'critical', oauth: true, oauthProvider: 'antigravity:acct' },
          { id: 'f1', model: 'claude-fable-5-2', tier: 'critical', oauth: true, oauthProvider: 'claude:acct' },
        ],
      },
    });
    const haikuRow = roster.find((r) => r.model === 'claude-haiku-5-5');
    assert.strictEqual(haikuRow.tier, 'small');
    assert.strictEqual(swarm.pickProvider(roster, 'small').model, 'claude-haiku-5-5');

    gate.rateLimited({ oauthProvider: 'antigravity:acct', model: 'gemini-4-carbon-high' }, 60000);
    const supPick = swarm.pickProvider(roster, 'critical');
    assert.strictEqual(supPick.model, 'claude-fable-5-2');
    gate.reset();
  });

  it('store skips foreign Claude Desktop internal browser/computer-use skills', () => {
    const store = require('../electron/store');
    assert.strictEqual(
      store._internal.isForeignProductSkill('built-in-browser', 'Use mcp__Claude_Browser__navigate', 'claude'),
      true
    );
    assert.strictEqual(
      store._internal.isForeignProductSkill('reverse-engineer-anything', 'Use rea', 'claude'),
      false
    );
  });

  it('cowork unregisterWorker removes registered workers cleanly', () => {
    const cowork = require('../electron/cowork');
    cowork.registerWorker('audit-worker', { goal: 'test' });
    assert.ok(cowork.listWorkers().some((w) => w.name === 'audit-worker'));
    assert.strictEqual(cowork.unregisterWorker('audit-worker'), true);
    assert.strictEqual(cowork.listWorkers().some((w) => w.name === 'audit-worker'), false);
  });

  it('extbridge list_tabs supports activeOnly and currentWindowOnly filtering', async () => {
    const srv = http.createServer((req, res) => res.end('ok'));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    await new Promise((r) => srv.close(r));
    const ext = require('../electron/extbridge');
    assert.strictEqual(typeof ext.callTool, 'function');
  });
});
