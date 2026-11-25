export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'file'],
        properties: { title: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' } },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['isReal'],
  properties: { isReal: { type: 'boolean' }, note: { type: 'string' } },
}

const DIMENSIONS = [
  { key: 'bugs', prompt: 'Find correctness bugs in the diff.' },
  { key: 'perf', prompt: 'Find performance regressions in the diff.' },
  { key: 'security', prompt: 'Find security issues in the diff.' },
]

phase('Review')
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }),
  (review) => parallel((review && review.findings ? review.findings : []).map((f) => () =>
    agent(`Adversarially verify: ${f.title}`, { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA })
      .then((v) => ({ ...f, verdict: v }))
  ))
)

const confirmed = results
  .filter(Boolean)
  .reduce((acc, group) => acc.concat(group || []), [])
  .filter(Boolean)
  .filter((f) => f.verdict && f.verdict.isReal)

return { confirmed, reviewed: DIMENSIONS.map((d) => d.key) }
