#!/usr/bin/env node
'use strict';

const lib = require('./github-browser');

function parseArgs(argv) {
  const args = { template: 'blank', stop: false, wait: true };
  for (const arg of argv.slice(2)) {
    if (arg === '--stop') args.stop = true;
    else if (arg === '--no-wait') args.wait = false;
    else if (arg.startsWith('--template=')) args.template = arg.split('=')[1].toLowerCase();
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

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

async function main() {
  const args = parseArgs(process.argv);
  const context = await lib.launchGitHubBrowser();
  try {
    const page = await lib.ensureSignedIn(context);
    await page.goto('https://github.com/codespaces/templates', { waitUntil: 'domcontentloaded' });

    const templates = { blank: 'Start with a blank canvas' };
    const marker = templates[args.template];
    if (!marker) {
      throw new Error(`Unsupported template "${args.template}". Supported: ${Object.keys(templates).join(', ')}`);
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
    const subdomain = new URL(editor.url()).hostname.split('.')[0];
    if (!subdomain || !/\.github\.dev$/.test(new URL(editor.url()).hostname)) {
      throw new Error('Editor URL did not resolve to a *.github.dev codespace. Check the account limits.');
    }
    const slug = subdomain;

    let listed = false;
    if (args.wait) {
      listed = await waitForCodespaceListed(page, slug);
      if (!listed) throw new Error(`Timed out waiting for codespace ${slug} to appear in /codespaces`);
    }

    let stopped = null;
    if (args.stop && listed) {
      stopped = await lib.stopCodespace(page, slug);
    }

    console.log(JSON.stringify({
      ok: true,
      name: lib.displayNameFromSlug(slug),
      slug,
      url: `https://github.com/codespaces/${slug}`,
      editorUrl: editor.url(),
      machine: '2-core • 8GB RAM • 32GB',
      status: stopped ? 'stopped' : 'active',
    }, null, 2));
  } finally {
    await lib.closeBrowser(context);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
