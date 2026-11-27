'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const astChunker = require('../electron/ide/ast-chunker');
const codebaseIndex = require('../electron/ide/codebase-index');

test('Phase 1: ast-chunker extracts scopes cleanly across JS/TS, Python, Go, and Rust without string/comment brace pollution', () => {
  const jsSrc = `
import { helper } from './helper';
// Fake } brace in comment and "fake { brace } in string"
const s = "nested { } braces";
export class BillingEngine {
  calculateInvoiceTotal(items) {
    return helper(items);
  }
}
`;
  const jsParsed = astChunker.parseFile(jsSrc, 'billing.js');
  assert.ok(jsParsed.imports.includes('./helper'));
  assert.ok(jsParsed.symbols.some((s) => s.name === 'BillingEngine'));
  assert.ok(jsParsed.chunks.some((c) => c.symbol === 'calculateInvoiceTotal' && c.breadcrumb.includes('BillingEngine') && c.calls.includes('helper')));

  const pySrc = `
from math import fsum

class PortfolioRisk:
    def compute_sharpe_ratio(self, returns):
        # comment with def fake_fn():
        return fsum(returns)
`;
  const pyParsed = astChunker.parseFile(pySrc, 'risk.py');
  assert.ok(pyParsed.imports.includes('math'));
  assert.ok(pyParsed.chunks.some((c) => c.symbol === 'compute_sharpe_ratio' && c.breadcrumb.includes('PortfolioRisk')));

  const goSrc = `
package main
import "fmt"
func RenderInvoicePdf(id string) string {
  return fmt.Sprintf("inv-%s", id)
}
`;
  const goParsed = astChunker.parseFile(goSrc, 'render.go');
  assert.ok(goParsed.chunks.some((c) => c.symbol === 'RenderInvoicePdf'));

  const rsSrc = `
pub struct Ledger { pub balance: i64 }
impl Ledger {
  pub fn settle_batch(&self) -> i64 {
    return self.balance;
  }
}
`;
  const rsParsed = astChunker.parseFile(rsSrc, 'ledger.rs');
  assert.ok(rsParsed.chunks.some((c) => c.symbol === 'settle_batch'));
});

test('Phase 1: codebase-index v2 indexes >300KB files up to 1MB, caches dense embeddings by SHA256, and ranks exact hits with RRF', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-idx-v2-'));
  const wsDir = path.join(tmpDir, 'repo');
  const idxDir = path.join(tmpDir, 'idx');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(idxDir, { recursive: true });

  // Large file (> 320 KB, < 1 MB) previously skipped at 256 KB
  const filler = '// padded telemetry entry\n'.repeat(14000);
  fs.writeFileSync(path.join(wsDir, 'large_ledger.js'), `${filler}\nexport function reconcileLedgerMerkleRoot(batch) {\n  return batch.length * 42;\n}\n`);
  fs.writeFileSync(path.join(wsDir, 'noise.js'), 'export function unrelatedHelper() { return 1; }\n');

  let embedHits = 0;
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/embeddings') {
      embedHits++;
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        const data = inputs.map((txt, index) => {
          const vec = Array(32).fill(0);
          const isTarget = String(txt).includes('reconcileLedgerMerkleRoot');
          vec[isTarget ? 0 : 1] = 1;
          return { index, embedding: vec };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  try {
    const embedConfig = {
      enabled: true,
      baseURL: `http://127.0.0.1:${port}/v1`,
      model: 'test-embed-32',
      provider: 'openai',
    };

    const st1 = await codebaseIndex.indexWorkspace(wsDir, { indexDir: idxDir, embedConfig });
    assert.strictEqual(st1.ok, true);
    assert.strictEqual(st1.schemaVersion, 2);
    assert.strictEqual(st1.totalFiles, 2);
    assert.ok(embedHits >= 1);

    const hitsAtFirstRun = embedHits;
    const st2 = await codebaseIndex.indexWorkspace(wsDir, { indexDir: idxDir, embedConfig });
    assert.strictEqual(st2.ok, true);
    assert.strictEqual(st2.skippedUnchanged, 2);
    assert.strictEqual(embedHits, hitsAtFirstRun, 'unchanged files must not re-embed chunks');

    const sr = await codebaseIndex.searchCodebase(wsDir, 'reconcileLedgerMerkleRoot', { indexDir: idxDir, limit: 5, embedConfig });
    assert.strictEqual(sr.ok, true);
    assert.ok(sr.hits.length >= 1);
    assert.strictEqual(sr.hits[0].file, 'large_ledger.js');
    assert.strictEqual(sr.hits[0].symbol, 'reconcileLedgerMerkleRoot');
  } finally {
    srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
