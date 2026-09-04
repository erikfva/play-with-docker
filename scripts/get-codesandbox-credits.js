#!/usr/bin/env node
'use strict';

try { require('dotenv').config(); } catch {}

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { workspace: null, json: true, headless: false, googleCredentials: null, codesandboxCredentials: null, saveState: null, saveOnly: false, vpsId: null, vpsName: null, apiUrl: null, serverToken: null, noUpdate: false, updateVps: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--no-json') args.json = false;
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
    else if (a === '--google-credentials') {
      const v = argv[++i];
      if (!v) throw new Error('--google-credentials requires a value');
      args.googleCredentials = v;
    } else if (a.startsWith('--google-credentials=')) args.googleCredentials = a.slice('--google-credentials='.length);
    else if (a === '--codesandbox-credentials' || a === '--cs-credentials' || a === '--csb-credentials') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} requires a value`);
      args.codesandboxCredentials = v;
    } else if (a.startsWith('--codesandbox-credentials=')) args.codesandboxCredentials = a.slice('--codesandbox-credentials='.length);
    else if (a.startsWith('--cs-credentials=')) args.codesandboxCredentials = a.slice('--cs-credentials='.length);
    else if (a.startsWith('--csb-credentials=')) args.codesandboxCredentials = a.slice('--csb-credentials='.length);
    else if (a === '--save-state' || a === '--save-codesandbox-state' || a === '--save-auth') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} requires a value`);
      args.saveState = v;
    } else if (a.startsWith('--save-state=')) args.saveState = a.slice('--save-state='.length);
    else if (a.startsWith('--save-codesandbox-state=')) args.saveState = a.slice('--save-codesandbox-state='.length);
    else if (a.startsWith('--save-auth=')) args.saveState = a.slice('--save-auth='.length);
    else if (a === '--save-only') args.saveOnly = true;
    else if (a === '--vps-id' || a === '--vps') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      args.vpsId = v;
    } else if (a.startsWith('--vps-id=')) args.vpsId = a.slice('--vps-id='.length);
    else if (a.startsWith('--vps=')) args.vpsId = a.slice('--vps='.length);
    else if (a === '--vps-name' || a === '--name' || a === '--credential-name' || a === '--credential') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      args.vpsName = v;
    } else if (a.startsWith('--vps-name=')) args.vpsName = a.slice('--vps-name='.length);
    else if (a.startsWith('--name=')) args.vpsName = a.slice('--name='.length);
    else if (a.startsWith('--credential-name=')) args.vpsName = a.slice('--credential-name='.length);
    else if (a.startsWith('--credential=')) args.vpsName = a.slice('--credential='.length);
    else if (a === '--api-url' || a === '--url' || a === '--base-url') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} requires a value`);
      args.apiUrl = v;
    } else if (a.startsWith('--api-url=')) args.apiUrl = a.slice('--api-url='.length);
    else if (a.startsWith('--url=')) args.apiUrl = a.slice('--url='.length);
    else if (a.startsWith('--base-url=')) args.apiUrl = a.slice('--base-url='.length);
    else if (a === '--server-token' || a === '--token') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} requires a value`);
      args.serverToken = v;
    } else if (a.startsWith('--server-token=')) args.serverToken = a.slice('--server-token='.length);
    else if (a.startsWith('--token=')) args.serverToken = a.slice('--token='.length);
    else if (a === '--no-update' || a === '--skip-update' || a === '--no-vps-update') { args.noUpdate = true; }
    else if (a === '--update-vps' || a === '--update') { args.updateVps = true; args.noUpdate = false; }
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/get-codesandbox-credits.js [--credentials <github.json>] [--google-credentials <google.json>] [--codesandbox-credentials <csb.json>] [--workspace <ws_...>] [--save-state <out.json>] --vps-id <id> | --vps-name <name> [--api-url <url>] [--server-token <tok>] [--no-update]

Defaults: --json, --headful (auto xvfb-run on headless VPS).

Options:
  --credentials <path>      Playwright storageState file for GitHub (browser mode). Also honors GITHUB_AUTH_FILE env.
  --google-credentials <p>  Playwright storageState file for Google (browser mode). Also honors GOOGLE_AUTH_FILE env.
  --codesandbox-credentials <p>  Playwright storageState for CodeSandbox directly (avoids GitHub/Google OAuth). Also honors CODESANDBOX_AUTH_FILE env.
  --save-state <path>       After successful browser login, save CodeSandbox storageState to <path> for reuse (like github-auth.js --output).
                            Example: --google-credentials /mnt/s3/google/simca.scz/google.json --save-state /mnt/s3/codesandbox-web/simca.scz.json
  --save-only               Sign in and save --save-state, then exit: skips credits scraping and vps.status update (fast session generation)
  --workspace <id>          CodeSandbox workspace/team id (e.g. ws_Eha5JM84UeHdXshrooLDTA). If omitted, auto-detected from dashboard.
  --vps-id <id>             VPS id to update (required unless --vps-name given). Also honors CODESANDBOX_VPS_ID env.
  --vps-name <name>         VPS / credential name to update, e.g. vm-manager232 (required unless --vps-id given).
                            Also honors CODESANDBOX_VPS_NAME env. Takes precedence lookup by exact name match.
  --api-url <url>           API base URL for VPS update (default: PWD_API_URL → http://localhost:$PORT → http://localhost:3000)
  --server-token <tok>      x-server-token for the API (default: SERVER_TOKEN env)
  --no-update               Skip updating vps.status (scrape only)
  --no-json                 Output human-readable text instead of JSON
  --headless                Force headless (no xvfb-run)

  The scrape is skipped when the stored billing is still fresh: the Credits
  quota fetchedAt + CODESANDBOX_SCRAPER_TTL (minutes, default 60) is still in
  the future. Set CODESANDBOX_SCRAPER_TTL=0 to always scrape.

Examples:
  node scripts/get-codesandbox-credits.js --credentials /mnt/s3/github/vm-manager123/github.json --vps-name vm-manager123
  node scripts/get-codesandbox-credits.js --google-credentials /mnt/s3/google/etecnologysys/google.json --vps-name etecnologysys
  # Save CodeSandbox session for reuse (like github-auth.js):
  node scripts/get-codesandbox-credits.js --google-credentials /mnt/s3/google/simca.scz/google.json --save-state /mnt/s3/codesandbox-web/simca.scz.json
  # Reuse without re-OAuth:
  node scripts/get-codesandbox-credits.js --codesandbox-credentials /mnt/s3/codesandbox-web/simca.scz.json --vps-name simca-scz

Flow (--credentials):
  1. Launch Playwright with GitHub session (via --credentials or GITHUB_PROFILE_DIR)
  2. Ensure GitHub signed in (re-login with TEST_GH_USER/TEST_GH_PASS if needed)
  3. Navigate to https://codesandbox.io/dashboard (OAuth via GitHub if needed)
  4. Extract "Virtual machine credits" → included / used / period

Flow (browser mode, --google-credentials):
  1. Launch Playwright with Google session (via --google-credentials or GOOGLE_AUTH_FILE)
  2. Navigate to https://codesandbox.io/dashboard (OAuth via Google if needed)
  3. Extract "Virtual machine credits" → included / used / period

Flow (browser mode, --codesandbox-credentials):
  1. Launch Playwright with CodeSandbox storageState directly (from prior --save-state)
  2. No GitHub/Google needed – goes straight to dashboard
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
      console.error('Or run with DEBUG=1 for screenshot: DEBUG=1 node scripts/get-codesandbox-credits.js --credentials ...');
      throw new Error('Cloudflare challenge timeout – dashboard not reachable.');
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
  // Minimal stealth for Google – the full STEALTH_SCRIPT (plugins/languages) flags Google
  // as bot on /dashboard (verified: minimal webdriver hide passes, full fails after flaky CF).
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = window.chrome || { runtime: {} };
    });
  } catch {}

  // Lightweight CF wait for Google – aggressive Turnstile clicks flag Google sessions as bots.
  // Direct goto to /dashboard now passes (verified: anonymous and Google both clear in ~5s
  // via xvfb headful + stealth – root warmup not needed after clearing logic removed).
  async function waitForCloudflareLight(p, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastTitle='';
    while (Date.now() < deadline) {
      const title = await p.title().catch(() => '');
      const body = await p.locator('body').innerText().catch(() => '').then(t => t.slice(0, 200));
      const url = p.url();
      const isChallenge = /just a moment|perfor.*security verification|cdn-cgi\/challenge|challenges\.cloudflare|attention required|checking if the site connection is secure/i.test(title + ' ' + body + ' ' + url);
      if (!isChallenge) return true;
      if (title!==lastTitle) console.log('CF light detected, waiting 5s... title:', title.slice(0,80), 'url:', url.slice(0,60));
      lastTitle=title;
      await p.waitForTimeout(5000);
      await p.mouse.move(400 + Math.random()*100, 300 + Math.random()*100).catch(()=>{});
    }
    const finalTitle = await p.title().catch(()=> '');
    console.log(`CF light still present after ${timeoutMs}ms (title: ${finalTitle.slice(0,60)}). Giving up.`);
    return false;
  }
  await page.goto('https://codesandbox.io/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const cfPassed = await waitForCloudflareLight(page, 45000);
  if (!cfPassed) {
    console.warn('Cloudflare challenge did not clear in 45s (Google flow). Trying reload + retry...');
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{}); await page.waitForTimeout(5000); } catch {}
    const retryPassed = await waitForCloudflareLight(page, 30000);
    if (!retryPassed) {
      console.warn('Retrying Cloudflare with mouse move...');
      await page.mouse.move(400 + Math.random()*100, 300 + Math.random()*100).catch(()=>{});
      await page.waitForTimeout(5000);
      await waitForCloudflareLight(page, 15000);
    }
  }

  let url = page.url();

  // Handle Cloudflare interstitial
  if (/cdn-cgi\/challenge|just a moment|attention required/i.test(await page.title().catch(() => '')) || url.includes('challenges.cloudflare.com')) {
    console.log('Waiting for Cloudflare challenge to pass (retry)...');
    const passed2 = await waitForCloudflareLight(page, 30000);
    if (!passed2) {
      console.error('Cloudflare still blocking (Google flow).');
      throw new Error('Cloudflare challenge timeout – dashboard not reachable.');
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
// Main — browser-only (webscraping)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scraper TTL (CODESANDBOX_SCRAPER_TTL, minutes, default 60)
// ---------------------------------------------------------------------------

function scraperTtlMinutes() {
  const raw = process.env.CODESANDBOX_SCRAPER_TTL;
  if (raw == null || raw === '') return 60;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[vps-status] Invalid CODESANDBOX_SCRAPER_TTL="${raw}" — using default 60 minutes.`);
    return 60;
  }
  return n;
}

function storedBillingFetchedAt(status) {
  const quotas = status && typeof status === 'object' && Array.isArray(status.quotas) ? status.quotas : [];
  const q = quotas.find(q => q && typeof q === 'object'
    && ((q.name && String(q.name).toLowerCase().includes('credits'))
      || (q.quotaUnit === 'credits' && q.quotaPeriod === 'billing-cycle')));
  return (q && q.fetchedAt) || null;
}

// Pre-scrape freshness check: true when the stored Credits billing is still
// fresh (fetchedAt + TTL in the future) and the browser scrape can be skipped.
// Fail-open (false) when the API is unreachable or no billing was ever stored.
async function isStoredBillingFresh(baseUrl, token, vpsId, ttlMinutes) {
  try {
    const r = await fetch(`${baseUrl}/api/v1/vps/${encodeURIComponent(vpsId)}`, {
      headers: { 'x-server-token': token }
    });
    if (!r.ok) return false;
    const row = await r.json();
    const fetchedAt = storedBillingFetchedAt(row.status);
    if (!fetchedAt) return false;
    const t = new Date(fetchedAt).getTime();
    if (Number.isNaN(t)) return false;
    return t + ttlMinutes * 60000 > Date.now();
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Main — browser-only (webscraping)
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
  const hasCodesandboxCredsEarly = !!(args.codesandboxCredentials || process.env.CODESANDBOX_AUTH_FILE);
  const hasAnyBrowserCredsEarly2 = hasGithubCreds || hasGoogleCreds || hasCodesandboxCredsEarly;
  if (!hasAnyBrowserCredsEarly2) {
    console.error('Error: browser credentials required. Provide one of:');
    console.error('  --credentials <github.json>             (GitHub storageState)');
    console.error('  --google-credentials <google.json>      (Google storageState)');
    console.error('  --codesandbox-credentials <csb.json>    (CodeSandbox storageState, saved via --save-state)');
    console.error('Or set env: GITHUB_AUTH_FILE / GOOGLE_AUTH_FILE / CODESANDBOX_AUTH_FILE');
    printUsage();
    process.exit(1);
  }

  // VPS target is mandatory (unless --no-update skips the billing merge).
  // Provide --vps-id <id> or --vps-name <name> (or CODESANDBOX_VPS_ID /
  // CODESANDBOX_VPS_NAME env). The browser auth file basename also counts as
  // the credential name, e.g. CODESANDBOX_AUTH_FILE=.../vm-manager232.json.
  const browserFileForVps = args.codesandboxCredentials || args.credentials || args.googleCredentials
    || process.env.CODESANDBOX_AUTH_FILE || process.env.GITHUB_AUTH_FILE || process.env.GOOGLE_AUTH_FILE || null;
  const browserBaseForVps = browserFileForVps ? path.basename(browserFileForVps).replace(/\.json$/, '') : null;
  const hasVpsTarget = !!(args.vpsId || args.vpsName || process.env.CODESANDBOX_VPS_ID || process.env.CODESANDBOX_VPS_NAME || browserBaseForVps);
  if (!args.noUpdate && !args.saveOnly && !hasVpsTarget) {
    console.error('Error: VPS target required. Provide one of:');
    console.error('  --vps-id <id>       (VPS row id)');
    console.error('  --vps-name <name>   (VPS / credential name, e.g. vm-manager232)');
    console.error('Or set env: CODESANDBOX_VPS_ID / CODESANDBOX_VPS_NAME');
    console.error('Or pass --no-update to scrape only without updating vps.status.');
    printUsage();
    process.exit(2);
  }

  // Scraper TTL: skip the expensive browser scrape when the stored billing is
  // still fresh (Credits quota fetchedAt + CODESANDBOX_SCRAPER_TTL minutes is
  // in the future). Fail-open: scrape anyway when the API can't be reached.
  if (!args.noUpdate) {
    const ttl = scraperTtlMinutes();
    if (ttl > 0) {
      const baseUrl = (args.apiUrl || process.env.PWD_API_URL || process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
      const token = args.serverToken || process.env.SERVER_TOKEN || '';
      if (!token) {
        console.warn('[vps-status] SERVER_TOKEN not set — cannot check billing freshness, scraping anyway.');
      } else {
        let checkId = args.vpsId || process.env.CODESANDBOX_VPS_ID || null;
        const checkName = args.vpsName || process.env.CODESANDBOX_VPS_NAME || browserBaseForVps || null;
        if (!checkId && checkName) {
          const resolved = await resolveVpsIdByName(baseUrl, token, checkName);
          checkId = resolved ? resolved.id : null;
        }
        if (checkId && await isStoredBillingFresh(baseUrl, token, checkId, ttl)) {
          console.log(`[vps-status] billing for "${checkName || checkId}" is fresh (fetchedAt + ${ttl}min TTL still valid) — skipping scrape.`);
          return;
        }
      }
    }
  }
  if (!process.env.DISPLAY && !process.env._XVFB_REEXEC) {
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
  } else if (!process.env.DISPLAY) {
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
  if (args.codesandboxCredentials) {
    const abs = path.resolve(args.codesandboxCredentials);
    if (!fs.existsSync(abs)) throw new Error(`CodeSandbox credential file not found: ${abs}`);
    process.env.CODESANDBOX_AUTH_FILE = abs;
  } else if (process.env.CODESANDBOX_AUTH_FILE) {
    // already set via env
  }
  if (args.saveState) {
    const abs = path.resolve(args.saveState);
    // ensure parent dir exists early so we fail fast if unwritable
    try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch {}
    process.env.CODESANDBOX_SAVE_STATE = abs;
  }
  if (args.workspace) process.env.CODESANDBOX_WORKSPACE = args.workspace;
  if (args.headless !== undefined) process.env.HEADFUL = args.headless ? '0' : '1';

  // Browser path (requires Playwright + browser)
  const lib = require('./auth-browser');
  let context;
  let page;

  // Priority: direct CodeSandbox storageState > Google > GitHub
  // This mirrors github-auth.js: once you save the state, you reuse it without re-OAuth.
  if (hasCodesandboxCredsEarly) {
    const csbFile = process.env.CODESANDBOX_AUTH_FILE;
    console.log(`Loading CodeSandbox credentials from ${csbFile}...`);
    context = await lib.launchBrowserWithStorageState(csbFile, { headless: args.headless });
    page = await context.pages()[0] || await context.newPage();
    // Minimal stealth still helps against Cloudflare on dashboard
    try {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = window.chrome || { runtime: {} };
      });
    } catch {}
    console.log('CodeSandbox credentials loaded, verifying session...');
    // Verify by going to dashboard – if session expired, fallback will be reported later
    await page.goto('https://codesandbox.io/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    // Light Cloudflare wait (same as Google flow)
    const title = await page.title().catch(() => '');
    const body = await page.locator('body').innerText().catch(() => '').then(t => t.slice(0, 200));
    const url = page.url();
    const isCF = /just a moment|perfor.*security verification|cdn-cgi\/challenge|challenges\.cloudflare|attention required|checking if the site connection is secure/i.test(title + ' ' + body + ' ' + url);
    if (isCF) {
      console.log('Cloudflare challenge detected on dashboard, waiting...');
      let deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const t = await page.title().catch(() => '');
        const b = await page.locator('body').innerText().catch(() => '').then(x => x.slice(0, 200));
        const u = page.url();
        if (!/just a moment|perfor.*security|cdn-cgi\/challenge|challenges\.cloudflare|attention required/i.test(t + ' ' + b + ' ' + u)) break;
        await page.waitForTimeout(5000);
        await page.mouse.move(400 + Math.random()*100, 300 + Math.random()*100).catch(()=>{});
      }
    }
    if (page.url().includes('/signin') || await page.locator('text=Sign in to CodeSandbox').first().count().then(c=>c>0).catch(()=>false)) {
      console.warn('CodeSandbox storageState expired or not signed in – session needs refresh.');
      console.warn('Re-create it with: node scripts/get-codesandbox-credits.js --google-credentials <google.json> --save-state ' + csbFile);
      // Continue – extractCredits will report ok:false with hint
    }
  } else if (hasGoogleCreds) {
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

    // Fast path: only sign in + save the session, skip credits scraping
    // and the vps.status update entirely.
    if (args.saveOnly) {
      const saveOnlyPath = process.env.CODESANDBOX_SAVE_STATE || args.saveState;
      if (!saveOnlyPath) throw new Error('--save-only requires --save-state <path>');
      await page.goto('https://codesandbox.io/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
      if (/\/signin/i.test(page.url())) {
        throw new Error('CodeSandbox sign-in failed — landed on /signin, not saving.');
      }
      const abs = path.resolve(saveOnlyPath);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await context.storageState({ path: abs });
      console.log(`CodeSandbox session saved to ${abs}`);
      if (args.json) console.log(JSON.stringify({ ok: true, saved: abs, fetchedAt: new Date().toISOString() }, null, 2));
      return;
    }

    let credits = await extractCredits(page);

    // Cold Cloudflare cache: first navigation to /dashboard may get a
    // "Just a moment..." challenge that sets cf_clearance cookie, but
    // extractCredits may have already fallen through to /signin before
    // the cookie is usable. Retry once – second attempt reuses the
    // freshly set cookie and succeeds (observed with vm-manager232:
    // 1st run ok:false, 2nd run ok:true without any file change).
    if (!credits.ok && (hasGithubCreds || hasGoogleCreds)) {
      const isSignIn = /\/signin/i.test(credits.url) || /Sign in to CodeSandbox/.test(credits.rawExcerpt);
      if (isSignIn) {
        console.log('First extraction landed on sign-in (likely cold Cloudflare/OAuth), retrying once in 5s...');
        await page.waitForTimeout(5000);
        // Re-ensure OAuth – the cf_clearance is now set, so this will pass
        try {
          if (hasGoogleCreds) await ensureCodeSandboxSignedInViaGoogle(page);
          else await ensureCodeSandboxSignedIn(page, context);
        } catch (e) {
          console.warn('Retry ensure sign-in failed:', e.message);
        }
        credits = await extractCredits(page);
        if (credits.ok) console.log('Retry succeeded.');
        else console.warn('Retry still failed – will report original error.');
      }
    }

    // Save CodeSandbox storageState for reuse (like github-auth.js --output)
    // Only save when credits were actually extracted (ok:true) – avoids
    // overwriting a good file with a sign-in page on Cloudflare/OAuth flake.
    const saveStatePath = process.env.CODESANDBOX_SAVE_STATE || args.saveState;
    if (saveStatePath && context) {
      if (credits.ok) {
        try {
          const abs = path.resolve(saveStatePath);
          await fs.promises.mkdir(path.dirname(abs), { recursive: true });
          await context.storageState({ path: abs });
          console.log(`CodeSandbox session saved to ${abs} (reuse with --codesandbox-credentials ${abs})`);
        } catch (e) {
          console.warn(`Failed to save storageState to ${saveStatePath}: ${e.message}`);
        }
      } else {
        console.warn(`Not saving storageState to ${saveStatePath}: credits extraction failed (ok:false) – not overwriting existing file.`);
        // If no file existed before, still save for debugging the failure
        const abs = path.resolve(saveStatePath);
        if (!fs.existsSync(abs)) {
          try {
            await fs.promises.mkdir(path.dirname(abs), { recursive: true });
            await context.storageState({ path: abs });
            console.log(`Saved failure state to ${abs} for debugging (ok:false). Delete it before retrying.`);
          } catch {}
        }
      }
    }

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
      // Team ID was not found in the page URL, HTML, or localStorage.
      // No hardcoded fallback — the team is only knowable from the authenticated session.
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

    // ---- Update vps.status via HTTP (merge billing into Credits quota) ----
    if (!args.noUpdate) {
      try {
        await updateVpsBilling(output, args);
      } catch (e) {
        // Non-fatal — scraping already succeeded; surface the error but don't
        // fail the run. The billing output above is still useful on its own.
        console.warn(`[vps-status] billing merge skipped: ${e.message}`);
      }
    }
  } finally {
    await lib.closeBrowser(context);
  }
}

async function updateVpsBilling(output, args) {
  const baseUrl = (args.apiUrl || process.env.PWD_API_URL || process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const token = args.serverToken || process.env.SERVER_TOKEN || '';
  if (!token) {
    console.warn('[vps-status] SERVER_TOKEN not set (--server-token / $SERVER_TOKEN) — skipping vps.status update.');
    return;
  }

  // Resolve VPS id: explicit --vps-id / CODESANDBOX_VPS_ID wins,
  // otherwise --vps-name / CODESANDBOX_VPS_NAME, otherwise the browser auth
  // file basename as credential name (e.g. .../vm-manager232.json).
  // No other auto-detect — one of these is mandatory (validated in main).
  let vpsId = args.vpsId || process.env.CODESANDBOX_VPS_ID || null;
  const browserFile = args.codesandboxCredentials || args.credentials || args.googleCredentials
    || process.env.CODESANDBOX_AUTH_FILE || process.env.GITHUB_AUTH_FILE || process.env.GOOGLE_AUTH_FILE || null;
  const browserBase = browserFile ? path.basename(browserFile).replace(/\.json$/, '') : null;
  const vpsName = args.vpsName || process.env.CODESANDBOX_VPS_NAME || browserBase || null;
  let vpsApiToken = null;

  if (!vpsId) {
    const resolved = await resolveVpsIdByName(baseUrl, token, vpsName);
    if (!resolved) {
      throw new Error(`VPS not found for name "${vpsName}". Check --vps-name / CODESANDBOX_VPS_NAME.`);
    }
    vpsId = resolved.id;
    vpsApiToken = resolved.apiToken || null;
  } else if (vpsName) {
    // Both given: enrich with the correlated API token when names match.
    vpsApiToken = readApiTokenByBasename(vpsName);
  }

  const billing = {
    includedCredits: output.includedCredits,
    usedCredits: output.usedCredits,
    remainingCredits: output.remainingCredits,
    billingPeriod: output.billingPeriod,
    url: output.url,
    sandboxes: output.sandboxes,
    vmsActive: output.vmsActive,
    freeCreditsUsed: output.freeCreditsUsed,
    fetchedAt: output.fetchedAt,
    team: output.team,
    workspace: output.workspace,
  };
  // Include the API token when we discovered it via the VPS row so the
  // server can optionally validate the session belongs to the right account.
  if (vpsApiToken) billing.apiToken = vpsApiToken;

  const res = await fetch(`${baseUrl}/api/v1/vps/${encodeURIComponent(vpsId)}/status/billing`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-server-token': token },
    body: JSON.stringify({ billing })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.error || body.code || `HTTP ${res.status}`;
    console.warn(`[vps-status] PATCH /vps/${vpsId}/status/billing failed: ${msg}`);
    return;
  }
  const quota = body.status?.quotas?.find(q => (q.name && /credits/i.test(q.name)) || (q.quotaUnit === 'credits' && q.quotaPeriod === 'billing-cycle'));
  if (quota) console.log(`[vps-status] ✓ vps ${vpsId} status updated — Credits ${quota.usage ?? '?'}/${quota.limit ?? '?'} (remaining ${quota.remaining ?? '?'}) [${body.status?.status}]`);
  else console.log(`[vps-status] ✓ vps ${vpsId} status updated [${body.status?.status}]`);
}

/**
 * Read the API-token file ({ token: "..." }) with the given basename from the
 * known credential dirs. Returns the token string or null.
 * StorageState files ({ cookies, origins }) are ignored (no .token).
 */
function readApiTokenByBasename(base) {
  const dirs = [
    path.join(path.dirname(__dirname), 'credentials/codesandbox'),
    '/config/workspace/play-with-docker/credentials/codesandbox',
    '/mnt/s3/codesandbox',
  ];
  const seen = new Set();
  for (const d of dirs) {
    if (seen.has(d)) continue;
    seen.add(d);
    const p = path.join(d, `${base}.json`);
    try {
      if (!fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && typeof parsed.token === 'string' && parsed.token.trim()) return parsed.token.trim();
    } catch {}
  }
  return null;
}

/**
 * Resolve a VPS row id by exact VPS / credential name.
 * Mandatory-input resolver: no guessing, no fingerprint/workspace fallback.
 * Returns { id, apiToken } or null when no exact name match exists.
 */
async function resolveVpsIdByName(baseUrl, token, vpsName) {
  if (!vpsName) return null;
  let list;
  try {
    const r = await fetch(`${baseUrl}/api/v1/vps?provider=codesandbox&limit=100`, {
      headers: { 'x-server-token': token }
    });
    if (!r.ok) return null;
    const j = await r.json();
    list = j.vps || j.rows || [];
  } catch { return null; }
  const hit = (list || []).find(v => v.name === vpsName);
  if (!hit) return null;
  // Enrich with the correlated API token file when present.
  const apiToken = readApiTokenByBasename(vpsName);
  return { id: hit.id, apiToken };
}

main().catch(err => {
  console.error(err.message || err);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
