'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { normalizeAskPayload, createQuestionGate } = require('../electron/question-gate');

const ROOT = path.resolve(__dirname, '..');
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
  console.log('\nPhase 5 — QuestionGate & Inline Non-Blocking QuestionDock:');

  await test('normalizeAskPayload handles both multi-question array & legacy shorthand', () => {
    const multi = normalizeAskPayload({
      questions: [
        {
          id: 'db',
          header: 'Database',
          question: 'Which engine should we use?',
          multiSelect: false,
          options: [
            { label: 'PostgreSQL (Recommended)', description: 'ACID & relational' },
            { label: 'SQLite', description: 'Embedded single file' },
          ],
        },
        {
          id: 'feats',
          header: 'Features',
          question: 'Pick add-ons',
          is_multi_select: true,
          options: ['Auth', 'Metrics'],
        },
      ],
    });
    assert.strictEqual(multi.questions.length, 2);
    assert.strictEqual(multi.questions[0].options[0].recommended, true);
    assert.strictEqual(multi.questions[0].options[0].cleanLabel, 'PostgreSQL');
    assert.strictEqual(multi.questions[1].multiSelect, true);
    assert.deepStrictEqual(multi.questions[1].options.map((o) => o.label), ['Auth', 'Metrics']);

    const legacy = normalizeAskPayload({
      question: 'Proceed with deploy?',
      options: ['Yes (Recommended)', 'No'],
    });
    assert.strictEqual(legacy.questions.length, 1);
    assert.strictEqual(legacy.primaryQuestion, 'Proceed with deploy?');
    assert.strictEqual(legacy.primaryOptions[0].recommended, true);
  });

  await test('createQuestionGate scopes events by convId, returns structured answers & handles abort cleanup', async () => {
    const pending = new Map();
    const gate = createQuestionGate(pending);
    const events = [];

    const p = gate.ask({
      raw: {
        questions: [
          { id: 'q1', header: 'Runtime', question: 'Select runtime', options: [{ label: 'Node 24' }] },
          { id: 'q2', header: 'Checks', question: 'Select checks', multiSelect: true, options: ['Lint', 'Test'] },
        ],
      },
      runId: 'run-42',
      convId: 'conv-abc',
      emit: (e) => events.push(e),
    });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'question');
    assert.strictEqual(events[0].convId, 'conv-abc');
    assert.strictEqual(events[0].runId, 'run-42');
    assert.strictEqual(events[0].questions.length, 2);

    const ansRes = gate.answer(events[0].id, { answers: { q1: 'Node 24', q2: ['Lint', 'Test'] } });
    assert.strictEqual(ansRes.ok, true);
    const resolved = await p;
    assert(resolved.includes('Runtime: Node 24'));
    assert(resolved.includes('"q2":["Lint","Test"]'));

    // Abort cleanup
    const ac = new AbortController();
    const abortEvents = [];
    const pAbort = gate.ask({
      raw: { question: 'Will abort?' },
      runId: 'run-99',
      convId: 'conv-xyz',
      signal: ac.signal,
      emit: (e) => abortEvents.push(e),
    });
    ac.abort();
    const abortOut = await pAbort;
    assert.strictEqual(abortOut, '(cancelled)');
    assert(abortEvents.some((e) => e.type === 'questionCleared' && e.runId === 'run-99'));
  });

  await test('ExitPlanMode askPlan emits convId and resolves compatible approved / rejected strings', async () => {
    const gate = createQuestionGate(new Map());
    const evs = [];
    const pApprove = gate.askPlan({ raw: { plan: '## Step 1\nBuild dock' }, runId: 'r1', convId: 'c1', emit: (e) => evs.push(e) });
    assert.strictEqual(evs[0].type, 'plan');
    assert.strictEqual(evs[0].convId, 'c1');
    gate.answer(evs[0].id, { approved: true, note: 'Go fast' });
    const approvedText = await pApprove;
    assert(/approved/i.test(approvedText) && !/not approved|rejected/i.test(approvedText));

    const pReject = gate.askPlan({ raw: { plan: '## Step 2' }, runId: 'r2', convId: 'c2', emit: (e) => evs.push(e) });
    gate.answer(evs[1].id, { approved: false, note: 'Split phase 2' });
    const rejectedText = await pReject;
    assert(/not approved/i.test(rejectedText) && rejectedText.includes('Split phase 2'));
  });

  await test('App.jsx wires non-blocking <QuestionDock /> in BOTH Agent & IDE views, removes QuestionModal, and wires MediaDocCardList', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'App.jsx'), 'utf8');
    const dockSrc = fs.readFileSync(path.join(ROOT, 'src', 'components', 'QuestionDock.jsx'), 'utf8');
    const cardSrc = fs.readFileSync(path.join(ROOT, 'src', 'components', 'MediaDocCard.jsx'), 'utf8');
    const countQuestionDocks = (appSrc.match(/<QuestionDock\b/g) || []).length;
    assert.strictEqual(countQuestionDocks, 2, `Expected 2 <QuestionDock /> mounts (IDE + Agent), found ${countQuestionDocks}`);
    assert(!appSrc.includes('<QuestionModal'), 'Blocking <QuestionModal /> must be removed from App.jsx');
    assert(appSrc.includes('<MediaDocCardList'), 'App.jsx Message must render <MediaDocCardList />');
    assert(appSrc.includes('waitingQuestionConvIds'), 'Session tabs must track waitingQuestionConvIds');
    assert(dockSrc.includes('multiSelect') && dockSrc.includes('Approve & Execute') && dockSrc.includes('Other / Type custom answer'));
    assert(cardSrc.includes('Extract to Workspace') && cardSrc.includes('Convert to GIF') && cardSrc.includes('Remove BG'));
  });

  console.log(`\nQUESTION_DOCK_RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
