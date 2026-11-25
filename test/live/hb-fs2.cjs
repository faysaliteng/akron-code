const WS = require('ws');
(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const t = list.filter(x => x.type === 'page' && !x.url.startsWith('devtools'))[0];
  const ws = new WS(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const logs = [];
  await new Promise(r => ws.on('open', r));
  ws.on('message', m => { const d = JSON.parse(m);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push('console: ' + d.params.args.map(a=>a.value||a.description).join(' ').slice(0,200));
    if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(d.params.exceptionDetails.text).slice(0,200));
    if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  const raw = (m2,p={}) => new Promise(res => { const i=++id; pending.set(i,res); ws.send(JSON.stringify({id:i,method:m2,params:p})); });
  const ev = async (e) => { const r = await raw('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return 'EXC '+JSON.stringify(r.result.exceptionDetails).slice(0,300); return r.result.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await raw('Runtime.enable');

  // 1. Verify IPC workspace handlers via the renderer bridge
  console.log('getDefaultCwd:', await ev(`window.autobot.getDefaultCwd('fs2test','Helio FS Test')`));
  console.log('getWorkspace:', await ev(`window.autobot.getWorkspace('fs2test')`));
  console.log('setWorkspace ~/Desktop:', await ev(`window.autobot.setWorkspace('fs2test','~/Desktop')`));
  console.log('getWorkspace after set:', await ev(`window.autobot.getWorkspace('fs2test')`));

  // 2. Direct tool exec through the Bash/Write/Cd path is not exposed on window;
  //    so send a real chat message to create a folder on the Desktop.
  await ev(`localStorage.removeItem('autobot:convs')`);
  await raw('Page.reload', { ignoreCache: true });
  await wait(3500);
  const type = (txt) => ev(`(() => { const ta = document.querySelector('.composer textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(ta, ${JSON.stringify(txt)}); ta.dispatchEvent(new Event('input',{bubbles:true})); return ta.value.length; })()`);
  const st = () => ev(`!!document.querySelector('button.send.stop')`);
  const cwdText = () => ev(`(document.querySelector('.cwd-chip')||document.querySelector('.cwd-pick')||{}).innerText||'?'`);

  await type('Use the Bash tool to create a folder called HelioTest on my Desktop, then confirm with ls ~/Desktop | grep HelioTest');
  await ev(`document.querySelector('button.send:not(.stop)').click()`);
  await wait(1500);
  console.log('streaming:', await st(), '| cwd chip:', (await cwdText()).slice(0,80));
  for (let i = 0; i < 180; i++) { await wait(1000); if (!(await st()) && i > 4) { await wait(3000); if (!(await st())) break; } }
  const conv = await ev(`(JSON.parse(localStorage.getItem('autobot:convs')||'[]').find(c=>c.id===localStorage.getItem('autobot:activeId'))||{messages:[]}).messages.map(m=>m.role+':'+String(m.content).replace(/\\n/g,' ').slice(0,120)).join(' // ')`);
  console.log('conv:', conv.slice(0,800));
  console.log('errors:', logs.slice(0,4).join(' ; ') || 'none');
  ws.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
