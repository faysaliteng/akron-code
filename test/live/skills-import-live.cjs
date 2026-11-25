const WS = require('ws');
const CONTENT = `---\nname: import-test-probe\ndescription: Probe skill verifying flat .md import with frontmatter parsing.\n---\n\n# Import probe\n\nBody text.\n\n## Appendix — bundled files\n\n### \`scripts/x.py\`\n\n\`\`\`python\nprint("hi")\n\`\`\`\n`;
(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let n = 0;
  await new Promise(r => ws.on('open', r));
  const rpc = (m, p) => new Promise(res => {
    const id = ++n;
    const on = raw => { const x = JSON.parse(raw.toString()); if (x.id === id) { ws.off('message', on); res(x.result); } };
    ws.on('message', on); ws.send(JSON.stringify({ id, method: m, params: p }));
  });
  const ev = async e => {
    const r = await rpc('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { err: (r.exceptionDetails.exception || {}).description };
    return r.result.value;
  };
  let fail = 0;
  const check = (nm, ok, extra) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${nm}${ok ? '' : ' :: ' + JSON.stringify(extra)}`); if (!ok) fail++; };

  const added = await ev(`window.autobot.addSkill('import-test-probe', ${JSON.stringify(CONTENT)})`);
  check('addSkill accepts a self-contained .md', added && added.ok !== false, added);
  const skills = await ev(`window.autobot.getSkills()`);
  const arr = Array.isArray(skills) ? skills : (skills && skills.skills) || [];
  const hit = arr.find(s => s.name === 'import-test-probe');
  check('imported skill discovered', !!hit, arr.length);
  check('frontmatter description parsed', !!(hit && /Probe skill verifying/.test(hit.description || '')), hit && hit.description);
  check('source is custom', hit && hit.source === 'custom', hit && hit.source);
  const del = await ev(`window.autobot.deleteSkill('import-test-probe')`);
  check('deleteSkill cleans up', del && del.ok !== false, del);
  const after = await ev(`window.autobot.getSkills()`);
  const arr2 = Array.isArray(after) ? after : (after && after.skills) || [];
  check('removed from list', !arr2.some(s => s.name === 'import-test-probe'));
  console.log(`\n${fail === 0 ? 'PASSED' : 'FAILED'} (${fail} failures)`);
  ws.close(); process.exit(fail ? 1 : 0);
})();
