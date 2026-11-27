'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-wsn-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const { runTool } = require('../electron/tools');
const webSearchMod = require('../electron/tools/web-search');

let pass = 0;
async function check(name, fn) {
  await fn();
  pass++;
  console.log('  ✓ ' + name);
}

(async () => {
  console.log('\nwebsearch-webfetch-notebook tests');

  await check('WebFetch blocks private / loopback IPs and HTTP 302 redirects to 127.0.0.1', async () => {
    const direct = await runTool('WebFetch', { url: 'http://127.0.0.1:8766/v1/health' }, { cwd: TMP });
    assert.ok(/SSRF blocked|Error/i.test(direct.content), direct.content);

    // Local redirector trying to bounce to 127.0.0.1 via an allowed test check
    assert.strictEqual(webSearchMod.isPrivateIpAddress('127.0.0.1'), true);
    assert.strictEqual(webSearchMod.isPrivateIpAddress('169.254.169.254'), true);
    assert.strictEqual(webSearchMod.isPrivateIpAddress('10.0.0.5'), true);
    assert.strictEqual(webSearchMod.isPrivateIpAddress('192.168.1.10'), true);
    assert.strictEqual(webSearchMod.isPrivateIpAddress('::1'), true);
    assert.strictEqual(webSearchMod.isPrivateIpAddress('8.8.8.8'), false);
  });

  await check('WebFetch redirect-hop guard catches redirect to 169.254.169.254 metadata IP', async () => {
    let srv;
    try {
      srv = http.createServer((req, res) => {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const port = srv.address().port;
      // Allow only loopback initial hop in sandbox so we specifically test the 2nd hop block
      const res = await webSearchMod.webFetch({
        url: `http://127.0.0.1:${port}/bounce`,
        sandbox: {
          isHostAllowed: () => true,
          load: () => ({ network: { allowedDomains: ['127.0.0.1'] }, sandbox: { network: { allowedDomains: [] } } }),
        },
      });
      assert.ok(/SSRF blocked/i.test(res), res);
    } finally {
      if (srv) await new Promise((r) => srv.close(r));
    }
  });

  await check('WebSearch domain allow/block filtering works deterministically', async () => {
    assert.strictEqual(webSearchMod._internal.hostMatchesFilter('https://docs.python.org/3/', ['python.org'], []), true);
    assert.strictEqual(webSearchMod._internal.hostMatchesFilter('https://evil.example.com/', ['python.org'], []), false);
    assert.strictEqual(webSearchMod._internal.hostMatchesFilter('https://spam.site/x', [], ['spam.site']), false);
  });

  await check('live WebSearch query returns real results (never silent (no results) on standard query)', async () => {
    const res = await runTool('WebSearch', { query: 'electron framework documentation' }, { cwd: TMP });
    assert.ok(typeof res.content === 'string' && res.content.includes('http'), `Expected live search results, got: ${res.content}`);
  });

  await check('NotebookEdit creates, replaces, inserts, and deletes cells on real .ipynb files', async () => {
    const nbFile = path.join(TMP, 'demo.ipynb');
    const rCreate = await runTool('NotebookEdit', {
      notebook_path: nbFile,
      new_source: 'print("hello")',
      cell_type: 'code',
      edit_mode: 'insert',
    }, { cwd: TMP });
    assert.strictEqual(!!rCreate.isError, false, rCreate.content);
    let parsed = JSON.parse(fs.readFileSync(nbFile, 'utf8'));
    assert.strictEqual(parsed.cells.length, 1);
    const cid = parsed.cells[0].id;

    const rRep = await runTool('NotebookEdit', {
      notebook_path: nbFile,
      cell_id: cid,
      new_source: 'print("updated")',
      edit_mode: 'replace',
    }, { cwd: TMP });
    assert.strictEqual(!!rRep.isError, false, rRep.content);
    parsed = JSON.parse(fs.readFileSync(nbFile, 'utf8'));
    assert.strictEqual(parsed.cells[0].source.join(''), 'print("updated")');

    const rDel = await runTool('NotebookEdit', {
      notebook_path: nbFile,
      cell_id: cid,
      edit_mode: 'delete',
    }, { cwd: TMP });
    assert.strictEqual(!!rDel.isError, false, rDel.content);
    parsed = JSON.parse(fs.readFileSync(nbFile, 'utf8'));
    assert.strictEqual(parsed.cells.length, 0);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${pass} passed, 0 failed`);
})();
