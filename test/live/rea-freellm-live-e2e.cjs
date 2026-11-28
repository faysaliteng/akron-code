'use strict';
// Live FreeLLMAPI end-to-end test verifying:
//   1. Built-in REA (`rea` tool calling `analyze_javascript_application`) against `${path.join(os.homedir(), 'Akron Bot', 'sample-devpulse')}`
//   2. Parallel `Task` delegation & non-null synthesis
//   3. `Write` + live `checkpoint` event + `toolStream` progress + `Bash` verification
// Reads local ~/.autobot/freellm.json & ~/.autobot/orchestrator.json in-memory only.

const fs = require('fs');
const os = require('os');
const path = require('path');

const freellm = require('../../electron/freellm');
const { MCPClient } = require('../../electron/mcp');
const rea = require('../../electron/rea');
const llm = require('../../electron/llm');
const checkpoints = require('../../electron/checkpoints');

(async () => {
  const cfgPath = path.join(os.homedir(), '.autobot', 'freellm.json');
  const orchPath = path.join(os.homedir(), '.autobot', 'orchestrator.json');
  if (!fs.existsSync(cfgPath)) {
    console.error('Missing ~/.autobot/freellm.json');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const orch = fs.existsSync(orchPath) ? JSON.parse(fs.readFileSync(orchPath, 'utf8')) : { enabled: false, providers: [] };

  let startedRouter = null;
  const urlBase = `http://${cfg.host || '127.0.0.1'}:${cfg.port || 3001}/v1`;
  // Ensure FreeLLMAPI router is listening during this script
  try {
    const ping = await fetch(`${urlBase}/models`, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(1500) });
    if (!ping.ok) throw new Error('not up');
  } catch (_) {
    startedRouter = await freellm.start({ configPath: cfgPath });
  }

  const mcp = new MCPClient();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-rea-e2e-'));
  const convId = 'live-rea-' + Date.now();
  const sampleTarget = path.join(os.homedir(), 'Akron Bot', 'sample-devpulse');

  try {
    const conn = await rea.ensureConnected(mcp);
    console.log('REA connected:', conn.toolCount, 'tools');

    const extraTools = (mcp.servers.get('rea').fullTools || []).map((t) => ({
      name: `mcp__rea__${t.name}`,
      description: `[REA] ${t.description || ''}`,
      inputSchema: t.inputSchema,
    }));

    const provider = {
      baseURL: startedRouter ? `${startedRouter.url}` : urlBase,
      apiKey: cfg.token,
      model: 'qwen3.8-flash',
      supportsTools: true,
      maxTokens: 8192,
      temperature: 0.2,
    };

    const events = [];
    const targetFile = path.join(tmpDir, 'audit-report.json');
    const outMsgs = await llm.runAgent({
      provider,
      orchestrator: orch,
      cwd: tmpDir,
      convId,
      turnId: 'live-rea-turn-1',
      maxSteps: 14,
      swarm: true,
      mcpClient: mcp,
      extraTools,
      callMcpTool: (nm, args) => {
        const m = /^mcp__(\w+?)__(.+)$/.exec(nm);
        return m ? mcp.callTool(m[1], m[2], args) : `Unknown MCP tool: ${nm}`;
      },
      approveTool: async () => true,
      emit: (e) => {
        events.push(e);
        if (e.type === 'tool') console.log('  tool:', e.name, JSON.stringify(e.args || {}).slice(0, 100));
        if (e.type === 'toolStream' && e.bytes) process.stdout.write(`  [stream ${e.name}: ${e.bytes}B]\r`);
        if (e.type === 'checkpoint') console.log('\n  checkpoint:', e.id, e.path);
        if (e.type === 'orchestrator') console.log('\n  failover:', e.from, '->', e.to, e.reason);
      },
      messages: [{
        role: 'user',
        content: [
          `Complete these 3 steps cleanly:`,
          `1) Call the built-in \`rea\` tool with {"action":"call","tool":"analyze_javascript_application","arguments":{"target_path":${JSON.stringify(sampleTarget)}}} to inspect sample-devpulse.`,
          `2) Also delegate ONE \`Task\` sub-agent ({"description":"Count devpulse files","prompt":"Run Glob pattern '**/*' inside ${sampleTarget} and return the total file count and entry filename."}).`,
          `3) Write ${targetFile} using \`Write\` containing JSON {"ok":true,"analyzedTarget":${JSON.stringify(sampleTarget)},"hasEvidence":true}, then verify it exists and parses via \`Bash\` running \`node -e "const j=require('./audit-report.json'); if(!j.ok) process.exit(1); console.log('REA_E2E_JSON_OK')"\`.`,
        ].join('\n'),
      }],
    });

    const usedRea = events.some((e) => e.type === 'tool' && (e.name === 'rea' || String(e.name).startsWith('mcp__rea__')));
    const usedTask = events.some((e) => e.type === 'tool' && (e.name === 'Task' || e.name === 'Agent'));
    const taskResults = events.filter((e) => e.type === 'toolResult' && (e.name === 'Task' || e.name === 'Agent'));
    const cpEvents = events.filter((e) => e.type === 'checkpoint');
    const streamEvents = events.filter((e) => e.type === 'toolStream');
    const reportOk = fs.existsSync(targetFile) && JSON.parse(fs.readFileSync(targetFile, 'utf8')).ok === true;
    const diffs = checkpoints.computeTurnDiffs(convId, 'live-rea-turn-1', tmpDir);

    console.log('\nMETRICS:', JSON.stringify({
      usedRea,
      usedTask,
      taskResultNonNull: taskResults.every((r) => typeof r.result === 'string' && r.result.trim().length > 0),
      cpEvents: cpEvents.length,
      streamEvents: streamEvents.length,
      reportOk,
      diffs: diffs.length,
      finalMessages: outMsgs.length,
    }));

    if (!usedRea || !usedTask || !cpEvents.length || !reportOk) {
      throw new Error('Missing expected live E2E milestone(s)');
    }
    if (taskResults.some((r) => !r.result || !String(r.result).trim())) {
      throw new Error('Task returned empty/null result');
    }
    console.log('LIVE REA + TASK + STREAM + CHECKPOINT E2E: PASS');
  } finally {
    mcp.disconnectAll();
    if (startedRouter) try { await startedRouter.stop(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(path.join(os.homedir(), '.autobot', 'checkpoints', convId), { recursive: true, force: true }); } catch (_) {}
  }
})();
