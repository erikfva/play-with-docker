#!/usr/bin/env node
'use strict';

/**
 * refresh-codespace.js
 *
 * Provides a fresh codespace VM in a single browser session:
 *   1. List current codespaces
 *   2. Delete the first one (stopping it first if active)
 *   3. Create a new codespace from the blank template
 *   4. Stop the new codespace
 *   5. Return the new VM information as JSON
 *
 * Doing everything in one browser session avoids launching Chrome
 * three times and keeps the operation atomic from the caller's view.
 */

const fs = require('fs');
const path = require('path');
const lib = require('./auth-browser');

function parseArgs(argv) {
  const args = { template: 'blank', credentials: null, keepExisting: false, noWaitStop: false };
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--credentials') {
      args.credentials = raw[++i];
    } else if (a.startsWith('--credentials=')) {
      args.credentials = a.slice('--credentials='.length);
    } else if (a.startsWith('--template=')) {
      args.template = a.split('=')[1].toLowerCase();
    } else if (a === '--keep-existing') {
      args.keepExisting = true;
    } else if (a === '--no-wait-stop') {
      args.noWaitStop = true;
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/refresh-codespace.js --credentials <github.json> [--template <name>] [--keep-existing] [--no-wait-stop]

Options:
  --credentials <path>   Playwright storageState file for GitHub. Also honors GITHUB_AUTH_FILE env.
  --template <name>      Template to use. Default: blank.
  --keep-existing        Skip deletion of existing codespaces; only create a new one.
  --no-wait-stop         Fire the stop action without waiting for GitHub status confirmation.
`);
}

/**
 * Wait for the codespace to appear in the /codespaces list.
 */
async function waitForCodespaceListed(page, slug, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.goto('https://github.com/codespaces', { waitUntil: 'domcontentloaded' });
    const link = page.locator(`main a[href="/codespaces/${slug}"]`);
    if (await link.count()) return true;
    await page.waitForTimeout(5000);
  }
  return false;
}

/**
 * Create a new codespace from a template and return its details.
 */
async function createCodespace(page, context, template) {
  await page.goto('https://github.com/codespaces/templates', { waitUntil: 'domcontentloaded' });

  const templates = { blank: 'Start with a blank canvas' };
  const marker = templates[template];
  if (!marker) {
    throw new Error(`Unsupported template "${template}". Supported: ${Object.keys(templates).join(', ')}`);
  }

  const item = page.getByRole('listitem').filter({ hasText: marker }).first();
  await item.waitFor({ timeout: 30000 });

  const editorPagePromise = context.waitForEvent('page');
  await item.getByRole('button', { name: 'Use this template' }).click();

  const editor = await editorPagePromise;
  await editor.waitForLoadState('domcontentloaded');
  const deadline = Date.now() + 60000;
  while (!/\.github\.dev\//.test(editor.url()) && Date.now() < deadline) {
    await editor.waitForTimeout(1000);
  }
  const hostname = new URL(editor.url()).hostname;
  if (!/\.github\.dev$/.test(hostname)) {
    throw new Error('Editor URL did not resolve to a *.github.dev codespace. Check the account limits.');
  }
  const slug = hostname.split('.')[0];

  const listed = await waitForCodespaceListed(page, slug);
  if (!listed) throw new Error(`Timed out waiting for codespace ${slug} to appear in /codespaces`);

  return { slug, editorUrl: editor.url() };
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

    // Step 1: List current codespaces
    const existing = await lib.listCodespaces(page);
    let deleted = null;

    // Step 2: Delete the first codespace (if any)
    if (!args.keepExisting && existing.length > 0) {
      const first = existing[0];
      const isActive = first.status === 'active' || first.status === 'running';

      if (isActive) {
        await lib.stopCodespace(page, first.slug);
        await page.goto('https://github.com/codespaces', { waitUntil: 'domcontentloaded' });
      }

      const result = await lib.deleteCodespace(page, first.slug);
      deleted = { name: first.name, slug: first.slug, ...result };
    }

    // Step 3: Create a new codespace
    const created = await createCodespace(page, context, args.template);

    // Step 4: Stop the new codespace
    await page.goto('https://github.com/codespaces', { waitUntil: 'domcontentloaded' });
    const stopped = await lib.stopCodespace(page, created.slug, { noWait: args.noWaitStop });

    // Step 5: Return the new VM information
    console.log(JSON.stringify({
      ok: true,
      deleted: deleted,
      name: lib.displayNameFromSlug(created.slug),
      slug: created.slug,
      url: `https://github.com/codespaces/${created.slug}`,
      editorUrl: created.editorUrl,
      machine: '2-core • 8GB RAM • 32GB',
      status: stopped.status,
    }, null, 2));
  } finally {
    await lib.closeBrowser(context);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
