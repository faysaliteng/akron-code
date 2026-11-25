const WS = require('ws');
const fs = require('fs');
const path = require('path');
// Live check: every slash command that must not touch the network
// (notes, toggles, panels, IPC-backed lookups) resolves in the real app instead
// of falling through to "Unknown slash command". Plus the new skill-prompt
// resolution through the real IPC bridge.
//
// Requires: dev app on :9333 (npx electron . --remote-debugging-port=9333).
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 400) : '')); }
  };

  await raw('Runtime.enable');
  await raw('Page.reload', { ignoreCache: true });
  await wait(4000);

  // Fresh conversation so transcripts never interleave with earlier runs.
  await ev(`(() => { const b=Array.from(document.querySelectorAll('button')).find(x=>/New chat/i.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  await wait(500);

  // Type a slash command and press Enter exactly like a user would.
  const run = async (line) => {
    const ok = await ev(`(() => {
      const ta = document.querySelector('.composer textarea');
      if (!ta) return 'no-textarea';
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(ta, ${JSON.stringify(line)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return 'sent';
    })()`);
    if (ok !== 'sent') return 'DISPATCH-FAILED:' + ok;
    await wait(800);
    // Several commands switch the main panel (Scheduled, Memory, Terminal…),
    // which unmounts the transcript. Re-select the conversation so the message
    // that was just appended is actually in the DOM before we read it.
    await ev(`(() => { const c = document.querySelector('.conv'); c && c.click(); return 1; })()`);
    await wait(200);
    // Last assistant message in the DOM transcript.
    return ev(`(() => {
      const nodes = Array.from(document.querySelectorAll('.chat .msg, .chat [class*="msg"]'));
      const assist = nodes.filter(n => /assistant/.test(n.className));
      const last = assist[assist.length - 1];
      return last ? (last.innerText || '').trim() : '';
    })()`);
  };

  // ---- negative control: the harness can actually see a failure ----------
  const bogus = await run('/definitely-not-a-command');
  check('unknown command still reports "Unknown slash command" (control)', /Unknown slash command/i.test(String(bogus)), String(bogus).slice(0, 160));

  // ---- notes / toggles / panels -----------------------------------------
  const cases = [
    ['/help', /\/help|\/compact|Commands|commands/i, 'help lists the command surface'],
    ['/usage', /token|cost|usage/i, 'usage reports tokens/cost'],
    ['/context', /context/i, 'context reports window occupancy'],
    ['/version', /Helio Bot|v?\d+\.\d+\.\d+/i, 'version prints the build'],
    ['/daemon', /Scheduled|Background|background/i, 'daemon opens the background services panel'],
    ['/workflows', /Workflow|workflow|Scheduled/ , 'workflows opens the Scheduled panel'],
    ['/hooks', /hook|Hook/ , 'hooks lists the merged hook config'],
    ['/mcp', /mcp|MCP|server/i, 'mcp lists server state'],
    ['/skills', /skill|Skill/ , 'skills lists the registry'],
    ['/plugins', /plugin|Plugin/ , 'plugins lists installed plugins'],
    ['/permissions', /permission|Permission|deny|allow/ , 'permissions shows mode and rules'],
    ['/agents', /agent|Agent/ , 'agents lists agent types'],
    ['/memory', /EXAMPLE\.md|memory|Memory/ , 'memory shows the CLAUDE.md hierarchy'],
    ['/bashes', /shell|agent|monitor|job|Job|idle|none/i, 'bashes lists background work'],
    ['/todos', /todo|Todo|task|Task/ , 'todos lists the task list'],
    ['/ide', /IDE|Helio Bot/ , 'ide explains the integrated surface'],
    ['/desktop', /desktop|Desktop|GUI/ , 'desktop explains there is no hand-off'],
    ['/tui', /GUI|terminal|Terminal/ , 'tui explains the renderer does not apply'],
    ['/keybindings', /Settings|⌘K|shortcut|Shortcut/ , 'keybindings points at Settings → Shortcuts'],
    ['/scroll-speed', /scroll|Scroll|OS/ , 'scroll-speed explains the OS setting'],
    ['/wellbeing', /break|Break|OS/ , 'wellbeing explains OS-level reminders'],
    ['/privacy-settings', /Settings|telemetry|provider/ , 'privacy-settings opens Settings'],
    ['/rate-limit-options', /Settings|provider|limit/ , 'rate-limit-options opens Settings'],
    ['/release-notes', /Helio Bot|release|Release/ , 'release-notes prints the build'],
    ['/update', /install|Install|DMG|build/ , 'update explains the install path'],
    ['/install', /install|Install|DMG|build/ , 'install maps onto the update path'],
    ['/powerup', /\/help|tour|plan|compact/i, 'powerup prints the guided tour'],
    ['/team-onboarding', /install|provider|EXAMPLE\.md|onboard/i, 'team-onboarding prints the onboarding guide'],
    ['/mobile', /Anthropic|mobile|not|do not|Nothing|nothing/i, 'mobile is honestly marked not applicable'],
    ['/teleport', /Anthropic|teleport|Nothing|nothing|not/i, 'teleport is honestly marked not applicable'],
    ['/stickers', /Anthropic|Nothing|nothing|not/i, 'stickers is honestly marked not applicable'],
    ['/radio', /Anthropic|Nothing|nothing|not/i, 'radio is honestly marked not applicable'],
    ['/heapdump', /Anthropic|Nothing|nothing|not/i, 'heapdump is honestly marked not applicable'],
    ['/bridge-kick', /Anthropic|Nothing|nothing|not/i, 'bridge-kick is honestly marked not applicable'],
    ['/pro-trial-expired', /Anthropic|Nothing|nothing|not/i, 'pro-trial-expired is honestly marked not applicable'],
    ['/web-setup', /Anthropic|Nothing|nothing|not/i, 'web-setup is honestly marked not applicable'],
    ['/install-slack-app', /Anthropic|Nothing|nothing|not/i, 'install-slack-app is honestly marked not applicable'],
    ['/setup-bedrock', /Bedrock|bedrock/ , 'setup-bedrock explains the endpoint'],
    ['/setup-vertex', /Vertex|PROJECT_ID/ , 'setup-vertex explains the endpoint'],
  ];
  for (const [line, re, label] of cases) {
    const out = await run(line);
    const text = String(out || '');
    check(label, re.test(text) && !/Unknown slash command/i.test(text), text.slice(0, 200));
    // Every one of these opens/modifies UI; close the panel + settings between runs.
    await ev(`(() => {
      const x = document.querySelector('.modal .close, .settings-modal .close, [aria-label="Close"]');
      if (x) x.click();
      const p = document.querySelector('.panel-close, .scheduled .close');
      if (p) p.click();
      return 1;
    })()`);
    await wait(120);
  }

  // ---- /session, then a real on-disk repo, then /diff --------------------
  const sess = String((await run('/session')) || '').trim();
  check('session prints the conversation + working folder', /^Session\s/.test(sess) && /Working folder:\s*\S+/.test(sess), sess.slice(0, 200));

  // The per-conversation folder is where the agent actually works, so build a
  // throwaway git repo inside it and confirm /diff reads the real working tree.
  const folder = ((/Working folder:\s*(.+?)\.\s*Use \/export/.exec(sess) || [])[1] || '').trim();
  let diffSeen = '';
  if (folder && fs.existsSync(folder)) {
    const { execFileSync } = require('child_process');
    const git = (args) => execFileSync('git', args, { cwd: folder, encoding: 'utf8' });
    const hadRepo = fs.existsSync(path.join(folder, '.git'));
    if (!hadRepo) {
      git(['init']);
      git(['config', 'user.email', 'test@helio.local']);
      git(['config', 'user.name', 'Helio Test']);
      fs.writeFileSync(path.join(folder, 'probe.txt'), 'line one\n');
      git(['add', 'probe.txt']);
      git(['commit', '-m', 'fixture']);
      fs.writeFileSync(path.join(folder, 'probe.txt'), 'line one\nline two (modified for /diff)\n');
    }
    diffSeen = String((await run('/diff')) || '');
    check('diff reports the working tree', /Git diff/i.test(diffSeen) && /probe\.txt/.test(diffSeen), diffSeen.slice(0, 240));
    if (!hadRepo) {
      try { fs.rmSync(path.join(folder, '.git'), { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(path.join(folder, 'probe.txt'), { force: true }); } catch (_) {}
    }
  } else {
    check('diff reports the working tree', false, 'no folder resolved: ' + JSON.stringify(folder));
  }

  // ---- toggles that change real state -----------------------------------
  await run('/voice');
  await wait(300);
  const v1 = await ev(`(() => { const b = document.querySelector('.composer button.voice-on, .composer .voice-on'); return !!b; })()`);
  check('/voice turns the voice session on', v1 === true, v1);
  await run('/voice');
  await wait(300);
  const v2 = await ev(`!!document.querySelector('.composer .voice-on')`);
  check('/voice turns it back off', v2 === false, v2);

  const chromeBefore = await ev(`window.autobot.getFeatures().then(f => !!f.chrome)`);
  await run('/chrome');
  await wait(400);
  const chromeAfter = await ev(`window.autobot.getFeatures().then(f => !!f.chrome)`);
  check('/chrome flips features.chrome in the persisted settings', chromeAfter !== chromeBefore, { chromeBefore, chromeAfter });
  await run('/chrome'); // restore
  await wait(300);

  const remoteBefore = await ev(`window.autobot.getFeatures().then(f => !!f.remoteControl)`);
  await run('/remote-env');
  await wait(400);
  const remoteAfter = await ev(`window.autobot.getFeatures().then(f => !!f.remoteControl)`);
  check('/remote-env flips features.remoteControl', remoteAfter !== remoteBefore, { remoteBefore, remoteAfter });
  await run('/remote-env');

  // /effort drives the real thinking control.
  await run('/effort high');
  await wait(500);
  const effort = await ev(`(() => { const b = document.querySelector('.reason-pick'); return b ? b.innerText.replace(/\\s+/g, ' ').trim() : ''; })()`);
  check('/effort high sets the composer thinking label', /High/i.test(String(effort)), effort);
  await run('/effort auto');

  // /rename changes the conversation title.
  await run('/rename Parity Check');
  await wait(400);
  const title = await ev(`(() => { const c = JSON.parse(localStorage.getItem('autobot:convs') || '[]')[0]; return c && c.title; })()`);
  check('/rename updates the conversation title', String(title) === 'Parity Check', title);

  // ---- skill commands resolve through the real IPC bridge ---------------
  const cwd = JSON.stringify('/Users/saimon/Documents/Default Project/autobot');
  for (const name of ['batch', 'claude-api', 'claude-in-chrome', 'fewer-permission-prompts', 'keybindings-help', 'run', 'run-skill-generator', 'update-config']) {
    const r = await ev(`window.autobot.resolveCommand(${JSON.stringify(name)}, 'ARGHERE', ${cwd})`);
    const prompt = r && r.prompt ? String(r.prompt) : '';
    check(`skill command /${name} resolves to a real prompt`, prompt.length > 200 && /ARGHERE/.test(prompt), { has: prompt.length, sample: prompt.slice(0, 90) });
  }
  const listed = await ev(`window.autobot.listCommands(${cwd}).then(a => a.filter(c => c.isSkill).map(c => c.name).sort().join(','))`);
  check('picker lists all 8 skill commands', String(listed).split(',').filter(Boolean).length >= 8, listed);

  // ---- nothing broke ----------------------------------------------------
  check('no console errors or exceptions during the run', logs.length === 0, logs.slice(0, 5));
  await ev(`(() => { const b=Array.from(document.querySelectorAll('button')).find(x=>/New chat/i.test(x.innerText||'')); b&&b.click(); return 1; })()`);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  ws.close();
  process.exit(fail ? 1 : 0);
})();
