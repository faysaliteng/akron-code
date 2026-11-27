#!/usr/bin/env node
'use strict';

require('../electron/cli/index.js')
  .main(process.argv.slice(2))
  .then((code) => process.exit(Number(code) || 0))
  .catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
