'use strict';

try { require('dotenv').config(); } catch {}

function resolvePlaywrightCore() {
  const candidates = [
    () => require('playwright-core'),
    () => process.env.PLAYWRIGHT_CORE_PATH && require(process.env.PLAYWRIGHT_CORE_PATH),
    () => require('/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core'),
  ];
  for (const load of candidates) {
    try {
      const mod = load();
      if (mod) return mod;
    } catch {}
  }
  throw new Error(
    'playwright-core not found. Install it (npm i -D playwright-core) or install Google Chrome via:\n' +
    '  npx playwright install chrome'
  );
}

const DEFAULT_PROFILE_DIR = '/config/.cache/ms-playwright-mcp/mcp-chrome-48e38ac';

function profileDir() {
  return process.env.GITHUB_PROFILE_DIR || DEFAULT_PROFILE_DIR;
}

function browserOptions({ headless, channel } = {}) {
  const options = {
    headless: headless !== undefined ? headless : process.env.HEADFUL !== '1',
    args: ['--no-sandbox'],
  };

  if (channel) options.channel = channel;
  return options;
}

function shouldFallbackToBundledChromium(err) {
  return /Chromium distribution 'chrome' is not found|Executable doesn't exist|browserType\.launch/i.test(String(err.message));
}

async function launchBrowserWithFallback(pw, { headless } = {}) {
  const channel = process.env.CHROME_CHANNEL || 'chrome';
  try {
    return await pw.chromium.launch(browserOptions({ headless, channel }));
  } catch (err) {
    if (process.env.CHROME_CHANNEL || !shouldFallbackToBundledChromium(err)) throw err;
    console.log('Google Chrome is not installed. Falling back to Playwright Chromium...');
    return pw.chromium.launch(browserOptions({ headless }));
  }
}

async function launchPersistentContextWithFallback(pw, dir, contextOptions, { headless } = {}) {
  const channel = process.env.CHROME_CHANNEL || 'chrome';
  try {
    return await pw.chromium.launchPersistentContext(dir, {
      ...browserOptions({ headless, channel }),
      ...contextOptions,
    });
  } catch (err) {
    if (process.env.CHROME_CHANNEL || !shouldFallbackToBundledChromium(err)) throw err;
    console.log('Google Chrome is not installed. Falling back to Playwright Chromium...');
    return pw.chromium.launchPersistentContext(dir, {
      ...browserOptions({ headless }),
      ...contextOptions,
    });
  }
}

async function launchGitHubBrowser({ headless } = {}) {
  const pw = resolvePlaywrightCore();
  const dir = profileDir();
  const contextOptions = { viewport: { width: 1366, height: 850 } };

  if (process.env.GITHUB_AUTH_FILE) {
    const browser = await launchBrowserWithFallback(pw, { headless });
    try {
      const context = await browser.newContext({
        ...contextOptions,
        storageState: process.env.GITHUB_AUTH_FILE,
      });
      context.__ownedBrowser = browser;
      return context;
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  }

  try {
    return await launchPersistentContextWithFallback(pw, dir, contextOptions, { headless });
  } catch (err) {
    if (/ProcessSingleton|SingletonLock|is already running|Failed to create/i.test(String(err.message))) {
      throw new Error(
        `Chrome profile "${dir}" is locked by another running instance.\n` +
        'Close the Playwright MCP browser session (or opencode) and retry,\n' +
        'or point GITHUB_PROFILE_DIR at a different user-data-dir.'
      );
    }
    throw err;
  }
}

async function pickPage(context) {
  return context.pages()[0] || await context.newPage();
}

async function isLoggedIn(page) {
  await page.goto('https://github.com/codespaces', { waitUntil: 'domcontentloaded' });
  return !/\b(login|session)s?\b/.test(new URL(page.url()).pathname);
}

async function login(page) {
  const user = process.env.TEST_GH_USER;
  const pass = process.env.TEST_GH_PASS;
  if (!user || !pass) {
    throw new Error('Not signed in and TEST_GH_USER/TEST_GH_PASS are missing from environment or .env');
  }
  await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Username or email address' }).fill(user);
  await page.getByRole('textbox', { name: 'Password' }).fill(pass);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForLoadState('domcontentloaded');
  if (page.url().includes('/sessions/verified-device')) {
    throw new Error(
      'GitHub sent a device-verification code by email. Complete verification once in an ' +
      'interactive browser using this profile, then rerun this script.'
    );
  }
  if (!await isLoggedIn(page)) {
    throw new Error('GitHub login failed. Check TEST_GH_USER/TEST_GH_PASS.');
  }
}

async function ensureSignedIn(context) {
  const page = await pickPage(context);
  if (!await isLoggedIn(page)) {
    await login(page);
  }
  return page;
}

async function listCodespaces(page) {
  await page.goto('https://github.com/codespaces', { waitUntil: 'domcontentloaded' });
  await page
    .waitForSelector('main .Box-row', { timeout: 30000 })
    .catch(() => {});
  return page.$$eval('main .Box-row', (rows) =>
    rows
      .map((row) => {
        const link = Array.from(row.querySelectorAll('a[href^="/codespaces/"]')).find((a) =>
          /^\/codespaces\/[a-z0-9-]+$/.test(a.getAttribute('href') || '')
        );
        if (!link) return null;
        const slug = link.getAttribute('href').split('/').pop();
        const text = row.innerText;
        const m = text.match(/\b(Stopped|Active|Running)\b/i);
        return {
          slug,
          name: link.textContent.trim(),
          status: m ? m[1].toLowerCase() : 'idle',
        };
      })
      .filter(Boolean)
      .filter((c, i, arr) => arr.findIndex((x) => x.slug === c.slug) === i)
  );
}

async function waitForToast(page, text, timeoutMs = 15000) {
  await page
    .waitForFunction((t) => document.body && document.body.innerText.includes(t), text, {
      timeout: timeoutMs,
    })
    .catch(() => {});
}

function slugifyName(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, '-');
}

function displayNameFromSlug(slug) {
  const m = slug.match(/^(.*)-[a-z0-9]{10,}$/);
  return (m ? m[1] : slug).replace(/-/g, ' ');
}

async function findCodespace(page, query) {
  const wantedSlug = slugifyName(query);
  const items = await listCodespaces(page);
  let matches = items.filter((c) => c.slug === wantedSlug || c.name === String(query).trim());
  if (matches.length === 0) matches = items.filter((c) => c.slug.startsWith(wantedSlug));
  if (matches.length === 0) {
    throw new Error(
      `No codespace matching "${query}". Found: ${items.map((c) => `${c.name} (${c.slug})`).join(', ') || 'none'}`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `"${query}" is ambiguous. Matches: ${matches.map((c) => `${c.name} (${c.slug})`).join(', ')}`
    );
  }
  return matches[0];
}

async function codespaceRow(page, slug) {
  return page
    .locator('main .Box-row')
    .filter({ has: page.locator(`a[href="/codespaces/${slug}"]`) })
    .first();
}

async function openActionsMenu(page, row) {
  await row.scrollIntoViewIfNeeded();
  await row.locator('button:visible').first().click();
  return page.getByRole('menu');
}

async function waitForCondition(fn, timeoutMs = 45000, intervalMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function stopCodespace(page, slug) {
  const row = await codespaceRow(page, slug);
  await openActionsMenu(page, row);
  await page.getByRole('menuitemradio', { name: 'Stop codespace' }).click();
  await waitForToast(page, `"${slug}" stopped.`);
  const stopped = await waitForCondition(async () => {
    const items = await listCodespaces(page);
    const match = items.find((c) => c.slug === slug);
    return match && match.status !== 'active' && match.status !== 'running';
  });
  if (!stopped) throw new Error(`Stop for "${slug}" did not take effect`);
  return { slug, status: 'stopped' };
}

async function deleteCodespace(page, slug) {
  const row = await codespaceRow(page, slug);
  await openActionsMenu(page, row);
  await page.getByRole('menuitemradio', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await waitForToast(page, `"${slug}" deleted.`);
  const gone = await waitForCondition(async () => {
    const items = await listCodespaces(page);
    return !items.some((c) => c.slug === slug);
  });
  if (!gone) throw new Error(`Delete for "${slug}" did not take effect`);
  return { slug, status: 'deleted' };
}

async function closeBrowser(context) {
  const browser = context.__ownedBrowser;
  try { await context.close(); } catch {}
  if (browser) {
    try { await browser.close(); } catch {}
  }
}

module.exports = {
  launchGitHubBrowser,
  ensureSignedIn,
  isLoggedIn,
  login,
  pickPage,
  listCodespaces,
  findCodespace,
  codespaceRow,
  openActionsMenu,
  waitForToast,
  waitForCondition,
  stopCodespace,
  deleteCodespace,
  displayNameFromSlug,
  slugifyName,
  closeBrowser,
};
