// Live verification: the <project_mindmap> block must be injected into the
// outgoing system message when a run has a cwd whose MINDMAP.md exists, and it
// must carry the project goal. This exercises the REAL runAgent injection path.
'use strict';
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { runAgent } = require('../../electron/llm');
const mindmap = require('../../electron/mindmap');

let captured = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    captured = JSON.parse(body || '{}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, index: 0, finish_reason: null }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Create a real project folder with a populated mindmap.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-mm-live-'));
  mindmap.updateFromRun(cwd, {
    title: 'Live Continuity Project',
    messages: [
      { role: 'user', content: 'Refactor the auth module' },
      { role: 'assistant', content: 'Done: extracted token validation.' },
    ],
  });

  await runAgent({
    provider: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: '', model: 'test', supportsTools: true },
    messages: [{ role: 'user', content: 'continue' }],
    cwd,
    emit: () => {},
    maxSteps: 2,
  });
  server.close();
  fs.rmSync(cwd, { recursive: true, force: true });

  const sys = (captured.messages || []).find((m) => m.role === 'system');
  const hasWorkspace = sys && /<project_workspace>/.test(sys.content);
  const hasMindmap = sys && /<project_mindmap>/.test(sys.content);
  const hasGoal = sys && sys.content.includes('Refactor the auth module');
  const hasTitle = sys && sys.content.includes('Live Continuity Project');

  console.log('system message present:', !!sys);
  console.log('<project_workspace> present:', hasWorkspace);
  console.log('<project_mindmap> present:', hasMindmap);
  console.log('goal in injected mindmap:', hasGoal);
  console.log('title in injected mindmap:', hasTitle);
  console.log('\n--- injected mindmap snippet ---');
  const m = sys && sys.content.match(/<project_mindmap>[\s\S]*?<\/project_mindmap>/);
  console.log(m ? m[0] : '(none)');

  const pass = hasWorkspace && hasMindmap && hasGoal && hasTitle;
  console.log('\nRESULT: ' + (pass ? 'PASS' : 'FAIL'));
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
