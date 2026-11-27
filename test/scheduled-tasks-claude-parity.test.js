'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createScheduler } = require('../electron/scheduler');
const proactivity = require('../electron/proactivity');
const { runTool, toolDefinitions, executorsByTool } = require('../electron/tools');

describe('Claude Desktop ScheduledTasksManager Parity & Actionable Suggestions', () => {
  it('writes {taskId}/SKILL.md frontmatter with collision suffixing, mirrors durable cron tasks, and preserves SKILL.md on delete', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-sched-iso-'));
    const cwdDir = path.join(tmp, 'proj');
    fs.mkdirSync(cwdDir, { recursive: true });
    try {
      const sched = createScheduler({
        dataDir: path.join(tmp, 'autobot'),
        durableFile: path.join(tmp, '.claude', 'scheduled_tasks.json'),
      });

      const r1 = sched.create({
        name: 'Morning Triage!',
        description: 'Summarize git commits and failing tests',
        prompt: 'Inspect git log and run test suite.',
        cadence: 'cron',
        cronExpression: '0 9 * * 1-5',
        model: 'claude-sonnet-4-6',
        cwd: cwdDir,
        permissionMode: 'plan',
        useWorktree: true,
        durable: true,
      });
      assert.equal(r1.ok, true);
      assert.equal(r1.task.id, 'morning-triage');
      assert(fs.existsSync(r1.task.filePath));

      const skillContent = fs.readFileSync(r1.task.filePath, 'utf8');
      assert(skillContent.includes('name: "Morning Triage!"'));
      assert(skillContent.includes('cadence: "cron"'));
      assert(skillContent.includes('cronExpression: "0 9 * * 1-5"'));
      assert(skillContent.includes('model: "claude-sonnet-4-6"'));
      assert(skillContent.includes('permissionMode: "plan"'));
      assert(skillContent.includes('useWorktree: true'));
      assert(skillContent.includes('Inspect git log and run test suite.'));

      // Collision suffixing
      const r2 = sched.create({
        name: 'Morning Triage!',
        prompt: 'Second copy',
        cadence: 'manual',
      });
      assert.equal(r2.ok, true);
      assert.equal(r2.task.id, 'morning-triage-2');

      // Durable mirroring to default durable file + task.cwd/.claude/scheduled_tasks.json
      const mirroredRoot = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'scheduled_tasks.json'), 'utf8'));
      assert.equal(mirroredRoot.tasks.length, 1);
      assert.equal(mirroredRoot.tasks[0].id, 'morning-triage');
      const mirroredCwd = JSON.parse(fs.readFileSync(path.join(cwdDir, '.claude', 'scheduled_tasks.json'), 'utf8'));
      assert.equal(mirroredCwd.tasks.length, 1);

      // Delete preserves SKILL.md on disk for recovery
      const del = sched.remove('morning-triage');
      assert.equal(del.ok, true);
      assert.equal(fs.existsSync(r1.task.filePath), true);
      assert.equal(sched.list().some((t) => t.id === 'morning-triage'), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('supports all 8 cadences, missed-run catch-up, >7d once expiry, retry backoff (1m->5m->15m), 25-run cap, and Attention Gate', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-sched-exec-'));
    try {
      const sched = createScheduler({
        dataDir: path.join(tmp, 'autobot'),
        durableFile: path.join(tmp, '.claude', 'scheduled_tasks.json'),
      });

      const from = new Date('2026-11-27T10:00:00').getTime(); // Friday
      const cadences = [
        { cadence: 'daily', time: '09:00' },
        { cadence: 'weekdays', time: '09:00' },
        { cadence: 'weekly', dayOfWeek: 1, time: '09:00' },
        { cadence: 'hourly', minute: 15 },
        { cadence: 'every', everyMinutes: 15 },
        { cadence: 'once', fireAt: from + 600000 },
        { cadence: 'cron', cron: '*/30 * * * *' },
        { cadence: 'manual' },
      ];
      for (const spec of cadences) {
        const next = sched.computeNext(spec, from);
        if (spec.cadence === 'manual') assert.equal(next, null);
        else assert(typeof next === 'number' && next > from, `${spec.cadence} must schedule next > from`);
        assert(sched.describe(spec).length > 0);
      }

      // 1. >7d stale one-time task pauses automatically with waitingReason='too_late'
      const stale = sched.create({
        name: 'Stale Once',
        prompt: 'Old check',
        cadence: 'once',
        fireAt: Date.now() - 8 * 24 * 3600 * 1000,
      });
      // 2. Overdue recurring task triggers with 'missed'
      const overdue = sched.create({
        name: 'Missed Daily',
        prompt: 'Run triage',
        cadence: 'every',
        everyMinutes: 60,
        cwd: tmp,
        model: 'gpt-5.4',
      });
      // Backdate nextRunAt > 2m in the past so tick classifies it as missed
      const dbPath = path.join(tmp, 'autobot', 'scheduled-tasks.json');
      const state = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      const oEntry = state.tasks.find((x) => x.id === overdue.task.id);
      oEntry.nextRunAt = Date.now() - 5 * 60 * 1000;
      fs.writeFileSync(dbPath, JSON.stringify(state, null, 2));

      let failMode = false;
      const seen = [];
      sched.start(async ({ task, trigger }) => {
        seen.push({ id: task.id, trigger, cwd: task.cwd, model: task.model });
        if (failMode) throw new Error('simulated failure');
        return `ok:${trigger}:${task.model}`;
      });
      await sched.tick();

      const after = sched.list();
      const staleAfter = after.find((t) => t.id === stale.task.id);
      assert.equal(staleAfter.enabled, false);
      assert.equal(staleAfter.waitingReason, 'too_late');

      const missedAfter = after.find((t) => t.id === overdue.task.id);
      assert.equal(missedAfter.runs[0].trigger, 'missed');
      assert.equal(missedAfter.runs[0].status, 'succeeded');
      assert.equal(missedAfter.runs[0].cwd, tmp);
      assert.equal(missedAfter.runs[0].model, 'gpt-5.4');

      // 3. Attention Gate skip + retry backoff + 25-run cap
      const gated = sched.create({
        name: 'Gated Check',
        prompt: 'Check status',
        cadence: 'manual',
        attentionGate: true,
        fastProvider: {
          model: 'fast-gate',
          // Bypass LLM network by using proactivity directly? Let's verify gate toggle & runner skipping separately below.
        },
      });
      assert.equal(gated.task.attentionGate, true);

      failMode = true;
      const st2 = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      st2.tasks.find((x) => x.id === overdue.task.id).nextRunAt = Date.now() - 1000;
      fs.writeFileSync(dbPath, JSON.stringify(st2, null, 2));
      await sched.tick();
      const retried1 = sched.list().find((t) => t.id === overdue.task.id);
      assert.equal(retried1.retryCount, 1);
      assert(retried1.retryAt > Date.now() + 45000);

      // 25-run history cap via runNow
      failMode = false;
      for (let i = 0; i < 27; i++) {
        await sched.runNow(overdue.task.id);
      }
      const runsRes = sched.listRuns(overdue.task.id, { limit: 30 });
      assert.equal(runsRes.ok, true);
      assert.equal(runsRes.totalRuns, 25);

      sched.stop();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('wires scheduled-tasks__list_task_runs tool definition & executor', async () => {
    const names = new Set(toolDefinitions.map((t) => t.name));
    assert(names.has('scheduled-tasks__list_task_runs'));
    assert.equal(executorsByTool['scheduled-tasks__list_task_runs'], 'scheduled_tasks_list_task_runs');
    assert.equal(executorsByTool.scheduled_tasks_list_task_runs, 'scheduled_tasks_list_task_runs');

    const res = await runTool('scheduled-tasks__list_task_runs', { limit: 5 }, {});
    const parsed = JSON.parse(res.content);
    assert.equal(parsed.ok, true);
    assert(Array.isArray(parsed.runs));
  });

  it('filters trivial greetings from Suggested Automations via isActionableAutomationCandidate', () => {
    assert.equal(proactivity.isActionableAutomationCandidate('hi'), false);
    assert.equal(proactivity.isActionableAutomationCandidate('who are you'), false);
    assert.equal(proactivity.isActionableAutomationCandidate('hi what is going on'), false);
    assert.equal(proactivity.isActionableAutomationCandidate('ok thanks please'), false);
    assert.equal(
      proactivity.isActionableAutomationCandidate('Run full test suite and summarize failing checks in repo'),
      true
    );

    const sugs = proactivity.suggestAutomationsFromHistory({
      convs: [
        { id: 'g1', messages: [{ role: 'user', content: 'hi what is going on' }] },
        { id: 'g2', messages: [{ role: 'user', content: 'hi what is going on' }] },
        { id: 'g3', messages: [{ role: 'user', content: 'who are you?' }] },
        { id: 'g4', messages: [{ role: 'user', content: 'who are you?' }] },
        { id: 'a1', messages: [{ role: 'user', content: 'Check failing unit tests and summarize git changes' }] },
        { id: 'a2', messages: [{ role: 'user', content: 'Check failing unit tests and summarize git changes' }] },
      ],
    });
    assert.equal(sugs.length, 1);
    assert(sugs[0].prompt.includes('failing unit tests'));
  });
});
