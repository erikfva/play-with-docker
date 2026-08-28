#!/usr/bin/env node
'use strict';

try { require('dotenv').config(); } catch {}

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { workspace: null, json: true, headless: false, apiOnly: false, googleCredentials: null, tokenFile: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--no-json') args.json = false;
    else if (a === '--json') args.json = true;
    else if (a === '--headless') args.headless = true;
    else if (a === '--headful') args.headless = false;
    else if (a === '--api-only') args.apiOnly = true;
    else if (a === '--token-file') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      args.tokenFile = v;
    } else if (a.startsWith('--token-file=')) args.tokenFile = a.slice('--token-file='.length);
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
    else if (a === '--google-credentials') {
      const v = argv[++i];
      if (!v) throw new Error('--google-credentials requires a value');
      args.googleCredentials = v;
    } else if (a.startsWith('--google-credentials=')) args.googleCredentials = a.slice('--google-credentials='.length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/get-codesandbox-credits.js [--api-only] [--credentials <github.json>] [--google-credentials <google.json>] [--workspace <ws_...>]

Defaults: --json, --headful (auto xvfb-run on headless VPS).

Options:
  --api-only                Use the CodeSandbox API (no browser required). Uses --token-file or CODESANDBOX_TOKEN env.
  --token-file <path>       CodeSandbox API token file (JSON with {token:...} or plain text). Used by --api-only.
  --credentials <path>      Playwright storageState file for GitHub (browser mode). Also honors GITHUB_AUTH_FILE env.
  --google-credentials <p>  Playwright storageState file for Google (browser mode). Also honors GOOGLE_AUTH_FILE env.
  --workspace <id>          CodeSandbox workspace/team id (e.g. ws_Eha5JM84UeHdXshrooLDTA). If omitted, uses API default.
  --no-json                 Output human-readable text instead of JSON
  --headless                Force headless (no xvfb-run)

Examples:
  node scripts/get-codesandbox-credits.js --api-only
  node scripts/get-codesandbox-credits.js --credentials /mnt/s3/github/vm-manager123/github.json
  node scripts/get-codesandbox-credits.js --google-credentials /mnt/s3/google/etecnologysys/google.json

Flow (--api-only, default):
  1. Load CodeSandbox API token from --token-file, CODESANDBOX_TOKEN env, or auto-discover from credentials/codesandbox/
  2. Call api.codesandbox.io/meta/info to validate token and get rate limits + team id
  3. Return available API data (rate limits, scopes, team). Dashboard credits are API-inaccessible.

Flow (browser mode, --credentials):
  1. Launch Playwright with GitHub session (via --credentials or GITHUB_PROFILE_DIR)
  2. Ensure GitHub signed in (re-login with TEST_GH_USER/TEST_GH_PASS if needed)
  3. Navigate to https://codesandbox.io/dashboard (OAuth via GitHub if needed)
  4. Extract "Virtual machine credits" → included / used / period

Flow (browser mode, --google-credentials):
  1. Launch Playwright with Google session (via --google-credentials or GOOGLE_AUTH_FILE)
  2. Navigate to https://codesandbox.io/dashboard (OAuth via Google if needed)
  3. Extract "Virtual machine credits" → included / used / period
`);
}

async function waitForCloudflare(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastTitle = '';
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => '');
    const body = await page.locator('body').innerText().catch(() => '').then(t => t.slice(0, 200));
    const url = page.url();
    const isChallenge = /just a moment|perfor.*security verification|cdn-cgi\/challenge|challenges\.cloudflare|attention required|checking if the site connection is secure/i.test(title + ' ' + body + ' ' + url);
    if (!isChallenge) return true;
    if (title !== lastTitle) console.log('Cloudflare challenge detected, waiting 5s... title:', title.slice(0, 80), 'url:', url.slice(0, 60));
    lastTitle = title;
    await page.waitForTimeout(5000);
    // Try to click any "Verify" button / Turnstile checkbox
    try {
      // Cloudflare Turnstile is often inside an iframe; check for it
      const frames = page.frames();
      for (const f of frames) {
        try {
          const cb = f.locator('input[type="checkbox"], div[role="checkbox"], iframe[src*="challenges.cloudflare"] ~ div, span:has-text("Verify")').first();
          if (await cb.count() && await cb.isVisible().catch(()=>false)) {
            console.log('Attempting to click Turnstile checkbox...');
            await cb.click({ force: true }).catch(()=>{});
          }
        } catch {}
      }
      const verifyBtn = page.locator('input[type="button"], button').filter({ hasText: /verify|continue|proceed/i }).first();
      if (await verifyBtn.count() && await verifyBtn.isVisible().catch(() => false)) {
        console.log('Clicking Verify/Continue button...');
        await verifyBtn.click({ force: true }).catch(() => {});
      }
      // Sometimes just waiting and letting CF JS solve is enough; trigger mouse move
      await page.mouse.move(400 + Math.random()*100, 300 + Math.random()*100).catch(()=>{});
    } catch {}
  }
  const finalTitle = await page.title().catch(()=> '');
  console.log(`Cloudflare challenge still present after ${timeoutMs}ms (title: ${finalTitle.slice(0,60)}). Giving up.`);
  return false;
}

async function ensureCodeSandboxSignedIn(page, context) {
  // Hide automation flag for Cloudflare – inject before any navigation
  try {
    // Use the stealth script from auth-browser if available
    const stealth = (() => {
      try { return require('./auth-browser').STEALTH_SCRIPT; } catch { return null; }
    })();
    if (stealth) await page.addInitScript(stealth);
    else await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = window.chrome || { runtime: {} };
    });
    // Also set a realistic UA at context level if possible
    await page.context().addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    }).catch(()=>{});
  } catch {}

  // Go to codesandbox dashboard. If not authenticated, it redirects to /signin.
  await page.goto('https://codesandbox.io/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const cfPassed = await waitForCloudflare(page, 45000);
  if (!cfPassed) {
    console.warn('Cloudflare challenge did not clear in 45s. Trying reload + retry...');
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{}); await page.waitForTimeout(5000); } catch {}
    await waitForCloudflare(page, 30000);
  }

  let url = page.url();
  // Handle Cloudflare interstitial (fallback)
  if (/cdn-cgi\/challenge|just a moment|attention required/i.test(await page.title().catch(() => '')) || url.includes('challenges.cloudflare.com')) {
    console.log('Waiting for Cloudflare challenge to pass (retry)...');
    const passed2 = await waitForCloudflare(page, 30000);
    if (!passed2) {
      const htmlSnippet = await page.content().catch(()=> '').then(h=> h.slice(0,500));
      console.error('Cloudflare still blocking. HTML snippet:', htmlSnippet.slice(0,200));
      console.error('TIP: This VPS IP may be flagged by Cloudflare. Try --api-only mode (no browser needed):');
      console.error('  node scripts/get-codesandbox-credits.js --api-only --token-file /mnt/s3/codesandbox/vm-manager1.json');
      console.error('Or run with DEBUG=1 for screenshot: DEBUG=1 node scripts/get-codesandbox-credits.js --credentials ...');
      throw new Error('Cloudflare challenge timeout – dashboard not reachable. Use --api-only as fallback.');
    }
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

async function ensureCodeSandboxSignedInViaGoogle(page) {
  // Hide automation flag for Cloudflare
  try {
    const stealth = (() => { try { return require('./auth-browser').STEALTH_SCRIPT; } catch { return null; }})();
    if (stealth) await page.addInitScript(stealth);
    else await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = window.chrome || { runtime: {} };
    });
  } catch {}

  // Go to codesandbox dashboard
  await page.goto('https://codesandbox.io/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const cfPassed = await waitForCloudflare(page, 45000);
  if (!cfPassed) {
    console.warn('Cloudflare challenge did not clear in 45s (Google flow). Trying reload...');
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{}); await page.waitForTimeout(5000); } catch {}
    await waitForCloudflare(page, 30000);
  }

  let url = page.url();

  // Handle Cloudflare interstitial
  if (/cdn-cgi\/challenge|just a moment|attention required/i.test(await page.title().catch(() => '')) || url.includes('challenges.cloudflare.com')) {
    console.log('Waiting for Cloudflare challenge to pass (retry)...');
    const passed2 = await waitForCloudflare(page, 30000);
    if (!passed2) {
      console.error('Cloudflare still blocking (Google flow). Try --api-only fallback.');
      throw new Error('Cloudflare challenge timeout – dashboard not reachable. Use --api-only as fallback.');
    }
    url = page.url();
  }

  // If already on dashboard with credits content, we're done
  const needsSignIn = /\/signin/i.test(url) || await page.locator('text=Sign in').first().count().then(c => c > 0).catch(() => false);
  if (!needsSignIn && url.includes('codesandbox.io/dashboard')) {
    const hasDashboard = await page.locator('text=Virtual machine credits, text=Included credits, text=Credits used').first().count().then(c => c > 0).catch(() => false);
    if (hasDashboard) return;
    // Check if sign-in button is visible
    const signInBtn = page.locator('a[href*="signin"], button:has-text("Sign in"), a:has-text("Continue with Google")').first();
    if (await signInBtn.count().then(c => c > 0).catch(() => false)) {
      // fallthrough to sign in
    } else {
      return;
    }
  }

  // Need to sign in via Google OAuth
  console.log('CodeSandbox not signed in, initiating Google OAuth...');

  // Look for Google sign-in button on codesandbox signin page
  const googleBtnSelectors = [
    'button:has-text("Continue with Google")',
    'a:has-text("Continue with Google")',
    'button:has-text("Sign in with Google")',
    'a:has-text("Sign in with Google")',
    'a[href*="google"]',
    '[data-testid*="google"]',
  ];

  let clicked = false;
  for (const sel of googleBtnSelectors) {
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
    // Try direct OAuth URLs
    console.log('Google button not found, trying direct OAuth URLs...');
    const oauthUrls = [
      'https://codesandbox.io/auth/google',
      'https://codesandbox.io/api/auth/google',
    ];
    for (const u of oauthUrls) {
      try {
        await page.goto(u, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        if (page.url().includes('accounts.google.com')) {
          clicked = true;
          break;
        }
        if (page.url().includes('codesandbox.io/dashboard')) {
          return;
        }
      } catch {}
    }
  }

  // If now on Google accounts page, select the account
  await page.waitForTimeout(3000);
  url = page.url();
  if (url.includes('accounts.google.com')) {
    console.log('On Google accounts page:', url.slice(0, 80));
    // Google shows an account chooser or auto-signs in with the session cookies
    // If account chooser appears, click the first account
    try {
      const accountBtn = page.locator('[data-email], li[role="link"], div[data-identifier]').first();
      if (await accountBtn.count() && await accountBtn.isVisible().catch(() => false)) {
        console.log('Clicking Google account...');
        await accountBtn.click();
      }
    } catch {}

    // Wait for redirect back to codesandbox
    let attempts = 0;
    while (attempts < 15 && !page.url().includes('codesandbox.io')) {
      await page.waitForTimeout(2000);
      attempts++;
    }
  }

  // Wait for CodeSandbox to settle
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
    console.log('Current URL after Google OAuth:', page.url());
    await page.goto('https://codesandbox.io/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
  }

  const title = await page.title().catch(() => '');
  console.log('After Google sign-in, URL:', page.url(), 'Title:', title);
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

// ---------------------------------------------------------------------------
// API-only path (no browser required)
// ---------------------------------------------------------------------------

function discoverCodeSandboxTokenFile() {
  const credDir = path.resolve(__dirname, '..', 'credentials', 'codesandbox');
  if (!fs.existsSync(credDir)) return null;
  const files = fs.readdirSync(credDir).filter(f => f.endsWith('.json'));
  // Prefer well-known names, then first available
  const preferred = ['etecnologysys.json', 'vm-manager1.json', 'vmmanager1.json'];
  for (const name of preferred) {
    if (files.includes(name)) return path.join(credDir, name);
  }
  return files.length ? path.join(credDir, files[0]) : null;
}

function loadCodeSandboxToken(tokenFilePath) {
  // 1. Explicit --token-file
  if (tokenFilePath) {
    const abs = path.resolve(tokenFilePath);
    if (!fs.existsSync(abs)) throw new Error(`Token file not found: ${abs}`);
    return parseTokenFile(abs);
  }
  // 2. CODESANDBOX_TOKEN env (raw token string)
  if (process.env.CODESANDBOX_TOKEN) return process.env.CODESANDBOX_TOKEN.trim();
  // 3. CODESANDBOX_TOKEN_FILE env
  if (process.env.CODESANDBOX_TOKEN_FILE && fs.existsSync(process.env.CODESANDBOX_TOKEN_FILE)) {
    return parseTokenFile(process.env.CODESANDBOX_TOKEN_FILE);
  }
  // 4. Auto-discover from credentials/codesandbox/
  const discovered = discoverCodeSandboxTokenFile();
  if (discovered) return parseTokenFile(discovered);
  throw new Error(
    'No CodeSandbox API token found. Supply one via:\n' +
    '  --token-file <path>\n' +
    '  CODESANDBOX_TOKEN=csb_v1_...\n' +
    '  CODESANDBOX_TOKEN_FILE=<path>\n' +
    'or place a .json file in credentials/codesandbox/'
  );
}

function parseTokenFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.token === 'string') return obj.token.trim();
    // Some files embed the token as a plain JSON string
    if (typeof obj === 'string') return obj.trim();
  } catch {
    // Plain text token file
  }
  return raw;
}

async function fetchCreditsViaApi({ tokenFilePath, workspace, json }) {
  const token = loadCodeSandboxToken(tokenFilePath);

  // 1. Validate token + get metadata
  const metaRes = await fetch('https://api.codesandbox.io/meta/info', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!metaRes.ok) {
    const body = await metaRes.text().catch(() => '');
    throw new Error(`CodeSandbox API returned ${metaRes.status}: ${body.slice(0, 200)}`);
  }
  const meta = await metaRes.json();
  const teamId = workspace || meta.auth?.team || null;

  const rl = meta.rate_limits || {};
  const hourly = rl.sandboxes_hourly || {};
  const concurrent = rl.concurrent_vms || {};

  // 2. Try additional endpoints that may expose credits (best-effort, all may 404)
  let creditUsage = null;
  let creditLimit = null;
  let creditRemaining = null;
  let billingPeriod = null;

  if (teamId) {
    for (const ep of [
      `https://api.codesandbox.io/v1/teams/${teamId}/credits`,
      `https://api.codesandbox.io/v1/teams/${teamId}/billing`,
      `https://api.codesandbox.io/v1/teams/${teamId}/usage`,
    ]) {
      try {
        const r = await fetch(ep, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        if (r.ok) {
          const j = await r.json().catch(() => null);
          if (j) {
            // Try to extract credit numbers from whatever shape the response has
            const flat = JSON.stringify(j);
            const usedM = flat.match(/"(?:used|consumed|spent)[^"]*"\s*:\s*(\d+)/i);
            const limitM = flat.match(/"(?:limit|included|total|quota)[^"]*"\s*:\s*(\d+)/i);
            if (usedM) creditUsage = parseInt(usedM[1], 10);
            if (limitM) creditLimit = parseInt(limitM[1], 10);
            break; // Got a response, stop probing
          }
        }
      } catch {}
    }
  }

  if (creditUsage != null && creditLimit != null) {
    creditRemaining = Math.max(0, creditLimit - creditUsage);
  }

  const output = {
    ok: true,
    mode: 'api',
    workspace: teamId,
    team: teamId,
    billingPeriod,
    includedCredits: creditLimit,
    usedCredits: creditUsage,
    remainingCredits: creditRemaining,
    freeCreditsUsed: null,
    sandboxes: null,
    vmsActive: null,
    apiCandidates: [],
    rawExcerpt: JSON.stringify(meta, null, 2),
    rateLimits: {
      hourly: { limit: hourly.limit ?? null, remaining: hourly.remaining ?? null },
      concurrent: { limit: concurrent.limit ?? null, remaining: concurrent.remaining ?? null },
    },
    authScopes: meta.auth?.scopes ?? [],
    fetchedAt: new Date().toISOString(),
  };

  if (creditUsage == null && creditLimit == null) {
    // API doesn't expose credits — report what we have and suggest dashboard
    output.ok = true; // token is valid even if credits aren't API-accessible
    output._note =
      'Dashboard credits are not exposed by the CodeSandbox API. ' +
      'Rate limits and token validity are confirmed above. ' +
      'Check https://codesandbox.io/t/usage' + (teamId ? '?workspace=' + teamId : '') + ' for credit usage.';
  }

  return output;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return;
  }

  // On a headless VPS (no $DISPLAY), re-exec under xvfb-run for browser mode.
  // Headed Chromium via xvfb-run passes Cloudflare challenges that block headless.
  const hasGithubCreds = !!(args.credentials || process.env.GITHUB_AUTH_FILE || process.env.GITHUB_PROFILE_DIR);
  const hasGoogleCreds = !!(args.googleCredentials || process.env.GOOGLE_AUTH_FILE);
  const needsBrowser = args.apiOnly !== true && (hasGithubCreds || hasGoogleCreds);
  if (needsBrowser && !process.env.DISPLAY && !process.env._XVFB_REEXEC) {
    const xvfb = '/usr/bin/xvfb-run';
    if (fs.existsSync(xvfb)) {
      console.log('No $DISPLAY — re-executing under xvfb-run for Cloudflare compatibility...');
      const { execFileSync } = require('child_process');
      try {
        execFileSync(xvfb, [
          '-a', '--server-args=-screen 0 1366x850x24',
          process.execPath, process.argv[1], ...process.argv.slice(2),
        ], { stdio: 'inherit', env: { ...process.env, _XVFB_REEXEC: '1' } });
        return;
      } catch (e) {
        if (e.status != null) process.exit(e.status);
        throw e;
      }
    }
    // xvfb-run not available — fall through with headless (may fail on Cloudflare)
    console.warn('Warning: no $DISPLAY and xvfb-run not found. Cloudflare challenges may block headless.');
    args.headless = true;
  } else if (needsBrowser && !process.env.DISPLAY) {
    // Already re-executed under xvfb-run, force headed for Cloudflare
    args.headless = false;
  }

  // Handle credentials files: set env vars for browser launcher
  if (args.credentials) {
    const abs = path.resolve(args.credentials);
    if (!fs.existsSync(abs)) throw new Error(`Credential file not found: ${abs}`);
    process.env.GITHUB_AUTH_FILE = abs;
  }
  if (args.googleCredentials) {
    const abs = path.resolve(args.googleCredentials);
    if (!fs.existsSync(abs)) throw new Error(`Google credential file not found: ${abs}`);
    process.env.GOOGLE_AUTH_FILE = abs;
  }
  if (args.workspace) process.env.CODESANDBOX_WORKSPACE = args.workspace;
  if (args.headless !== undefined) process.env.HEADFUL = args.headless ? '0' : '1';

  // API-only path — no browser required
  if (args.apiOnly || (!hasGithubCreds && !hasGoogleCreds)) {
    try {
      const output = await fetchCreditsViaApi({
        tokenFilePath: args.tokenFile,
        workspace: args.workspace,
        json: args.json,
      });
      if (args.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log('\n=== CodeSandbox Credits (API) ===');
        console.log(`Workspace: ${output.workspace || 'default'}`);
        if (output._note) console.log(`Note: ${output._note}`);
        console.log(`Included credits: ${output.includedCredits ?? 'N/A via API'}`);
        console.log(`Credits used: ${output.usedCredits ?? 'N/A via API'}`);
        console.log(`Remaining: ${output.remainingCredits ?? 'N/A via API'}`);
        console.log(`Rate limits: ${JSON.stringify(output.rateLimits)}`);
        console.log(`Auth scopes: ${output.authScopes.join(', ')}`);
      }
      return;
    } catch (err) {
      if (args.apiOnly) {
        console.error(`API-only mode failed: ${err.message}`);
        process.exit(1);
      }
      // If auto-detect chose API but it failed, and credentials were supplied, fall through to browser
      if (!hasGithubCreds && !hasGoogleCreds) {
        console.error(`API-only mode failed: ${err.message}`);
        console.error('No browser credentials available (--credentials / --google-credentials). Cannot fall back to browser mode.');
        process.exit(1);
      }
      console.error(`API fetch failed (${err.message}), falling back to browser mode...`);
    }
  }

  // Browser path (requires Playwright + browser)
  const lib = require('./auth-browser');
  let context;
  let page;

  if (hasGoogleCreds) {
    // Google credentials: launch browser with Google storageState
    const googleFile = process.env.GOOGLE_AUTH_FILE;
    console.log(`Loading Google credentials from ${googleFile}...`);
    context = await lib.launchBrowserWithStorageState(googleFile, { headless: args.headless });
    page = await context.pages()[0] || await context.newPage();
    console.log('Google credentials loaded, navigating to CodeSandbox...');
    await ensureCodeSandboxSignedInViaGoogle(page);
  } else {
    // GitHub credentials: standard flow
    context = await lib.launchGitHubBrowser({ headless: args.headless });
    page = await lib.ensureSignedIn(context);
    console.log('GitHub signed in, current URL:', page.url());
    await ensureCodeSandboxSignedIn(page, context);
  }

  try {

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
      // Detect if we're stuck on CodeSandbox sign-in (OAuth not authorized)
      const currentUrl = page.url();
      const isSignInPage = /\/signin|\/login/i.test(currentUrl);
      output._note = isSignInPage
        ? `CodeSandbox sign-in failed — this GitHub credential has not authorized CodeSandbox via OAuth. ` +
          `Open https://codesandbox.io/signin in an interactive browser, click "Sign in with GitHub", ` +
          `and authorize with this GitHub account first. Then retry.`
        : `Failed to extract credits from the page. Try --headful and DEBUG=1 for screenshot.`;
      if (args.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.error(`\nNote: ${output._note}`);
        console.error('Page URL:', currentUrl);
      }
      // Exit 0 when we have partial data (API-only also returns ok:true with _note)
      process.exit(0);
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
