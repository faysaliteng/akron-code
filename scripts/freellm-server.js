#!/usr/bin/env node
'use strict';
// Standalone entry point for FreeLLMAPI.
//
//   node scripts/freellm-server.js                 # uses ~/.autobot/freellm.json
//   FREELM_CONFIG=/path/to.json node scripts/...   # alternate config
//   FREELM_PORT=3002 node scripts/...              # alternate port
//
// The desktop app starts the same router in-process on boot, so this file is
// for running the endpoint without the GUI (scripts, editors, other clients).

const freellm = require('../electron/freellm');

const configPath = process.env.FREELM_CONFIG || freellm.CONFIG_FILE;

freellm.start({ configPath }).then((handle) => {
  const cfg = handle.config;
  const live = freellm.PROVIDER_IDS.filter((id) => freellm.isConfigured(id, cfg));
  console.log('FreeLLMAPI listening on ' + handle.url);
  console.log('  config:    ' + configPath + (cfg.exists ? '' : ' (missing — using defaults)'));
  console.log('  providers: ' + (live.length ? live.join(', ') : 'none configured'));
  if (!live.length) {
    console.log('  add keys to ' + configPath + ' to enable providers');
  }
  const stop = () => {
    handle.stop().then(() => process.exit(0)).catch(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}).catch((err) => {
  console.error('FreeLLMAPI failed to start: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
