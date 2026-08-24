#!/usr/bin/env node
'use strict';

try { require('dotenv').config(); } catch {}

const fs = require('fs');
const path = require('path');
const lib = require('./github-browser');

function parseArgs(argv) {
  const args = { workspace: null, json: false, headless: undefined };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--headless') args.headless = true;
    else if (a === '--headful') args.headless = false;
    else if (a === '--workspace' || a === '--team') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      args.workspace = v;
    } else if (a.startsWith('--workspace=')) args.workspace = a.slice('--workspace='.length);
    else if (a.startsWith('--team=')) args.workspace = a.slice('--team='.length);
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
  node scripts/get-codesandbox-credits.js --credentials <github-auth.json> [--workspace <ws_...>] [--json] [--headful]

Options:
  --credentials <path>  Playwright storageState file for GitHub (created by github auth). Also honors GITHUB_AUTH_FILE env.
  --workspace <id>      CodeSandbox workspace/team id (e.g. ws_Eha5JM84UeHdXshrooLDTA). If omitted, uses dashboard default.
  --json                Output raw JSON only
  --headful             Run with visible browser (HEADFUL=1)
  --headless            Force headless

Examples:
  node scripts/get-codesandbox-credits.js --credentials ./github-auth.json --json
  node scripts/get-codesandbox-credits.js --credentials ./github-auth.json --workspace ws_Eha5JM84UeHdXshrooLDTA --headful

Flow:
  1. Launch Playwright with GitHub session (via --credentials or GITHUB_PROFILE_DIR)
  2. Ensure GitHub signed in (re-login with TEST_GH_USER/TEST_GH_PASS if needed)
  3. Navigate to https://codesandbox.io/dashboard (OAuth via GitHub if needed)
  4. Extract "Virtual machine credits" → included / used / period
`);
}

async function waitForCloudflare(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => '');
    const body = await page.locator('body').innerText().catch(() => '');
    const url = page.url();
    const isChallenge = /just a moment|perfor.*security verification|cdn-cgi\/challenge|challenges\.cloudflare/i.test(title + ' ' + body + ' ' + url);
    if (!isChallenge) return true;
    console.log('Cloudflare challenge detected, waiting 5s... title:', title.slice(0, 60));
    await page.waitForTimeout(5000);
    // Try to click any "Verify" button if present (Turnstile)
    try {
      const verifyBtn = page.locator('input[type="button"], button').filter({ hasText: /verify|continue|proceed/i }).first();
      if (await verifyBtn.count() && await verifyBtn.isVisible().catch(() => false)) {
        await verifyBtn.click().catch(() => {});
      }
    } catch {}
  }
  return false;
}

async function ensureCodeSandboxSignedIn(page, context) {
  // Hide automation flag for Cloudflare
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      // @ts-ignore
      window.chrome = window.chrome || { runtime: {} };
    });
  } catch {}

  // Go to codesandbox dashboard. If not authenticated, it redirects to /signin.
  await page.goto('https://codesandbox.io/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  await waitForCloudflare(page, 45000);

  let url = page.url();
  // Handle Cloudflare interstitial (fallback)
  if (/cdn-cgi\/challenge|just a moment/i.test(await page.title().catch(() => '')) || url.includes('challenges.cloudflare.com')) {
    console.log('Waiting for Cloudflare challenge to pass (retry)...');
    await waitForCloudflare(page, 30000);
    url = page.url();
  }

  // If already on dashboard, check for sign-in prompt
  const needsSignIn = /\/signin/i.test(url) || await page.locator('text=Sign in').first().count().then(c => c > 0).catch(() => false);
  if (!needsSignIn && url.includes('codesandbox.io/dashboard')) {
    // Might already be signed in; check for dashboard content or user avatar
    const hasDashboard = await page.locator('text=Virtual machine credits, text=Included credits, text=Credits used').first().count().then(c => c > 0).catch(() => false);
    if (hasDashboard) return;
    // Still check for sign-in button visible
    const signInBtn = page.locator('a[href*="signin"], button:has-text("Sign in"), a:has-text("Continue with GitHub")').first();
    if (await signInBtn.count().then(c => c > 0).catch(() => false)) {
      // fallthrough to sign in
    } else {
      return;
    }
  }

  // Need to sign in via GitHub OAuth
  console.log('CodeSandbox not signed in, initiating GitHub OAuth...');

  // Look for GitHub sign-in button on codesandbox signin page
  const githubBtnSelectors = [
    'a[href*="github"]',
    'button:has-text("GitHub")',
    'button:has-text("Continue with GitHub")',
    'a:has-text("Continue with GitHub")',
    '[data-testid*="github"]',
    'button:has-text("Sign in with GitHub")',
  ];

  let clicked = false;
  for (const sel of githubBtnSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        const isVisible = await btn.isVisible().catch(() => false);
        if (isVisible) {
          await btn.click();
          clicked = true;
          break;
        }
      }
    } catch {}
  }

  if (!clicked) {
    // Directly try OAuth authorize URL - codesandbox uses https://codesandbox.io/auth/github
    console.log('GitHub button not found, trying direct OAuth URLs...');
    const oauthUrls = [
      'https://codesandbox.io/auth/github',
      'https://codesandbox.io/signin',
      'https://codesandbox.io/api/auth/github',
    ];
    for (const u of oauthUrls) {
      try {
        await page.goto(u, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        if (page.url().includes('github.com/login/oauth/authorize')) {
          clicked = true;
          break;
        }
        // Check if now signed in
        if (page.url().includes('codesandbox.io/dashboard')) {
          return;
        }
      } catch {}
    }
  }

  // If now on GitHub OAuth authorize page, click Authorize
  await page.waitForTimeout(3000);
  url = page.url();
  if (url.includes('github.com/login/oauth/authorize') || url.includes('github.com/login') ) {
    console.log('On GitHub OAuth page:', url);
    // GitHub will show "Authorize codesandbox" button if already signed in
    const authorizeBtn = page.locator('button:has-text("Authorize"), button:has-text("Authorize codesandbox"), input[value*="Authorize"]').first();
    try {
      if (await authorizeBtn.count() && await authorizeBtn.isVisible().catch(() => false)) {
        await authorizeBtn.click();
        await page.waitForLoadState('domcontentloaded');
      }
    } catch {}
    // Handle 2FA / device verification if needed
    await page.waitForTimeout(3000);
  }

  // Wait to redirect back to codesandbox
  await page.waitForTimeout(4000);
  let attempts = 0;
  while (attempts < 10 && !page.url().includes('codesandbox.io/dashboard')) {
    await page.waitForTimeout(2000);
    url = page.url();
    if (url.includes('codesandbox.io')) break;
    attempts++;
  }

  // Final check
  if (!page.url().includes('codesandbox.io')) {
    console.log('Current URL after OAuth:', page.url());
    await page.goto('https://codesandbox.io/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
  }

  // Verify signed in by checking for dashboard content
  const title = await page.title().catch(() => '');
  console.log('After CodeSandbox sign-in, URL:', page.url(), 'Title:', title);
}

async function extractCredits(page) {
  // Capture API responses that might contain credits json
  const apiCandidates = [];
  const responseHandler = async (response) => {
    const url = response.url();
    if (/billing|credits|usage|subscription|team|workspace/i.test(url) && response.request().method() === 'GET') {
      try {
        const json = await response.json().catch(() => null);
        if (json) {
          const text = JSON.stringify(json).slice(0, 500);
          if (/credit|billing|usage|subscription/i.test(text)) {
            apiCandidates.push({ url, json });
          }
        }
      } catch {}
    }
  };
  page.on('response', responseHandler);

  // Navigate to dashboard with optional workspace param
  // Workspace id comes from meta/info team field, e.g. ws_Eha5JM84UeHdXshrooLDTA
  // Dashboard URL pattern: https://codesandbox.io/dashboard?workspace=ws_xxx or /p/dashboard
  // Try multiple URLs to find credits
  const workspace = process.env.CODESANDBOX_WORKSPACE || null;
  const urlsToTry = [];
  if (workspace) urlsToTry.push(`https://codesandbox.io/dashboard?workspace=${workspace}`);
  // Also try the workspace id from meta if we can get it via API, but for now just dashboard
  urlsToTry.push('https://codesandbox.io/dashboard');
  urlsToTry.push('https://codesandbox.io/p/dashboard');
  urlsToTry.push('https://codesandbox.io/dashboard/billing');

  let lastUrl = null;
  for (const u of urlsToTry) {
    try {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await waitForCloudflare(page, 30000);
      await page.waitForTimeout(3000);
      lastUrl = u;
      // Check if credits text appears (either "Credits used" or "X / Y credits")
      const hasCredits = await page.locator('text=Credits used, text=Included credits, text=Virtual machine credits, text=/\\d+\\s*\\/\\s*\\d+\\s*credits/').first().count().then(c => c > 0).catch(() => false);
      if (hasCredits) break;
    } catch (e) {
      console.log(`Failed to load ${u}: ${e.message}`);
    }
  }

  // Try clicking "View usage" to get detailed billing page (contains period + breakdown)
  try {
    const viewUsage = page.locator('a:has-text("View usage"), button:has-text("View usage")').first();
    if (await viewUsage.count() && await viewUsage.isVisible().catch(() => false)) {
      console.log('Clicking View usage for detailed billing...');
      await viewUsage.click();
      await page.waitForLoadState('domcontentloaded');
      await waitForCloudflare(page, 15000);
      await page.waitForTimeout(5000);
      lastUrl = page.url();
    }
  } catch {}

  // Wait a bit for dynamic content
  await page.waitForTimeout(5000);
  await waitForCloudflare(page, 15000);

  // Try to wait for credits text
  try {
    await page.waitForSelector('text=Credits used', { timeout: 15000 });
  } catch {
    console.log('Credits used text not found within 15s, will try to parse whatever is visible');
  }

  // Debug dump if needed
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const html = await page.content().catch(() => '');

  // Extract via regex on body text
  // Examples:
  // "Virtual machine credits\n4 August – 4 September 2026\nView plan\nIncluded credits\n400\nCredits used\n275\n275 free credits used"
  // Also: "Included credits 400" , "Credits used 275"
  // Also: "400 / 400 credits" (sidebar on dashboard/recent when exhausted)
  // Also: "You have run out of credits on the Free plan."
  let billingPeriod = null;
  let includedCredits = null;
  let usedCredits = null;
  let freeCreditsUsed = null;
  let sandboxes = null;
  let vmsActive = null;

  // Billing period: e.g. 4 August – 4 September 2026 or Aug 4 - Sep 4, 2026
  const periodMatch = bodyText.match(/(\d{1,2}\s+[A-Za-z]+)\s*[–-]\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
  if (periodMatch) billingPeriod = periodMatch[0].trim();

  const includedMatch = bodyText.match(/Included credits\s*[:\n]*\s*(\d+)/i);
  if (includedMatch) includedCredits = parseInt(includedMatch[1], 10);

  const usedMatch = bodyText.match(/Credits used\s*[:\n]*\s*(\d+)/i);
  if (usedMatch) usedCredits = parseInt(usedMatch[1], 10);

  const freeUsedMatch = bodyText.match(/(\d+)\s*free credits used/i);
  if (freeUsedMatch) freeCreditsUsed = parseInt(freeUsedMatch[1], 10);

  // Sidebar format "400 / 400 credits" — often shows used / included or remaining / included
  if (includedCredits == null || usedCredits == null) {
    const slashMatch = bodyText.match(/(\d+)\s*\/\s*(\d+)\s*credits/i);
    if (slashMatch) {
      const first = parseInt(slashMatch[1], 10);
      const second = parseInt(slashMatch[2], 10);
      // Heuristic: second is usually the included/limit (400), first is used or remaining.
      // If page says "You have run out of credits", then first == second == used == included
      if (/run out of credits/i.test(bodyText) && first === second) {
        usedCredits = first;
        includedCredits = second;
      } else if (first <= second) {
        // Assume first is used (e.g. 275 / 400) — common for "View usage" sidebar
        // But could also be remaining / included — we need to disambiguate.
        // If body also contains "Credits used" nearby, trust that; otherwise assume used.
        if (usedCredits == null) usedCredits = first;
        if (includedCredits == null) includedCredits = second;
      } else {
        // Fallback
        if (usedCredits == null) usedCredits = first;
        if (includedCredits == null) includedCredits = second;
      }
    }
  }

  // Handle "You have run out of credits" explicit case
  if (/run out of credits/i.test(bodyText) && includedCredits != null && usedCredits == null) {
    usedCredits = includedCredits;
  }

  const sandboxesMatch = bodyText.match(/Sandboxes\s*(\d+)\s*\/\s*(\d+)\s*Sandboxes/i);
  if (sandboxesMatch) sandboxes = { used: parseInt(sandboxesMatch[1], 10), limit: parseInt(sandboxesMatch[2], 10) };

  const vmsMatch = bodyText.match(/VMs active[^0-9]*(\d+)/i);
  if (vmsMatch) vmsActive = parseInt(vmsMatch[1], 10);

  // Also try to extract from API candidates if we captured any
  let apiCredits = null;
  for (const cand of apiCandidates) {
    try {
      const j = cand.json;
      const search = JSON.stringify(j);
      if (/used.*credit|included.*credit/i.test(search)) {
        apiCredits = { url: cand.url, json: j };
        // Try to pull numbers from json
        const flat = JSON.stringify(j);
        const usedJson = flat.match(/"used[^"]*"\s*:\s*(\d+)/i);
        const includedJson = flat.match(/"included[^"]*"\s*:\s*(\d+)/i);
        if (usedJson && !usedCredits) usedCredits = parseInt(usedJson[1], 10);
        if (includedJson && !includedCredits) includedCredits = parseInt(includedJson[1], 10);
        break;
      }
    } catch {}
  }

  // Try alternative selectors if bodyText parsing failed
  if (includedCredits == null || usedCredits == null) {
    // Try locators
    try {
      const incEl = page.locator('text=Included credits').first();
      if (await incEl.count()) {
        const parentText = await incEl.locator('..').innerText().catch(() => '');
        const m = parentText.match(/Included credits\s*(\d+)/i);
        if (m) includedCredits = parseInt(m[1], 10);
        else {
          // sibling
          const sibling = await page.locator('text=Included credits').locator('xpath=following::*[1]').innerText().catch(() => '');
          const m2 = sibling.match(/(\d+)/);
          if (m2) includedCredits = parseInt(m2[1], 10);
        }
      }
    } catch {}
    try {
      const usedEl = page.locator('text=Credits used').first();
      if (await usedEl.count()) {
        const parentText = await usedEl.locator('..').innerText().catch(() => '');
        const m = parentText.match(/Credits used\s*(\d+)/i);
        if (m) usedCredits = parseInt(m[1], 10);
      }
    } catch {}
  }

  const remainingCredits = (includedCredits != null && usedCredits != null) ? Math.max(0, includedCredits - usedCredits) : null;

  const result = {
    ok: includedCredits != null || usedCredits != null,
    url: lastUrl || page.url(),
    billingPeriod,
    includedCredits,
    usedCredits,
    remainingCredits,
    freeCreditsUsed,
    sandboxes,
    vmsActive,
    apiCandidates: apiCandidates.slice(0, 3).map(c => ({ url: c.url, snippet: JSON.stringify(c.json).slice(0, 400) })),
    rawExcerpt: bodyText.slice(0, 2000),
  };

  // Save debug if requested
  if (process.env.DEBUG) {
    fs.writeFileSync('debug-codesandbox-credits.html', html);
    await page.screenshot({ path: 'debug-codesandbox-credits.png', fullPage: true }).catch(() => {});
    console.log('Debug saved: debug-codesandbox-credits.html, debug-codesandbox-credits.png');
  }

  page.off('response', responseHandler);
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return;
  }

  // Handle credentials file like other scripts: set GITHUB_AUTH_FILE env
  if (args.credentials) {
    const abs = path.resolve(args.credentials);
    if (!fs.existsSync(abs)) throw new Error(`Credential file not found: ${abs}`);
    process.env.GITHUB_AUTH_FILE = abs;
  }
  if (args.workspace) process.env.CODESANDBOX_WORKSPACE = args.workspace;
  if (args.headless !== undefined) process.env.HEADFUL = args.headless ? '0' : '1';

  const context = await lib.launchGitHubBrowser({ headless: args.headless });
  try {
    const page = await lib.ensureSignedIn(context);
    console.log('GitHub signed in, current URL:', page.url());

    await ensureCodeSandboxSignedIn(page, context);

    const credits = await extractCredits(page);

    const output = {
      ok: credits.ok,
      workspace: args.workspace || process.env.CODESANDBOX_WORKSPACE || null,
      team: null,
      ...credits,
      fetchedAt: new Date().toISOString(),
    };

    // Try to get team id from page or via API token for the workspace shown
    try {
      // 1. Try to extract ws_ id from page URL or content
      const pageUrl = page.url();
      const wsFromUrl = pageUrl.match(/ws_[A-Za-z0-9]+/);
      if (wsFromUrl) output.team = wsFromUrl[0];
      if (!output.team) {
        const bodyHtml = await page.content().catch(() => '');
        const wsFromHtml = bodyHtml.match(/ws_[A-Za-z0-9]+/);
        if (wsFromHtml) output.team = wsFromHtml[0];
      }
      if (!output.team) {
        const localStorageTeam = await page.evaluate(() => {
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              const v = localStorage.getItem(k);
              if (v && v.includes('ws_')) {
                const m = v.match(/ws_[A-Za-z0-9]+/);
                if (m) return m[0];
              }
            }
          } catch {}
          return null;
        }).catch(() => null);
        if (localStorageTeam) output.team = localStorageTeam;
      }
      // 2. Fallback to token file only if still null and workspace matches etecnologysys
      if (!output.team) {
        const tokenPath = path.join(__dirname, '..', 'credentials', 'codesandbox', 'etecnologysys.json');
        if (fs.existsSync(tokenPath)) {
          const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
          if (tokenData.token) {
            const res = await fetch('https://api.codesandbox.io/meta/info', {
              headers: { Authorization: `Bearer ${tokenData.token}` }
            });
            const j = await res.json().catch(() => null);
            if (j?.auth?.team) output.team = j.auth.team;
          }
        }
      }
    } catch {}

    if (args.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log('\n=== CodeSandbox Credits ===');
      console.log(`URL: ${output.url}`);
      console.log(`Workspace: ${output.workspace || output.team || 'default'}`);
      console.log(`Billing period: ${output.billingPeriod || 'unknown'}`);
      console.log(`Included credits: ${output.includedCredits ?? 'unknown'}`);
      console.log(`Credits used: ${output.usedCredits ?? 'unknown'}`);
      console.log(`Remaining: ${output.remainingCredits ?? 'unknown'}`);
      if (output.freeCreditsUsed != null) console.log(`Free credits used: ${output.freeCreditsUsed}`);
      if (output.sandboxes) console.log(`Sandboxes: ${output.sandboxes.used} / ${output.sandboxes.limit}`);
      if (output.vmsActive != null) console.log(`VMs active: ${output.vmsActive}`);
      if (output.apiCandidates.length) console.log(`API candidates: ${output.apiCandidates.map(c => c.url).join(', ')}`);
      console.log(`\nRaw excerpt:\n${output.rawExcerpt.slice(0, 500)}`);
      console.log('\nJSON:');
      console.log(JSON.stringify(output, null, 2));
    }

    if (!credits.ok) {
      console.error('\nFailed to extract credits. Try --headful and DEBUG=1 for screenshot.');
      console.error('Page URL:', page.url());
      console.error('Title:', await page.title().catch(() => 'unknown'));
      process.exit(1);
    }
  } finally {
    await lib.closeBrowser(context);
  }
}

main().catch(err => {
  console.error(err.message || err);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
