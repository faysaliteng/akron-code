#!/usr/bin/env node
'use strict';
const { createRemoteServer } = require('../electron/remote-server');

const port = Number(process.env.AKRON_REMOTE_PORT || 9477);
const host = process.env.AKRON_REMOTE_HOST || '127.0.0.1';
const token = process.env.AKRON_REMOTE_TOKEN || '';
const workspaceRoot = process.env.AKRON_REMOTE_ROOT || process.cwd();

(async () => {
  const srv = createRemoteServer({ port, host, token, workspaceRoot });
  const info = await srv.start();
  console.log(JSON.stringify({ ok: true, url: info.url, token: info.token, workspaceRoot }));
  const stop = async () => { await srv.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
