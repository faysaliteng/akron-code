export const meta = {
  name: 'loop-until-dry',
  description: 'Keep hunting until two consecutive rounds find nothing new',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
}

const BUGS = {
  type: 'object',
  required: ['bugs'],
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'desc'],
        properties: { id: { type: 'string' }, desc: { type: 'string' } },
      },
    },
  },
}

const FINDERS = [{ prompt: 'Find bugs in module A.' }, { prompt: 'Find bugs in module B.' }]

const seen = new Set()
const confirmed = []
let dry = 0

phase('Find')
while (dry < 2) {
  const found = (await parallel(FINDERS.map((f) => () =>
    agent(f.prompt, { phase: 'Find', schema: BUGS })
  ))).filter(Boolean).reduce((acc, r) => acc.concat(r.bugs || []), [])
  const fresh = found.filter((b) => !seen.has(b.id))
  if (!fresh.length) { dry += 1; log(`dry round ${dry}`); continue }
  dry = 0
  fresh.forEach((b) => seen.add(b.id))
  phase('Verify')
  const judged = await parallel(fresh.map((b) => () =>
    agent(`Refute: ${b.desc}`, { phase: 'Verify', schema: BUGS })
      .then((v) => ({ bug: b, real: !(v && v.bugs && v.bugs.length) }))
  ))
  confirmed.push(...judged.filter(Boolean).filter((j) => j.real).map((j) => j.bug))
  phase('Find')
}

return { confirmed, rounds: seen.size }
