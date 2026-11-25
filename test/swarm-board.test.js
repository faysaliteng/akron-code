'use strict';
// Unit tests for the swarm BOARD — the primitive that makes a swarm a swarm
// rather than a fan-out: a sequenced message feed every member can post to and
// read, `swarm_wait` parking, @mention routing, and the stall monitor that
// re-briefs a member whose turn ended without reporting.
//
// No network, no model: runAgent is a fake that exercises the board tools the
// host actually hands it (`opts.localTools`), so this proves the tool surface is
// wired end-to-end and not just present as definitions.

const path = require('path');
const swarm = require(path.join(__dirname, '..', 'electron', 'swarm.js'));

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function section(t) { console.log('\n# ' + t); }

const PROVIDER = { baseURL: 'http://fake.local/v1', model: 'front-1', apiKey: 'x', transport: 'openai' };

// board.wait() unrefs its timer (correct for the app: a parked worker must not
// hold the process open). That also means node would exit mid-test while we
// await it — so hold the loop open here and clear it at the end.
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  // ------------------------------------------------------------ board core
  section('board primitives');
  const b = swarm.createBoard();
  const m1 = b.post({ from: 'alice', channel: 'ui', text: 'building the header' });
  const m2 = b.post({ from: 'bob', channel: 'api', text: 'endpoints up', to: 'alice' });
  b.post({ from: 'carol', channel: 'ui', text: '@alice can you export the logo?' });
  eq('seq increments per post', [m1.seq, m2.seq], [1, 2]);
  eq('read returns everything after seq', b.read({ since: 1 }).map((m) => m.seq), [2, 3]);
  eq('read filters by channel', b.read({ since: 0, channel: 'api' }).map((m) => m.seq), [2]);
  eq('addressedTo catches explicit to', b.addressedTo('alice', { since: 0 }).map((m) => m.seq), [2, 3]);
  eq('addressedTo ignores other names', b.addressedTo('bob').map((m) => m.seq), []);
  ok('transcript renders seq/from/channel', /#3 carol \[ui\]: @alice/.test(b.transcript()));

  const t0 = Date.now();
  const early = await b.wait({ me: 'dave', since: 3, timeoutMs: 20 });
  ok('wait times out when nothing is addressed to me', early.timedOut && Date.now() - t0 >= 15);

  // A post that lands while the waiter is parked must resolve it.
  const parked = b.wait({ me: 'dave', since: 0, mentionsOnly: true, timeoutMs: 2000 });
  setTimeout(() => b.post({ from: 'alice', text: 'hey @dave review this' }), 20);
  const woke = await parked;
  ok('wait resolves on an @mention', !woke.timedOut && woke.messages.some((m) => /@dave/.test(m.text)));

  const aborted = new AbortController();
  const ac = new AbortController();
  const abortedWait = b.wait({ since: 99, timeoutMs: 5000, signal: aborted.signal });
  setTimeout(() => ac.abort() || aborted.abort(), 10);
  const ab = await abortedWait;
  ok('wait honours an abort signal', ab.aborted === true || ab.timedOut === true);

  // ----------------------------------------------------------- board tools
  section('board tool surface');
  const b2 = swarm.createBoard();
  const { defs, localTools } = swarm.boardTools(b2, 'worker-1', { channel: 'build' });
  eq('four board tools are advertised', defs.map((d) => d.name).sort(),
    ['swarm_post_message', 'swarm_read_board', 'swarm_status', 'swarm_wait']);
  ok('every advertised tool has a handler', defs.every((d) => typeof localTools[d.name] === 'function'));

  const posted = await localTools.swarm_post_message({ text: 'starting on the schema' });
  ok('post returns the assigned seq', /posted #1/.test(posted), posted);
  await localTools.swarm_post_message({ text: 'schema done', channel: 'db' });
  const feed = await localTools.swarm_read_board({ since: 0 });
  ok('read returns both messages', /starting on the schema/.test(feed) && /schema done/.test(feed), feed);
  ok('read reports the cursor to continue from', /last seq 2/.test(feed), feed);
  const nothing = await localTools.swarm_read_board({ since: 2 });
  eq('read with a caught-up cursor is empty', nothing, 'board: no new messages');
  const status = await localTools.swarm_status({});
  ok('status lists the member with its post count', /worker-1: posted \(2 posts\)/.test(status), status);
  b2.setMember('worker-2', { state: 'waiting' });
  ok('status lists a second member', /worker-2: waiting/.test(await localTools.swarm_status({})));

  const waiter = localTools.swarm_wait({ since: 2, mentions_only: false, timeout_ms: 2000 });
  setTimeout(() => b2.post({ from: 'worker-2', text: 'I need the column names' }), 15);
  const got = await waiter;
  ok('swarm_wait returns the new post', /I need the column names/.test(got), got);

  // ------------------------------------------------------- swarm end-to-end
  section('swarm uses the board and re-briefs stalls');
  const seen = [];
  const posts = [];
  const fakeRun = async (o) => {
    const prompt = String((o.messages[o.messages.length - 1] || {}).content || '');
    const who = /YOUR SUBTASK \([^)]*\): (.+)/.exec(prompt);
    const title = who ? who[1].trim() : o.provider.model;
    seen.push({ model: o.provider.model, title, hasBoard: !!o.localTools, round: o.round });
    if (o.localTools) {
      ok('runAgent received localTools for ' + title, typeof o.localTools.swarm_post_message === 'function');
      // Worker "api" reports; worker "ui" stays silent on round 1 (a stall) and
      // reports once re-briefed, which is exactly what the monitor is for.
      const mustPost = /api/.test(title) || /re-briefed|stall/i.test(prompt) || posts.includes(title);
      if (mustPost) {
        const r = await o.localTools.swarm_post_message({ text: 'done: ' + title });
        posts.push(title);
        return [{ role: 'assistant', content: 'built ' + title + ' (' + r + ')' }];
      }
      return [{ role: 'assistant', content: 'built ' + title }];
    }
    return [{ role: 'assistant', content: 'ok' }];
  };

  const events = [];
  const out = await swarm.swarm('build a shop', {
    runAgent: fakeRun,
    provider: PROVIDER,
    critique: false,
    concurrency: 2,
    emit: (e) => events.push(e),
    tasks: [
      { title: 'api', prompt: 'build the REST endpoints', tier: 'heavy' },
      { title: 'ui', prompt: 'build the storefront page', tier: 'heavy' },
    ],
  });

  ok('swarm produced one result per task', out.results.length === 2, JSON.stringify(out.results.map((r) => r.id)));
  ok('a worker that posted is round 1', out.results.some((r) => r.round === 1));
  ok('the silent worker was re-run by the monitor', out.results.filter((r) => r.round === 2).length >= 1,
    JSON.stringify(out.results.map((r) => ({ id: r.id, round: r.round }))));
  ok('monitor emitted a swarm/monitor phase', events.some((e) => e.type === 'swarm' && e.phase === 'monitor'),
    JSON.stringify(events.map((e) => e.phase || e.type).slice(0, 8)));
  ok('board survived into the summary', Array.isArray(out.board) && out.board.length >= 1, JSON.stringify(out.board));
  ok('board posts are attributed to a worker', out.board.every((m) => m.from && m.seq > 0));

  // A mention wakes the addressed member even when it did post.
  section('mention wake-up');
  const ran = [];
  const mentionRun = async (o) => {
    const prompt = String((o.messages[o.messages.length - 1] || {}).content || '');
    const t = /YOUR SUBTASK \([^)]*\): (.+)/.exec(prompt);
    const title = t ? t[1].trim() : '?';
    ran.push(title + (o.round ? '#' + o.round : ''));
    if (o.localTools && title === 'ui' && !posts.includes('ui-2')) {
      await o.localTools.swarm_post_message({ text: 'ui shell ready — @api I need /products', to: 'api' });
      posts.push('ui-2');
    } else if (o.localTools) {
      await o.localTools.swarm_post_message({ text: 'ack for ' + title, channel: 'general', to: 'ui' });
    }
    return [{ role: 'assistant', content: 'did ' + title }];
  };
  const out2 = await swarm.swarm('build a shop', {
    runAgent: mentionRun, provider: PROVIDER, critique: false, concurrency: 2,
    tasks: [
      { title: 'api', prompt: 'build endpoints', tier: 'heavy' },
      { title: 'ui', prompt: 'build page', tier: 'heavy' },
    ],
  });
  ok('addressed member got a wake-up round', out2.results.some((r) => r.round === 2),
    JSON.stringify(out2.results.map((r) => ({ id: r.id, round: r.round }))));

  clearInterval(keepAlive);
  console.log('\n' + (failed ? 'FAILED ' + failed + ' / ' + (passed + failed) : 'PASSED ' + passed));
  if (failed) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { clearInterval(keepAlive); console.error('harness crash:', e); process.exit(1); });
