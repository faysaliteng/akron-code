# Akron Code Reproducible Evaluation Benchmarks

Generated: `2026-11-27T19:28:48.184Z` on `darwin/arm64` (Node `v24.22.3`).

All metrics below are directly executed and measured locally by `npm run eval:all` (zero simulated scores).

| Benchmark Suite | Tasks | Passed | Pass Rate | Key Measured Property | Duration |
|---|---:|---:|---:|---|---:|
| Security & WhisperBench Guard | 32 | 32 | **100%** | 0 unauthorized calls · 0 poisoned memories | 14ms |
| Coding Intelligence & Context 2.0 | 22 | 22 | **100%** | ApplyPatch, EditGuard rollback, CodebaseSearch, CodeMode, Spill & LoopGuard | 104ms |
| Akron Browser Bot 2.0 | 16 | 16 | **100%** | 25x compact AX reduction · 0-token healed replay · RFC 6238 Vault | 22ms |
| **Total** | **70** | **70** | **100%** | Deterministic reproducible suite | **141ms** |

## Reproduce Locally

```bash
npm run eval:security
npm run eval:coding
npm run eval:browser
npm run eval:all
```
