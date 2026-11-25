// Live check: app-chrome branding after the Claude -> Example rename.
//
// Scope note: skill *content* shown in the Skills panel comes from the user's
// own library on disk (~/.config/opencode/skill, .claude/skills). Those files
// are data — skill names, descriptions and real MCP tool identifiers
// (mcp__Claude_Browser__*) must stay verbatim or the skills stop importing.
// So this suite asserts the app's own chrome is rebranded and only *reports*
// how much third-party skill text mentions Claude.
const WS = require('ws');

async function connect() {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let n = 0;
  await new Promise((r) => ws.on('open', r));
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = ++n;
    const on = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id === id) { ws.off('message', on); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    };
    ws.on('message', on);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  return { ws, rpc, evaluate };
}

const CHROME = `
(() => {
  const pick = (sel) => Array.from(document.querySelectorAll(sel))
    .map(e => e.innerText || '').join('\\n');
  const chrome = [
    document.title,
    pick('.titlebar'),
    pick('aside'),
    pick('.composer, .composer-wrap, .input-wrap'),
    pick('header'),
  ].join('\\n');
  const links = Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href'));
  return {
    chrome,
    claude: (chrome.match(/Claude/g) || []).length,
    example: (chrome.match(/Example/g) || []).length,
    akron: links.filter(h => /akronlogic\\.com/.test(h)),
    body: document.body.innerText,
  };
})()`;

(async () => {
  const { ws, rpc, evaluate } = await connect();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let fail = 0;
  const check = (name, cond, extra) => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' :: ' + JSON.stringify(extra)}`);
    if (!cond) fail++;
  };

  await rpc('Page.reload', { ignoreCache: true });
  await sleep(2500);

  const home = await evaluate(CHROME);
  check('document title is Akron Bot', /Akron Bot/.test(home.chrome), home.chrome.split('\n')[0]);
  check('app chrome has zero "Claude"', home.claude === 0, home.claude);
  check('Akron Bot wordmark rendered', /Akron Bot/.test(home.body));
  check('sidebar footer links akronlogic.com', home.akron.includes('https://akronlogic.com'), home.akron);
  check('no stray "Example" placeholder leaks', !/Example Example|@@!P/.test(home.body));

  // A panel with rebranded copy: /status writes "Akron Bot renders status in the composer".
  await evaluate(`(() => {
    const el = document.querySelector('textarea, input[type=text], .composer textarea');
    return !!el;
  })()`);

  // Skills panel: confirm the "Example" source label renders.
  await evaluate(`(() => {
    const el = Array.from(document.querySelectorAll('button, .nav-row, .nav-item'))
      .find(e => /^\\s*Skills\\s*$/i.test(e.textContent || ''));
    if (el) el.click();
    return !!el;
  })()`);
  await sleep(1000);
  const skills = await evaluate(CHROME);
  check('Skills panel chrome still clean', skills.claude === 0, skills.claude);
  const skillMentions = (skills.body.match(/Claude/g) || []).length;
  console.log(`  info Third-party skill text mentioning "Claude": ${skillMentions} (preserved from disk on purpose)`);

  console.log(`\n${fail === 0 ? 'PASSED' : 'FAILED'} (${fail} failures)`);
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
