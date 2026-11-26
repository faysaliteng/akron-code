'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const http = require('node:http');

const fsWatcher = require('../electron/ide/fs-watcher');
const search = require('../electron/ide/search');
const git = require('../electron/git');
const lsp = require('../electron/ide/lsp');
const aiInline = require('../electron/ide/ai-inline');
const ptyMod = require('../electron/ide/pty');

async function testFsWatcher() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ide-fs-'));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.log\nsecret_dir\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'secret_dir'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ignored.log'), 'skip me', 'utf8');
  fs.writeFileSync(path.join(dir, 'secret_dir', 'x.txt'), 'skip', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log("hi");\n', 'utf8');

  const tree = fsWatcher.readTree(dir);
  assert(tree.ok, 'readTree ok');
  const names = tree.nodes.map((n) => n.name);
  assert(names.includes('src'), 'src included');
  assert(!names.includes('ignored.log'), '.gitignore file excluded');
  assert(!names.includes('secret_dir'), '.gitignore dir excluded');

  // CRUD
  const newFp = path.join(dir, 'src', 'utils.js');
  assert(fsWatcher.createEntry(newFp, 'file').ok);
  assert(fsWatcher.writeFile(newFp, 'export const x = 1;\n').ok);
  const rf = fsWatcher.readFile(newFp);
  assert(rf.ok && rf.language === 'javascript' && rf.content.includes('export const x = 1'));
  const dup = fsWatcher.duplicateEntry(newFp);
  assert(dup.ok && fs.existsSync(dup.path));
  const renPath = path.join(dir, 'src', 'utils-renamed.js');
  assert(fsWatcher.renameEntry(dup.path, renPath).ok && fs.existsSync(renPath));
  assert(fsWatcher.deleteEntry(renPath).ok && !fs.existsSync(renPath));

  // Watcher event
  let sawWatchEvt = false;
  const wres = fsWatcher.watchWorkspace(dir, (evts) => {
    if (Array.isArray(evts) && evts.length) sawWatchEvt = true;
  });
  assert(wres.ok);
  await new Promise((r) => setTimeout(r, 120));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log("updated");\n', 'utf8');
  const deadline = Date.now() + 1500;
  while (!sawWatchEvt && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
  }
  fsWatcher.unwatchWorkspace(dir);
  assert(sawWatchEvt, 'fs.watch callback should fire on edit');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ 2.1 fs-watcher (.gitignore, CRUD, watchWorkspace)');
}

async function testSearchAndReplace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ide-search-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'const alphaToken = 10;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.js'), 'const alphaToken = 20;\n', 'utf8');

  const r1 = await search.searchWorkspace({ cwd: dir, query: 'alphaToken' });
  assert(r1.ok && r1.matches.length === 2, `Expected 2 matches, got ${r1.matches.length}`);

  const rJs = await search.searchWorkspace({ cwd: dir, query: 'alphaToken', forceJs: true });
  assert(rJs.ok && rJs.engine === 'js' && rJs.matches.length === 2, 'JS search fallback works');

  const rep = await search.replaceInWorkspace({ cwd: dir, query: 'alphaToken', replacement: 'betaToken' });
  assert(rep.ok && rep.filesChanged === 2 && rep.replacements === 2);
  assert(fs.readFileSync(path.join(dir, 'a.js'), 'utf8').includes('betaToken'));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ 2.2 search (ripgrep, JS fallback, replaceInWorkspace)');
}

async function testGitOperations() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ide-git-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-b', 'main');
  g('config', 'user.email', 'test@akronlogic.com');
  g('config', 'user.name', 'Akron Test');
  fs.writeFileSync(path.join(dir, 'app.js'), 'line1\nline2\nline3\n', 'utf8');
  g('add', 'app.js');
  g('commit', '-m', 'init');

  fs.writeFileSync(path.join(dir, 'app.js'), 'line1\nline2_mod\nline3\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'new.js'), 'console.log(1);\n', 'utf8');

  const st1 = await git.gitStatusDetailed(dir);
  assert(st1.isRepo && st1.branch === 'main');
  assert.strictEqual(st1.unstaged.length, 1);
  assert.strictEqual(st1.untracked.length, 1);

  const headRes = await git.fileAtHead(dir, 'app.js');
  assert(headRes.ok && headRes.content.includes('line2\n'));

  await git.stageFiles(dir, ['app.js']);
  const st2 = await git.gitStatusDetailed(dir);
  assert.strictEqual(st2.staged.length, 1);

  await git.unstageFiles(dir, ['app.js']);
  const st3 = await git.gitStatusDetailed(dir);
  assert.strictEqual(st3.staged.length, 0);

  await git.stageFiles(dir, ['app.js']);
  const cRes = await git.commitChanges(dir, 'feat: modify app');
  assert(cRes.ok);

  const bRes = await git.checkoutBranch(dir, 'feature/ide', true);
  assert(bRes.ok && bRes.current === 'feature/ide');
  const bl = await git.listBranches(dir);
  assert(bl.branches.some((b) => b.name === 'main') && bl.branches.some((b) => b.name === 'feature/ide'));

  // Discard untracked file
  await git.discardFiles(dir, ['new.js']);
  assert(!fs.existsSync(path.join(dir, 'new.js')));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ 2.3 git (status, stage/unstage, commit, branches, discard, HEAD)');
}

async function testLspBridge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ide-lsp-'));
  const mockLspScript = `
    let buf = Buffer.alloc(0);
    process.stdin.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        const idx = buf.indexOf('\\r\\n\\r\\n');
        if (idx < 0) break;
        const hdr = buf.subarray(0, idx).toString();
        const m = /Content-Length:\\s*(\\d+)/i.exec(hdr);
        const len = m ? parseInt(m[1], 10) : 0;
        if (buf.length < idx + 4 + len) break;
        const msg = JSON.parse(buf.subarray(idx + 4, idx + 4 + len).toString());
        buf = buf.subarray(idx + 4 + len);
        const send = (o) => {
          const s = JSON.stringify(o);
          process.stdout.write('Content-Length: ' + Buffer.byteLength(s) + '\\r\\n\\r\\n' + s);
        };
        if (msg.method === 'initialize') {
          send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
          send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file://' + process.cwd() + '/foo.js', diagnostics: [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: 'mock err' }] } });
        }
      }
    });
  `;
  const scriptPath = path.join(dir, 'mock-lsp.js');
  fs.writeFileSync(scriptPath, mockLspScript, 'utf8');

  let receivedDiag = null;
  const res = await lsp.lspEnsure(dir, 'custom', (d) => { receivedDiag = d; }, {
    command: process.execPath,
    args: [scriptPath],
  });
  assert(res.ok && res.running, 'Mock LSP server started & initialized');
  await new Promise((r) => setTimeout(r, 120));
  assert(receivedDiag && receivedDiag.diagnostics[0].message === 'mock err', 'Received JSON-RPC publishDiagnostics');
  lsp.lspStopAll();

  const missing = await lsp.lspEnsure(dir, 'unknown-lang-xyz', () => {});
  assert(missing.ok && missing.available === false, 'Unknown language falls back cleanly');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ 2.4 lsp (JSON-RPC Content-Length framing & graceful fallback)');
}

async function testAiInlineAndCommitMsg() {
  let reqCount = 0;
  const srv = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    reqCount++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (reqCount === 1) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '```js\nconst y = 2;\n' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'export default y;\n```' }, finish_reason: 'stop' }] })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'return a + b;' }, finish_reason: 'stop' }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const prov = { baseURL: `http://127.0.0.1:${port}/v1`, model: 'mock', apiKey: 'k' };

  const deltas = [];
  const ed = await aiInline.runInlineEdit({
    provider: prov,
    filePath: 'a.js',
    language: 'javascript',
    selection: 'const x = 1;',
    instruction: 'Change to y=2 and export default',
    onDelta: (_d, full) => deltas.push(full),
  });
  assert(ed.ok && ed.text === 'const y = 2;\nexport default y;', `Unexpected fence stripping: ${JSON.stringify(ed.text)}`);
  assert(deltas.length >= 2);

  const c1 = await aiInline.runInlineComplete({ provider: prov, filePath: 'a.js', language: 'javascript', prefix: 'function sum(a, b) {\n  ', suffix: '\n}' });
  assert(c1.ok && !c1.cached && c1.insertText === 'return a + b;');
  const c2 = await aiInline.runInlineComplete({ provider: prov, filePath: 'a.js', language: 'javascript', prefix: 'function sum(a, b) {\n  ', suffix: '\n}' });
  assert(c2.ok && c2.cached && c2.insertText === 'return a + b;', 'Second identical completion should hit LRU cache');

  srv.close();
  console.log('✓ 2.5 ai-inline (Cmd+K streaming diff & cached ghost completion)');
}

async function testPtyInteractive() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ide-pty-'));
  let output = '';
  const created = ptyMod.createPty({ cwd: dir, cols: 90, rows: 24 }, {
    onData: (_id, data) => { output += data; },
  });
  assert(created.ok && created.id, 'PTY created');
  ptyMod.resizePty(created.id, 110, 30);
  ptyMod.writePty(created.id, 'echo AKRON_PTY_VERIFIED\r');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !output.includes('AKRON_PTY_VERIFIED')) {
    await new Promise((r) => setTimeout(r, 80));
  }
  ptyMod.killPty(created.id);
  fs.rmSync(dir, { recursive: true, force: true });
  assert(output.includes('AKRON_PTY_VERIFIED'), `PTY output did not echo marker (${created.backend}): ${output.slice(0, 200)}`);
  console.log(`✓ 2.6 pty interactive terminal (${created.backend})`);
}

(async () => {
  await testFsWatcher();
  await testSearchAndReplace();
  await testGitOperations();
  await testLspBridge();
  await testAiInlineAndCommitMsg();
  await testPtyInteractive();
  console.log('PHASE2_IDE_ALL_PASS');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
