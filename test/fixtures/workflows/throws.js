export const meta = {
  name: 'throws',
  description: 'A workflow whose agent throws, to prove null semantics',
  phases: ['Run'],
}

phase('Run')
const results = await parallel([
  () => agent('ok-1'),
  () => agent('boom'),
  () => agent('ok-2'),
])
// A throwing thunk becomes null; the barrier still returns every slot.
const piped = await pipeline(['a', 'boom', 'c'], async (x) => {
  if (x === 'boom') throw new Error('stage failed')
  return agent(`stage:${x}`)
})
return { results, piped, n: results.filter(Boolean).length }
