// Live suite: the Plugins & Connectors directory (curated catalog + live MCP registry).
// Requires the dev app on CDP 9333.
const WS = require('ws');
(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.log('FAIL no page target on 9333'); process.exit(1); }
  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let n = 0;
  await new Promise((r) => ws.on('open', r));
  const rpc = (m, p) => new Promise((res) => {
    const id = ++n;
    const on = (raw) => { const x = JSON.parse(raw.toString()); if (x.id === id) { ws.off('message', on); res(x.result); } };
    ws.on('message', on); ws.send(JSON.stringify({ id, method: m, params: p }));
  });
  const ev = async (e) => {
    const r = await rpc('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { err: (r.exceptionDetails.exception || {}).description };
    return r.result.value;
  };
  let fail = 0;
  const check = (nm, ok, extra) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${nm}${ok ? '' : ' :: ' + JSON.stringify(extra)}`); if (!ok) fail++; };

  const stats = await ev(`window.autobot.pluginStats()`);
  check('pluginStats() available', stats && typeof stats.total === 'number', stats);
  check('catalog is large (>= 400 entries)', stats && stats.total >= 400, stats && stats.total);
  check('connectors present', stats && stats.connectors >= 350, stats && stats.connectors);
  check('plugins present', stats && stats.plugins >= 40, stats && stats.plugins);
  check('categories >= 20', stats && stats.categories >= 20, stats && stats.categories);
  check('entries carry MCP endpoints', stats && stats.withEndpoint >= 10, stats && stats.withEndpoint);

  const cats = await ev(`window.autobot.pluginCategories()`);
  check('pluginCategories() returns strings', Array.isArray(cats) && cats.length > 0 && typeof cats[0] === 'string', cats && cats.slice(0, 4));

  const connectors = await ev(`window.autobot.listPlugins({ type: 'connector' })`);
  check('listPlugins({type:connector}) returns rows', Array.isArray(connectors) && connectors.length > 100, connectors && connectors.length);
  const first = (connectors || [])[0] || {};
  check('connector row shape', !!first.id && !!first.name && first.type === 'connector' && Array.isArray(first.tools), first);

  const plugins = await ev(`window.autobot.listPlugins({ type: 'plugin' })`);
  check('listPlugins({type:plugin}) returns rows', Array.isArray(plugins) && plugins.length >= 40, plugins && plugins.length);
  check('plugin row has provides[]', !!(plugins || []).every((p) => Array.isArray(p.provides)), (plugins || [])[0]);

  const byCat = await ev(`window.autobot.listPlugins({ category: 'Engineering' })`);
  check('category filter narrows results', Array.isArray(byCat) && byCat.length > 0 && byCat.every((e) => e.category === 'Engineering'), byCat && byCat.length);

  const found = await ev(`window.autobot.searchPlugins('stripe', { limit: 5 })`);
  check('search finds Stripe', Array.isArray(found) && found.some((e) => /stripe/i.test(e.id)), (found || []).map((e) => e.id));

  const goal = await ev(`window.autobot.suggestPlugins('send slack alerts when a deploy fails', { limit: 5 })`);
  check('suggest returns ranked entries', Array.isArray(goal) && goal.length > 0, (goal || []).map((e) => e.id));

  // Install / uninstall round-trip on an entry with no transport (pure state).
  const inst = await ev(`window.autobot.installPlugin('plugin-meeting-notes')`);
  check('install returns ok', inst && inst.ok !== false, inst && inst.error);
  check('install decorates entry as installed', inst && inst.entry && inst.entry.installed === true, inst && inst.entry);
  const only = await ev(`window.autobot.listPlugins({ installedOnly: true })`);
  check('installedOnly lists the plugin', Array.isArray(only) && only.some((e) => e.id === 'plugin-meeting-notes'), (only || []).map((e) => e.id));
  const un = await ev(`window.autobot.uninstallPlugin('plugin-meeting-notes')`);
  check('uninstall returns ok', un && un.ok !== false, un && un.error);
  const onlyAfter = await ev(`window.autobot.listPlugins({ installedOnly: true })`);
  check('installedOnly no longer lists it', !(onlyAfter || []).some((e) => e.id === 'plugin-meeting-notes'));

  const rs = await ev(`window.autobot.registryStatus()`);
  check('registryStatus() reports shape', rs && typeof rs === 'object' && 'count' in rs, rs);
  if (rs && rs.count > 0) {
    const reg = await ev(`window.autobot.listPlugins({})`);
    check('registry entries merged into the pool', (reg || []).some((e) => e.origin === 'registry'), (reg || []).filter((e) => e.origin === 'registry').length);
  } else {
    console.log('  ..  registry empty (offline or still syncing) — merge check skipped');
  }

  console.log(`\n${fail === 0 ? 'PASSED' : 'FAILED'} (${fail} failures)`);
  ws.close(); process.exit(fail ? 1 : 0);
})();
