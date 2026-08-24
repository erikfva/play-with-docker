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

  // Wait for page to fully load - GitHub uses dynamic content
  await page.waitForTimeout(3000);

  // Try multiple possible selectors for the codespace list container
  const containerSelectors = [
    'main .Box-row',
    'main [data-testid="codespace-list"] .Box-row',
    'main .codespace-list .Box-row',
    '[data-view-component="true"] .Box-row',
    'main ul li',
    'main .js-codespace-list-item',
    'main article',
    '.codespace-item',
  ];

  let rows = [];
  for (const selector of containerSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      const count = await page.locator(selector).count();
      if (count > 0) {
        rows = await page.locator(selector).all();
        break;
      }
    } catch (e) {
      // Try next selector
    }
  }

  if (rows.length === 0) {
    // Debug: dump page HTML for inspection
    const html = await page.content();
    console.log('No codespace rows found. Page title:', await page.title());
    console.log('Page URL:', page.url());
    const fs = require('fs');
    fs.writeFileSync('debug-codespaces-page.html', html);
    await page.screenshot({ path: 'debug-codespaces-page.png', fullPage: true });
    console.log('Debug files saved: debug-codespaces-page.html, debug-codespaces-page.png');
    return [];
  }

  // Extract data from found rows
  const results = [];
  for (const row of rows) {
    try {
      let slug = null;
      let name = '';

      // Strategy 1: Look for the display name in span.h5.pr-2 (GitHub's current UI)
      try {
        const nameEl = row.locator('span.h5.pr-2, .col-11.col-lg-6 span.h5, .col span.h5').first();
        const candidateName = (await nameEl.textContent({ timeout: 1000 }) || '').trim();
        if (candidateName && candidateName !== 'See repository') {
          name = candidateName;
        }
      } catch (e) {
        // Continue to other strategies
      }

      // Strategy 2: Get slug from action menu form (most reliable)
      // The action menu has forms with action="/codespaces/<slug>"
      try {
        const forms = await row.locator('form[action^="/codespaces/"]').all();
        for (const form of forms) {
          const action = await form.getAttribute('action');
          if (action) {
            const slugMatch = action.match(/\/codespaces\/([a-z0-9-]+)/i);
            if (slugMatch) {
              slug = slugMatch[1];
              break;
            }
          }
        }
      } catch (e) {
        // Continue
      }

      // Strategy 3: Fallback to link analysis
      if (!slug) {
        const allLinks = await row.locator('a[href^="/codespaces/"]').all();
        for (const link of allLinks) {
          try {
            const href = await link.getAttribute('href');
            if (!href || href.includes('github.dev')) continue;

            const slugMatch = href.match(/\/codespaces\/([a-z0-9-]+)/i);
            if (!slugMatch) continue;

            const text = (await link.textContent({ timeout: 500 }) || '').trim();
            const skipNames = ['see repository', 'open in browser', 'code', '...', 'view', 'edit', 'settings', 'more', 'actions', 'uh oh!'];

            if (!slug) slug = slugMatch[1];
            if (text && !skipNames.includes(text.toLowerCase())) {
              name = text;
              slug = slugMatch[1];
              break;
            }
          } catch (e) {
            // Skip problematic links
          }
        }
      }

      // Strategy 4: Try to get name from other elements if we have slug but no name
      if (slug && !name) {
        const nameSelectors = [
          'span.h5',
          '.col-11.col-lg-6 .col span',
          'h3 a:not([href*="github.dev"])',
          'h4 a:not([href*="github.dev"])',
          'h3',
          'h4',
          'strong',
          '.codespace-name',
          '[data-testid="codespace-name"]',
        ];
        const skipNames = ['see repository', 'open in browser', 'code', '...', 'view', 'edit', 'settings', 'more', 'actions', 'uh oh!'];
        for (const ns of nameSelectors) {
          try {
            const el = row.locator(ns).first();
            const text = (await el.textContent({ timeout: 500 }) || '').trim();
            if (text && !skipNames.includes(text.toLowerCase())) {
              name = text;
              break;
            }
          } catch (e) {
            // Continue to next selector
          }
        }
      }

      if (!slug) continue;

      // Get status from row text
      const rowText = await row.textContent({ timeout: 1000 }) || '';
      const statusMatch = rowText.match(/\b(Stopped|Active|Running|Shutdown|Idle)\b/i);
      const status = statusMatch ? statusMatch[1].toLowerCase() : 'idle';

      results.push({ slug, name: name || slug, status });
    } catch (e) {
      console.log('Error parsing row:', e.message);
    }
  }

  // Deduplicate by slug
  const unique = results.filter((c, i, arr) => arr.findIndex((x) => x.slug === c.slug) === i);

  console.log(`Found ${unique.length} codespaces:`, unique.map(c => `${c.name} (${c.slug}) - ${c.status}`).join(', '));
  return unique;
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
