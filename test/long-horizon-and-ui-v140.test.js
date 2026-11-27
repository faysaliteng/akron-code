'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');

const taskRouter = require('../electron/task-router');
const llm = require('../electron/llm');
const swarmMod = require('../electron/swarm');

describe('v1.4.0 Long-Horizon Engine + Browser Screenshot + Narrow-Pane UI', () => {
  it('routes complex build prompts, Swarm turns, and active coding follow-ups away from fast/haiku', async () => {
    const mockOrch = {
      enabled: true,
      providers: [
        { model: 'claude-haiku-5-5', role: 'fast', tier: 'small', baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'x', enabled: true },
        { model: 'claude-sonnet-4-6', role: 'coder', tier: 'heavy', baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'x', enabled: true },
        { model: 'claude-opus-4-6', role: 'planner', tier: 'critical', baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'x', enabled: true },
      ],
    };

    const rBuild = await taskRouter.classifyAndSelect({
      messages: [{ role: 'user', content: 'make a super beautifull live entertainment platform with admin dashboard' }],
      orchestrator: mockOrch,
      store: false,
    });
    assert.notStrictEqual(rBuild.chosen.model, 'claude-haiku-5-5');
    assert.ok(['coder', 'planner'].includes(rBuild.classification.role));

    const rSwarm = await taskRouter.classifyAndSelect({
      messages: [{ role: 'user', content: 'try again' }],
      orchestrator: mockOrch,
      swarm: true,
      store: false,
    });
    assert.strictEqual(rSwarm.chosen.model, 'claude-opus-4-6');

    const rContinue = await taskRouter.classifyAndSelect({
      messages: [
        { role: 'user', content: 'build server.js and admin panel' },
        { role: 'assistant', content: 'Created server.js and index.html', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Write', arguments: '{"path":"server.js"}' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'Write', content: 'Wrote server.js' },
        { role: 'user', content: 'try again' },
      ],
      orchestrator: mockOrch,
      store: false,
    });
    assert.notStrictEqual(rContinue.chosen.model, 'claude-haiku-5-5');
    assert.strictEqual(rContinue.chosen.model, 'claude-sonnet-4-6');
  });

  it('preserves Files created/modified and Checklist state in sanitizeHistory compaction digest', () => {
    const bigText = 'x'.repeat(2500);
    const msgs = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Build the entire app end-to-end' },
      {
        role: 'assistant',
        content: 'Creating files and checklist',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'TodoWrite', arguments: JSON.stringify({ todos: [{ id: '1', content: 'API routes', status: 'completed' }, { id: '2', content: 'Admin UI', status: 'in_progress' }] }) } },
          { id: 't2', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ path: 'src/server.js', content: bigText }) } },
        ],
      },
      { role: 'tool', tool_call_id: 't1', name: 'TodoWrite', content: 'ok' },
      { role: 'tool', tool_call_id: 't2', name: 'Write', content: 'wrote src/server.js ' + bigText },
      { role: 'user', content: 'Next continue building admin panel' },
      { role: 'assistant', content: 'Working on admin panel ' + bigText },
      { role: 'user', content: 'Verify everything now' },
    ];
    let info = null;
    const out = llm.sanitizeHistory(msgs, { supportsTools: true, maxChars: 2400, onCompact: (d) => { info = d; } });
    assert.ok(info && info.dropped > 0, 'compaction must drop older turns under tight budget');
    assert.ok(info.digest.includes('Files created/modified: src/server.js'), 'digest must list touched files');
    assert.ok(info.digest.includes('Checklist state: [completed] API routes | [in_progress] Admin UI'), 'digest must preserve latest TodoWrite state');
    assert.ok(out.some((m) => m.role === 'user' && String(m.content).includes('[Compacted ')));
  });

  it('runAgent autonomous completion gate continues past incomplete TodoWrite & premature bailout', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-autoloop-'));
    let turn = 0;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        turn++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (turn === 1) {
          res.end(JSON.stringify({
            choices: [{
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'TodoWrite', arguments: JSON.stringify({ todos: [{ id: 'a', content: 'Build module', status: 'in_progress' }] }) } }],
              },
            }],
          }));
        } else if (turn === 2) {
          // Prematurely stops while todo is still in_progress!
          res.end(JSON.stringify({
            choices: [{
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Next step: I can finish the module and run tests. Want me to do that?' },
            }],
          }));
        } else if (turn === 3) {
          res.end(JSON.stringify({
            choices: [{
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'tc2', type: 'function', function: { name: 'TodoWrite', arguments: JSON.stringify({ todos: [{ id: 'a', content: 'Build module', status: 'completed' }] }) } }],
              },
            }],
          }));
        } else {
          res.end(JSON.stringify({
            choices: [{
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'All TodoWrite tasks completed and verified.' },
            }],
          }));
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const events = [];
    try {
      const out = await llm.runAgent({
        provider: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'mock-coder' },
        messages: [{ role: 'user', content: 'Build the module cleanly' }],
        cwd: tmpDir,
        permissionMode: 'auto',
        useMemory: false,
        emit: (e) => events.push(e),
      });
      assert.strictEqual(turn, 4, 'Autonomous loop should have continued past premature bailout on turn 2');
      assert.ok(events.some((e) => e.type === 'notice' && /Autonomous loop/i.test(e.text)));
      const last = out[out.length - 1];
      assert.ok(String(last.content).includes('All TodoWrite tasks completed'));
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Swarm retries failed worker on backup model and enables Write/Edit in REVIEW_TOOLS', async () => {
    assert.ok(swarmMod.REVIEW_TOOLS.has('Write') && swarmMod.REVIEW_TOOLS.has('Edit') && swarmMod.REVIEW_TOOLS.has('Bash'));
    assert.ok(!swarmMod.READONLY_REVIEW_TOOLS.has('Write'));

    const calls = [];
    const res = await swarmMod.swarm('Build multi-file feature', {
      provider: { baseURL: 'http://127.0.0.1:11434/v1', model: 'claude-sonnet-4-6' },
      orchestrator: {
        enabled: true,
        providers: [
          { baseURL: 'http://127.0.0.1:11434/v1', model: 'claude-opus-4-6', tier: 'critical' },
          { baseURL: 'http://127.0.0.1:11434/v1', model: 'claude-sonnet-4-6', tier: 'heavy' },
          { baseURL: 'http://127.0.0.1:11434/v1', model: 'gpt-5.6-terra', tier: 'heavy' },
        ],
      },
      tasks: [{ id: 'w1', title: 'Write server', tier: 'heavy', prompt: 'Create server.js' }],
      monitor: false,
      allowReviewRepair: true,
      runAgent: async ({ provider, messages, toolAllow }) => {
        const prompt = String(messages[0].content || '');
        calls.push({ model: provider.model, hasWrite: toolAllow ? toolAllow.has('Write') : true });
        if (prompt.includes('SUPERVISOR')) {
          return [{ role: 'assistant', content: 'Verified all files cleanly.' }];
        }
        if (calls.filter((c) => !prompt.includes('SUPERVISOR')).length === 1) {
          throw new Error('429 rate limited');
        }
        return [{ role: 'assistant', content: 'Created server.js cleanly on backup model.' }];
      },
    });
    assert.strictEqual(res.results[0].status, 'done');
    assert.ok(res.results[0].result.includes('backup model'));
    assert.ok(calls.some((c) => c.hasWrite === true));
  });

  it('CSS wraps response actions cleanly for narrow panes and BrowserPaneView exposes screenshot button + cropper', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
    const bp = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'browser', 'BrowserPaneView.jsx'), 'utf8');
    assert.ok(/\.response-actions\s*\{[^}]*flex-wrap:\s*wrap/s.test(css));
    assert.ok(/\.response-actions-meta\s*\{[^}]*flex-wrap:\s*wrap/s.test(css));
    assert.ok(bp.includes('data-testid="browser-screenshot-btn"'));
    assert.ok(bp.includes('browser-crop-overlay'));
    assert.ok(bp.includes('data-testid="browser-shot-toast"'));
  });
});
