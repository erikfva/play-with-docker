#!/usr/bin/env node
'use strict';

const lib = require('./github-browser');

async function main() {
  const context = await lib.launchGitHubBrowser();
  try {
    const page = await lib.ensureSignedIn(context);
    const codespaces = await lib.listCodespaces(page);
    console.log(JSON.stringify({ ok: true, codespaces }, null, 2));
  } finally {
    await lib.closeBrowser(context);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
