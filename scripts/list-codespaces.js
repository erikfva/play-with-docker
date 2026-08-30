#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./auth-browser');

function parseArgs(argv) {
  const args = { credentials: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--credentials') {
      const v = argv[++i];
      if (!v) throw new Error('--credentials requires a value');
      args.credentials = v;
    } else if (a.startsWith('--credentials=')) args.credentials = a.slice('--credentials='.length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/list-codespaces.js --credentials <github.json> [--json]

Options:
  --credentials <path>  Playwright storageState file for GitHub. Also honors GITHUB_AUTH_FILE env.
  --json                Output raw JSON only (default)
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printUsage(); return; }

  if (args.credentials) {
    const abs = path.resolve(args.credentials);
    if (!fs.existsSync(abs)) throw new Error(`Credential file not found: ${abs}`);
    process.env.GITHUB_AUTH_FILE = abs;
  }

  const context = await lib.launchGitHubBrowser();
  try {
    const page = await lib.ensureSignedIn(context);
    console.log('GitHub signed in, current URL:', page.url());
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
