const WS = require('ws');
(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const t = list.filter(x => x.type === 'page' && !x.url.startsWith('devtools'))[0];
  const ws = new WS(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const logs = [];
  await new Promise(r => ws.on('open', r));
  ws.on('message', m => { const d = JSON.parse(m);
    if (d.method === 'Runtime.consoleAPICalled') { const x = d.params.args.map(a=>a.value||a.description).join(' '); if (/DBG|error/i.test(x)) logs.push(d.params.type+': '+x.slice(0,170)); }
    if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(d.params.exceptionDetails.text).slice(0,170));
    if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  const raw = (m2,p={}) => new Promise(res => { const i=++id; pending.set(i,res); ws.send(JSON.stringify({id:i,method:m2,params:p})); });
  const ev = async (e) => { const r = await raw('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return 'EXC '+JSON.stringify(r.result.exceptionDetails).slice(0,200); return r.result.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const type = (txt) => ev(`(() => { const ta = document.querySelector('.composer textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(ta, ${JSON.stringify(txt)}); ta.dispatchEvent(new Event('input',{bubbles:true})); return ta.value.length; })()`);
  const newChat = () => ev(`(() => { const b=Array.from(document.querySelectorAll('button')).find(x=>/New chat/i.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  await raw('Runtime.enable');
  await ev(`localStorage.removeItem('autobot:convs')`);
  await raw('Page.reload', { ignoreCache: true });
  await wait(3500);
  await newChat(); await wait(400);
  await type('Write 25 numbered sentences about volcanoes.');
  await ev(`document.querySelector('button.send:not(.stop)').click()`);
  await wait(900);
  await type('QUEUEZ: reply with exactly ZOK');
  await wait(100);
  await ev(`document.querySelector('button.send.queued').click()`);
  await wait(250);
  await newChat(); await wait(600);
  for (let i = 0; i < 240; i++) { await wait(700);
    const c = await ev(`document.querySelectorAll('.queue-chip').length`);
    const s = await ev(`!!document.querySelector('button.send.stop')`);
    if (!c && !s && i > 6) { await wait(2500); if (!(await ev(`!!document.querySelector('button.send.stop')`))) break; } }
  await wait(1000);
  const convs = JSON.parse(await ev(`localStorage.getItem('autobot:convs') || '[]'`));
  for (const c of convs) { console.log('CONV msgs', c.messages.length, JSON.stringify(c.title).slice(0,30));
    for (const m of c.messages) console.log('   ', m.role.padEnd(9), '»', String(m.content||'').replace(/\n/g,' ').slice(0,48)); }
  console.log('--- console ---'); console.log(logs.join('\n') || 'none');
  ws.close();
})();
