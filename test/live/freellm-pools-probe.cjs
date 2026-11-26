'use strict';
// LIVE probe of FreeLLMAPI role pools: fast, longctx, vision.
// Reads the gateway token from ~/.autobot/freellm.json (never writes settings.json).

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const llm = require('../../electron/llm');
const router = require('../../electron/orch-router');

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}
function makeSolidPngBase64(w, h, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    row[0] = 0;
    for (let x = 0; x < w; x++) {
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]).toString('base64');
}

(async () => {
  const cfgPath = path.join(os.homedir(), '.autobot', 'freellm.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const BASE = process.env.FREELLM_BASE || `http://${cfg.host || '127.0.0.1'}:${cfg.port || 3001}/v1`;
  const KEY = process.env.FREELLM_KEY || cfg.token;
  if (!KEY) {
    console.error('Missing token in ~/.autobot/freellm.json');
    process.exit(1);
  }

  const baseProvider = { baseURL: BASE, apiKey: KEY, model: 'qwen3.8-flash', supportsTools: true, maxTokens: 2048, temperature: 0.2 };
  const orch = { enabled: false, providers: [], activeIndex: 0, pools: router.freellmPreset(BASE) };

  async function runProbe(role, messages, validate) {
    const scoped = router.orchestratorFor(orch, role, baseProvider);
    const failovers = [];
    let served = scoped.providers[0] && scoped.providers[0].model;
    const t0 = Date.now();
    console.log(`\n=== Probe role=${role} (start=${served}, chain=${scoped.providers.map((p) => p.model).join(' -> ')}) ===`);
    try {
      const out = await llm.runAgent({
        provider: scoped.providers[0],
        orchestrator: scoped,
        messages,
        maxSteps: 2,
        toolProfile: 'lean',
        useMemory: false,
        approveTool: async () => true,
        emit: (e) => {
          if (e.type === 'orchestrator') {
            failovers.push(`${e.from} -> ${e.to}: ${String(e.reason || '').slice(0, 100)}`);
            served = e.to;
            console.log(`  failover: ${e.from} -> ${e.to} (${String(e.reason || '').slice(0, 90)})`);
          }
        },
      });
      const last = [...out].reverse().find((m) => m.role === 'assistant' && m.content);
      const reply = last ? String(last.content) : '';
      const pass = validate(reply);
      console.log(`  served=${served} ms=${Date.now() - t0} failovers=${failovers.length} pass=${pass}`);
      console.log(`  reply: ${reply.replace(/\s+/g, ' ').slice(0, 220)}`);
      return { role, pass, served, ms: Date.now() - t0, failovers, reply: reply.slice(0, 240) };
    } catch (err) {
      console.log(`  ERROR (${Date.now() - t0}ms): ${err.message}`);
      return { role, pass: false, served, ms: Date.now() - t0, failovers, error: err.message };
    }
  }

  const results = [];

  // 1. fast pool
  results.push(await runProbe('fast', [
    { role: 'user', content: 'Classify this task in one line containing only valid JSON with keys "category" and "urgency": "Fix crashing database pool in server.js"' },
  ], (r) => r.includes('{') && r.toLowerCase().includes('category')));

  // 2. longctx pool (~32 KB noise + needle)
  const chunk = 'LOG 2026-11-26 INFO worker=3 status=ok processed_items=42 latency_ms=11 mem_mb=128\n';
  const pad = chunk.repeat(200);
  const longPrompt = `Read the logs below and output ONLY the exact token after NEEDLE= (nothing else).\n\n${pad}\nEVENT NEEDLE=AKRON-LONGCTX-7391\n${pad}`;
  results.push(await runProbe('longctx', [
    { role: 'user', content: longPrompt },
  ], (r) => r.includes('AKRON-LONGCTX-7391')));

  // 3. vision pool (real UI screenshot reading)
  const mcPath = '/Users/saimon/.gemini/antigravity/brain/cb4ff1d8-186c-4ca3-9b84-bfe96acbf3bc/mission-control.png';
  const imgB64 = fs.existsSync(mcPath)
    ? fs.readFileSync(mcPath).toString('base64')
    : makeSolidPngBase64(128, 128, 255, 0, 0);
  results.push(await runProbe('vision', [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read the exact panel title and role/pool names visible in this dark UI screenshot and summarize in 1-2 sentences.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imgB64}` } },
      ],
    },
  ], (r) => /mission control|swarm|akron|planner|coder/i.test(r)));

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));
  const okCount = results.filter((x) => x.pass).length;
  process.exit(okCount === results.length ? 0 : 1);
})();
