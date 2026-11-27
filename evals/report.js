'use strict';
const fs = require('fs');
const path = require('path');

const { runSecurityEval } = require('./security/run');
const { runCodingEval } = require('./coding/run');
const { runBrowserEval } = require('./browser/run');

(async () => {
  const startedAt = Date.now();
  const root = path.resolve(__dirname, '..');
  const sec = await runSecurityEval();
  const coding = await runCodingEval();
  const browser = await runBrowserEval();

  const totalTasks = sec.total + coding.total + browser.total;
  const totalPassed = sec.passed + coding.passed + browser.passed;
  const summary = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    totalTasks,
    totalPassed,
    totalFailed: totalTasks - totalPassed,
    overallPassRatePct: Math.round((totalPassed / totalTasks) * 1000) / 10,
    durationMs: Date.now() - startedAt,
    suites: { security: sec, coding, browser },
  };

  fs.mkdirSync(path.join(root, 'evals', 'results'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'evals', 'results', 'latest.json'), JSON.stringify(summary, null, 2));

  const md = [
    '# Akron Code Reproducible Evaluation Benchmarks',
    '',
    `Generated: \`${summary.generatedAt}\` on \`${summary.platform}\` (Node \`${summary.nodeVersion}\`).`,
    '',
    'All metrics below are directly executed and measured locally by `npm run eval:all` (zero simulated scores).',
    '',
    '| Benchmark Suite | Tasks | Passed | Pass Rate | Key Measured Property | Duration |',
    '|---|---:|---:|---:|---|---:|',
    `| Security & WhisperBench Guard | ${sec.total} | ${sec.passed} | **${sec.passRatePct}%** | ${sec.unauthorizedToolCalls} unauthorized calls · ${sec.poisonedMemoriesAccepted} poisoned memories | ${sec.durationMs}ms |`,
    `| Coding Intelligence & Context 2.0 | ${coding.total} | ${coding.passed} | **${coding.passRatePct}%** | ApplyPatch, EditGuard rollback, CodebaseSearch, CodeMode, Spill & LoopGuard | ${coding.durationMs}ms |`,
    `| Akron Browser Bot 2.0 | ${browser.total} | ${browser.passed} | **${browser.passRatePct}%** | ${browser.avgAxCompressionRatioX}x compact AX reduction · 0-token healed replay · RFC 6238 Vault | ${browser.durationMs}ms |`,
    `| **Total** | **${summary.totalTasks}** | **${summary.totalPassed}** | **${summary.overallPassRatePct}%** | Deterministic reproducible suite | **${summary.durationMs}ms** |`,
    '',
    '## Reproduce Locally',
    '',
    '```bash',
    'npm run eval:security',
    'npm run eval:coding',
    'npm run eval:browser',
    'npm run eval:all',
    '```',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(root, 'docs', 'BENCHMARKS.md'), md);
  console.log(`EVAL_ALL: ${totalPassed}/${totalTasks} passed (${summary.overallPassRatePct}%) in ${summary.durationMs}ms`);
  if (summary.totalFailed > 0) process.exit(1);
})();
