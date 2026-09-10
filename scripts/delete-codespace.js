#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./auth-browser');

function parseArgs(argv) {
  const args = { force: false, credentials: null };
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--force') args.force = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--credentials') {
      args.credentials = raw[++i];
    } else if (a.startsWith('--credentials=')) args.credentials = a.slice('--credentials='.length);
    else if (!args.target) args.target = a;
    else {
      console.error(`Unexpected extra argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/delete-codespace.js --credentials <github.json> <codespace-name-or-slug> [--force]

Options:
  --credentials <path>  Playwright storageState file for GitHub. Also honors GITHUB_AUTH_FILE env.
  --force               Stop an active codespace before deleting it.
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printUsage(); return; }

  if (!args.target) {
    console.error('Error: codespace name or slug is required.\n');
    printUsage();
    process.exit(2);
  }

  if (args.credentials) {
    const abs = path.resolve(args.credentials);
    if (!fs.existsSync(abs)) throw new Error(`Credential file not found: ${abs}`);
    process.env.GITHUB_AUTH_FILE = abs;
  }

  const context = await lib.launchGitHubBrowser();
  try {
    const page = await lib.ensureSignedIn(context);

    const match = await lib.findCodespace(page, args.target);
    const active = match.status === 'active' || match.status === 'running';

    if (active && !args.force) {
      console.error(
        `Codespace "${match.name}" (${match.slug}) is currently ${match.status}.\n` +
        'Pass --force to stop and delete it.'
      );
      process.exit(3);
    }

    if (active) {
      await lib.stopCodespace(page, match.slug);
      await page.goto('https://github.com/codespaces', { waitUntil: 'domcontentloaded' });
    }

    const result = await lib.deleteCodespace(page, match.slug);
    console.log(JSON.stringify({ ok: true, name: match.name, ...result }, null, 2));
  } finally {
    await lib.closeBrowser(context);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
