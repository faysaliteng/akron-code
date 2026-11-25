// Live verification: the <project_workspace> block must be present in the
// outgoing system message for a run with a cwd, and must carry the resolved cwd.
'use strict';
const http = require('http');
const { runAgent } = require('../../electron/llm');

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
  const cwd = '/Users/saimon/Helio Bot/test-project';
  await runAgent({
    provider: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: '', model: 'test', supportsTools: true },
    messages: [{ role: 'user', content: 'write a file' }],
    cwd,
    emit: () => {},
    maxSteps: 2,
  });
  server.close();

  const sys = (captured.messages || []).find((m) => m.role === 'system');
  const hasBlock = sys && /<project_workspace>/.test(sys.content);
  const hasCwd = sys && sys.content.includes(cwd);
  const hasArtifact = sys && /Artifact tool/.test(sys.content) && /mcp__visualize__visualize/.test(sys.content);
  const hasArtifactDirective = sys && /CODING & VISUALIZATION/.test(sys.content);

  console.log('system message present:', !!sys);
  console.log('<project_workspace> block present:', hasBlock);
  console.log('resolved cwd in prompt:', hasCwd);
  console.log('Artifact/visualize guidance present:', hasArtifactDirective);
  console.log('Artifact + mcp__visualize__visualize referenced:', hasArtifact);
  console.log('\n--- injected snippet ---');
  const m = sys && sys.content.match(/<project_workspace>[\s\S]*?<\/project_workspace>/);
  console.log(m ? m[0] : '(none)');

  const pass = hasBlock && hasCwd && hasArtifactDirective;
  console.log('\nRESULT: ' + (pass ? 'PASS' : 'FAIL'));
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
