export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  whenToUse: 'When CI is red intermittently and you need a culprit list plus patches.',
  phases: [
    { title: 'Scan', detail: 'grep test logs for retry markers' },
    { title: 'Fix', detail: 'one agent per flaky test', model: 'haiku' },
  ],
}

const TASK = (typeof args === 'string' && args.trim()) ? args.trim() : ''
if (!TASK) return { error: 'No task provided. Pass the task description as args.' }

const FLAKY_SCHEMA = {
  type: 'object',
  required: ['flaky'],
  properties: {
    flaky: {
      type: 'array',
      items: {
        type: 'object',
        required: ['test', 'reason'],
        properties: { test: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  required: ['patch'],
  properties: { patch: { type: 'string' }, confidence: { type: 'number' } },
}

phase('Scan')
log(`Scanning for flaky tests: ${TASK}`)
const scan = await agent(`List flaky tests for: ${TASK}`, { label: 'scan', schema: FLAKY_SCHEMA })

const flaky = (scan && scan.flaky) || []
if (!flaky.length) return { flaky: [], fixes: [] }

phase('Fix')
const fixes = await pipeline(
  flaky,
  (item) => agent(`Propose a fix for the flaky test ${item.test} (${item.reason})`, {
    label: `fix:${item.test}`,
    phase: 'Fix',
    schema: FIX_SCHEMA,
  }),
  (fix, original) => ({ test: original.test, ...fix })
)

return {
  scanned: TASK,
  flaky: flaky.map((f) => f.test),
  fixes: fixes.filter(Boolean),
  summary: `${flaky.length} flaky test(s), ${fixes.filter(Boolean).length} fix(es)`,
}
