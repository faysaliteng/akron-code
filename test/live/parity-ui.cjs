const WS = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Live check of the parity config surface THROUGH the real Electron IPC bridge.
// Requires: dev app on :9333, project cwd = autobot/ with .claude/commands/hello.md
// and .claude/agents/reviewer.md on disk (written by the harness).
(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const t = list.filter((x) => x.type === 'page' && !x.url.startsWith('devtools'))[0];
  const ws = new WS(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const logs = [];
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (m) => {
    const d = JSON.parse(m);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push('console: ' + d.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300));
    if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(d.params.exceptionDetails.text).slice(0, 200));
    if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  });
  const raw = (m2, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m2, params: p })); });
  const ev = async (e) => {
    const r = await raw('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return 'EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400);
    return r.result.result.value;
  };
  await raw('Runtime.enable');

  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + JSON.stringify(extra).slice(0, 300) : '')); }
  };

  const CWD = JSON.stringify('/Users/saimon/Documents/Default Project/autobot');

  // ---- bridge surface ---------------------------------------------------
  const bridge = await ev(`Object.keys(window.autobot).filter(k => ['listCommands','resolveCommand','listAgentDefs','getProjectMemory','getPermissions','checkPermission','listCheckpoints','rewind','mcpStatus','mcpConfig'].includes(k)).sort().join(',')`);
  check('preload exposes all parity IPC', String(bridge).split(',').length >= 9, bridge);

  // ---- commands ---------------------------------------------------------
  const cmds = await ev(`window.autobot.listCommands(${CWD})`);
  check('listCommands returns an array', Array.isArray(cmds), typeof cmds);
  const names = Array.isArray(cmds) ? cmds.map((c) => c.name) : [];
  check('builtin commands present', ['help', 'clear', 'status', 'agents', 'permissions', 'rewind'].every((n) => names.includes(n)), names.slice(0, 20));
  const hello = Array.isArray(cmds) ? cmds.find((c) => c.name === 'hello') : null;
  check('project command .claude/commands/hello.md discovered', !!hello && hello.custom === true, hello);
  check('project command description parsed', !!hello && hello.description === 'Say hello with a greeting', hello && hello.description);

  const resolved = await ev(`window.autobot.resolveCommand('hello','Ada',${CWD})`);
  check('resolveCommand expands $1 and $ARGUMENTS', !!resolved && /greet Ada/.test(resolved.prompt) && /goal: Ada/.test(resolved.prompt), resolved);
  const miss = await ev(`window.autobot.resolveCommand('nope-does-not-exist','x',${CWD})`);
  check('unknown command resolves to null', miss === null, miss);

  // ---- agent defs -------------------------------------------------------
  const defs = await ev(`window.autobot.listAgentDefs(${CWD})`);
  const defNames = Array.isArray(defs) ? defs.map((d) => d.name) : [];
  check('builtin agent types present', ['general-purpose', 'Explore', 'Plan'].every((n) => defNames.includes(n)), defNames);
  check('custom reviewer agent discovered', defNames.includes('reviewer'), defNames);

  // ---- memory -----------------------------------------------------------
  const mem = await ev(`window.autobot.getProjectMemory(${CWD})`);
  check('getProjectMemory returns files list', !!mem && Array.isArray(mem.files), mem && Object.keys(mem));

  // ---- permissions ------------------------------------------------------
  const perms = await ev(`window.autobot.getPermissions(${CWD})`);
  check('getPermissions returns rule sets', !!perms && Array.isArray(perms.allow) && Array.isArray(perms.deny), perms && Object.keys(perms));
  // A deny rule lives in `<cwd>/.claude/settings.json`. Point the check at a
  // throwaway project that has one — the live cwd is the user's real folder.
  const permDir = path.join(os.tmpdir(), 'helio-parity-ui-perm');
  fs.mkdirSync(path.join(permDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(permDir, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { deny: ['Bash(rm:*)'], allow: ['Read'], defaultMode: 'auto' } }, null, 2));
  const permDirJ = JSON.stringify(permDir);
  const perms2 = await ev(`window.autobot.getPermissions(${permDirJ})`);
  check('getPermissions reads .claude/settings.json deny rule', !!perms2 && (perms2.deny || []).some((r) => /Bash\(rm/.test(String(r))), perms2 && perms2.deny);
  const denyV = await ev(`window.autobot.checkPermission('Bash',{command:'rm -rf build'},${permDirJ},'bypass')`);
  check('checkPermission: deny beats bypass', !!denyV && denyV.decision === 'deny', denyV);
  const allowV = await ev(`window.autobot.checkPermission('Bash',{command:'git status'},${permDirJ},'auto')`);
  check('checkPermission: unrelated command allowed under auto', !!allowV && allowV.decision === 'allow', allowV);

  // ---- checkpoints ------------------------------------------------------
  const ck = await ev(`window.autobot.listCheckpoints('parity-ui-conv')`);
  check('listCheckpoints returns an array', Array.isArray(ck), typeof ck);
  const rw = await ev(`window.autobot.rewind('parity-ui-conv','does-not-exist')`);
  check('rewind of unknown id fails cleanly', !!rw && rw.ok === false && Array.isArray(rw.errors), rw);

  // ---- mcp --------------------------------------------------------------
  const mcpSt = await ev(`window.autobot.mcpStatus()`);
  check('mcpStatus returns an array', Array.isArray(mcpSt), typeof mcpSt);
  const mcpCfg = await ev(`window.autobot.mcpConfig(${CWD})`);
  check('mcpConfig returns servers/sources/status', !!mcpCfg && Array.isArray(mcpCfg.servers) && Array.isArray(mcpCfg.sources), mcpCfg && Object.keys(mcpCfg));

  // ---- /help renders project commands in the transcript ----------------
  // Point a fresh conversation at the autobot/ project so `.claude/commands/
  // hello.md` is the cwd's command dir, then drive the real composer.
  const HELP_CONV = 'parityui-help-conv';
  await ev(`window.autobot.setWorkspace(${JSON.stringify(HELP_CONV)}, ${CWD})`);
  await ev(`(() => {
    localStorage.setItem('autobot:convs', JSON.stringify([{ id: ${JSON.stringify(HELP_CONV)}, title: 'Parity UI', messages: [], ts: Date.now() }]));
    localStorage.setItem('autobot:activeId', JSON.stringify(${JSON.stringify(HELP_CONV)}));
    localStorage.removeItem('autobot:workspace:${HELP_CONV}');
    return 1;
  })()`);
  await raw('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 4000));
  const cwdShown = await ev(`(document.querySelector('.cwd')||{}).innerText || ''`);
  check('composer cwd resolves to the conversation workspace', String(cwdShown).includes('Default Project/autobot'), cwdShown);
  await ev(`document.querySelector('.composer textarea').focus()`);
  await raw('Input.insertText', { text: '/help' });
  await new Promise((r) => setTimeout(r, 400));
  await raw('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
  await raw('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 2500));
  const body = String(await ev(`document.body.innerText`));
  const transcript = await ev(`(() => { const c = JSON.parse(localStorage.getItem('autobot:convs')||'[]'); const a = JSON.parse(localStorage.getItem('autobot:activeId')||'null'); const cur = c.find(x=>x.id===a); return (cur?cur.messages:[]).map(m=>String(m.content)).join('\\n'); })()`);
  const seen = String(transcript) + '\n' + body;
  check('composer cleared after /help', (await ev(`document.querySelector('.composer textarea').value`)) === '', true);
  check('/help lists builtin commands', /\/help/.test(seen) && /\/rewind/.test(seen), seen.slice(0, 300));
  check('/help lists the project hello command', /\/hello/.test(seen), seen.slice(0, 500));

  console.log('\\nerrors: ' + (logs.slice(0, 3).join(' ; ') || 'none'));
  console.log('=== PARITY-UI RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
