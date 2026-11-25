const WS = require('ws');
(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const t = list.filter(x => x.type === 'page' && !x.url.startsWith('devtools'))[0];
  const ws = new WS(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const logs = [];
  await new Promise(r => ws.on('open', r));
  ws.on('message', m => { const d = JSON.parse(m);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push('console: ' + d.params.args.map(a=>a.value||a.description).join(' ').slice(0,180));
    if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(d.params.exceptionDetails.text).slice(0,180));
    if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  const raw = (m2,p={}) => new Promise(res => { const i=++id; pending.set(i,res); ws.send(JSON.stringify({id:i,method:m2,params:p})); });
  const ev = async (e) => { const r = await raw('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return 'EXC '+JSON.stringify(r.result.exceptionDetails).slice(0,300); return r.result.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const type = (txt) => ev(`(() => { const ta = document.querySelector('.composer textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(ta, ${JSON.stringify(txt)}); ta.dispatchEvent(new Event('input',{bubbles:true})); return ta.value.length; })()`);
  const newChat = () => ev(`(() => { const b=Array.from(document.querySelectorAll('button')).find(x=>/New chat/i.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  const st = () => ev(`!!document.querySelector('button.send.stop')`);
  const chips = () => ev(`document.querySelectorAll('.queue-chip').length`);
  const msgs = () => ev(`Array.from(document.querySelectorAll('.msg')).map(m=>m.className.replace('msg ','')+':'+m.innerText.replace(/\\n/g,' ').slice(0,30)).join(' // ')`);
  await raw('Runtime.enable');
  await ev(`localStorage.removeItem('autobot:convs')`);
  await raw('Page.reload', { ignoreCache: true });
  await wait(3500);

  // --- Case 1: same-chat queue flush
  await newChat(); await wait(400);
  await type('Write 25 numbered sentences about deserts.');
  await ev(`document.querySelector('button.send:not(.stop)').click()`);
  await wait(900);
  console.log('C1 streaming:', await st());
  await type('SAMEQ: reply with exactly SOK');
  await wait(120);
  console.log('C1 arrow alongside stop:', await ev(`!!document.querySelector('button.send.queued')`), '| stop present:', await st());
  await ev(`document.querySelector('button.send.queued').click()`);
  await wait(250);
  console.log('C1 chips:', await chips(), '| composer cleared:', await ev(`document.querySelector('.composer textarea').value === ''`));
  console.log('C1 queue bar text:', await ev(`(document.querySelector('.queue-bar')||{}).innerText||'none'`));
  for (let i = 0; i < 300; i++) { await wait(700); if (!(await chips()) && !(await st()) && i > 5) { await wait(3000); if (!(await st())) break; } }
  console.log('C1 conv:', await ev(`(JSON.parse(localStorage.getItem('autobot:convs')||'[]').find(c=>c.id===localStorage.getItem('autobot:activeId'))||{messages:[]}).messages.map(m=>m.role+':'+String(m.content).replace(/\\n/g,' ').slice(0,24)).join(' // ')`));

  // --- Case 2: Send now cancels the live run
  await wait(500);
  await type('Write 40 numbered sentences about rainforests.');
  await ev(`document.querySelector('button.send:not(.stop)').click()`);
  await wait(900);
  await type('NOWQ: reply with exactly NOK');
  await wait(120);
  await ev(`document.querySelector('button.send.queued').click()`);
  await wait(250);
  console.log('C2 chips:', await chips());
  const t0 = Date.now();
  await ev(`(() => { const b=Array.from(document.querySelectorAll('button')).find(x=>/Send now/i.test(x.innerText||'')); if(b) b.click(); return !!b; })()`);
  let started = 0;
  for (let i = 0; i < 40; i++) { await wait(250); if (await st()) { started = Date.now()-t0; break; } }
  console.log('C2 turn2 started in ms:', started || 'never', '| chips:', await chips());
  for (let i = 0; i < 300; i++) { await wait(700); if (!(await st()) && i > 4) { await wait(3000); if (!(await st())) break; } }
  console.log('C2 conv:', await ev(`(JSON.parse(localStorage.getItem('autobot:convs')||'[]').find(c=>c.id===localStorage.getItem('autobot:activeId'))||{messages:[]}).messages.map(m=>m.role+':'+String(m.content).replace(/\\n/g,' ').slice(0,24)).join(' // ')`));
  console.log('C2 view:', (await msgs()).slice(0,400));
  console.log('errors:', logs.slice(0,4).join(' ; ') || 'none');
  ws.close();
})();
