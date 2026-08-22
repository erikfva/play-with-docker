#!/usr/bin/env node
'use strict';

const lib = require('./github-browser');

function parseArgs(argv) {
  const args = {};
  for (const arg of argv.slice(2)) {
    if (arg === '--force') args.force = true;
    else if (!args.target) args.target = arg;
    else {
      console.error(`Unexpected extra argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!args.target) {
    console.error('Usage: node scripts/delete-codespace.js <codespace-name-or-slug> [--force]');
    process.exit(2);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
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
