const WS = require('ws');
(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const t = list.filter(x => x.type === 'page' && !x.url.startsWith('devtools'))[0];
  const ws = new WS(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const logs = [];
  await new Promise(r => ws.on('open', r));
  ws.on('message', m => { const d = JSON.parse(m);
    if (d.method === 'Runtime.consoleAPICalled') { const x = d.params.args.map(a=>a.value||a.description).join(' '); if (/DBG|error/i.test(x)) logs.push(d.params.type+': '+x.slice(0,160)); }
    if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(d.params.exceptionDetails.text).slice(0,160));
    if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  const raw = (m2,p={}) => new Promise(res => { const i=++id; pending.set(i,res); ws.send(JSON.stringify({id:i,method:m2,params:p})); });
  const ev = async (e) => { const r = await raw('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return 'EXC '+JSON.stringify(r.result.exceptionDetails).slice(0,250); return r.result.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const type = (txt) => ev(`(() => { const ta = document.querySelector('.composer textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(ta, ${JSON.stringify(txt)}); ta.dispatchEvent(new Event('input',{bubbles:true})); return ta.value.length; })()`);
  const newChat = () => ev(`(() => { const b=Array.from(document.querySelectorAll('button')).find(x=>/New chat/i.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  await raw('Runtime.enable');
  await ev(`localStorage.removeItem('autobot:convs')`);
  await raw('Page.reload', { ignoreCache: true });
  await wait(3500);
  await newChat(); await wait(400);
  await type('Write 60 numbered sentences about castles.');
  await ev(`document.querySelector('button.send:not(.stop)').click()`);
  // wait until some text has streamed
  for (let i=0;i<60;i++){ await wait(250); const n = await ev(`document.querySelectorAll('.msg.assistant .md').length && document.querySelector('.msg.assistant .md').innerText.length`); if (n > 60) break; }
  console.log('partial chars before stop:', await ev(`(document.querySelector('.msg.assistant .md')||{innerText:''}).innerText.length`));
  await ev(`document.querySelector('button.send.stop').click()`);
  await wait(2500);
  console.log('after stop, streaming:', await ev(`!!document.querySelector('button.send.stop')`));
  console.log('after stop assistant msgs:', await ev(`document.querySelectorAll('.msg.assistant').length`));
  console.log('kept chars:', await ev(`(document.querySelector('.msg.assistant .md')||{innerText:''}).innerText.length`));
  console.log('banner:', await ev(`(document.querySelector('.error')||{}).innerText||'none'`));
  console.log('send btn now:', await ev(`document.querySelector('button.send').className`));
  // composer still usable?
  await type('Reply with exactly AFTER-STOP');
  await ev(`document.querySelector('button.send:not(.stop)').click()`);
  for (let i=0;i<80;i++){ await wait(500); if (!(await ev(`!!document.querySelector('button.send.stop')`)) && i>3) break; }
  await wait(1000);
  console.log('view:', (await ev(`Array.from(document.querySelectorAll('.msg')).map(m=>m.className.replace('msg ','')+':'+m.innerText.replace(/\\n/g,' ').slice(0,26)).join(' // ')`)).slice(0,400));
  console.log(logs.join('\n') || 'none');
  ws.close();
})();
