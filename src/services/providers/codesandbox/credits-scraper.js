'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCRAPER_SCRIPT = path.resolve(
  __dirname, '../../../../scripts/get-codesandbox-credits.js'
);
const DEFAULT_TIMEOUT_MS =
  parseInt(process.env.CODESANDBOX_SCRAPER_TIMEOUT_MS, 10) || 60000;

function resolveWebCredentialsDir() {
  if (process.env.CODESANDBOX_WEB_CREDENTIALS_DIR) {
    return path.resolve(process.env.CODESANDBOX_WEB_CREDENTIALS_DIR);
  }
  // Docker: ./credentials is mounted at /mnt/s3 (read-only)
  const docker = '/mnt/s3/codesandbox-web';
  if (fs.existsSync(docker)) return docker;
  // Local dev fallback
  return path.resolve(__dirname, '../../../../credentials/codesandbox-web');
}

// ---------------------------------------------------------------------------
// In-process TTL cache — keyed by teamId, null results never cached
// ---------------------------------------------------------------------------

const scrapeCache = new Map(); // teamId → { value, expiresAt }

/**
 * Cache TTL in milliseconds. Controlled by CODESANDBOX_CREDITS_CACHE_TTL_SECONDS.
 * Evaluated once at module load time so the value is stable within a process.
 *
 * - Default: 300 s (5 minutes) — avoids re-launching Chromium on back-to-back
 *   status checks while still reflecting credit changes within one billing cycle.
 * - Set to 0 to disable caching (every call scrapes fresh — useful for debugging).
 * - Set to a large value (e.g. 3600) to reduce scraping frequency on deployments
 *   that poll credential status frequently.
 */
const CACHE_TTL_MS = (() => {
  const raw = process.env.CODESANDBOX_CREDITS_CACHE_TTL_SECONDS;
  if (raw !== undefined && raw !== '') {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1000;
  }
  return 5 * 60 * 1000; // default: 5 minutes
})();

function getCachedScrape(teamId) {
  const hit = scrapeCache.get(teamId);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    scrapeCache.delete(teamId);
    return null;
  }
  return hit.value;
}

function putCachedScrape(teamId, value) {
  // Only cache successful (non-null) results. null means "no matching credential
  // found", which is transient — a new codesandbox-web file could be added.
  if (value != null) {
    scrapeCache.set(teamId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

function clearScrapeCache() {
  scrapeCache.clear();
}

// ---------------------------------------------------------------------------
// Candidate discovery — codesandbox-web/*.json files (CodeSandbox storageState)
// ---------------------------------------------------------------------------

/**
 * List all .json files in the web-credentials directory.
 * Returns absolute paths, sorted by filename (stable order across runs).
 * Re-reads the directory on every call — no internal caching of the listing.
 *
 * Prefers codesandbox-web session files over GitHub/Google sessions because:
 * - No OAuth redirect required (fastest mode).
 * - Files were created specifically for this purpose via codesandbox-auth.js.
 */
function listWebCredentialFiles() {
  const dir = resolveWebCredentialsDir();
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Single-candidate scrape (async spawn, not spawnSync)
// ---------------------------------------------------------------------------

/**
 * Run get-codesandbox-credits.js with one CodeSandbox web credential file.
 *
 * Uses async spawn (not spawnSync) to avoid blocking the event loop during
 * a 60-second browser scrape. Candidates are tried sequentially (not in
 * parallel) by the caller to avoid launching multiple Playwright+Chromium
 * instances simultaneously.
 *
 * Passes --codesandbox-credentials (direct session, no GitHub/Google OAuth).
 * Unsets _XVFB_REEXEC so the child can re-exec under xvfb-run if needed.
 *
 * @param {string} credFile - Absolute path to a codesandbox-web storageState JSON
 * @param {string} teamId   - Workspace ID to pass as --workspace filter
 * @param {number} timeoutMs - Per-candidate timeout in milliseconds
 * @returns {Promise<object|null>} Parsed JSON output, or null on failure.
 */
function runScraperWithCredential(credFile, teamId, timeoutMs) {
  return new Promise((resolve) => {
    if (!fs.existsSync(credFile)) return resolve(null);

    const args = [
      SCRAPER_SCRIPT,
      '--codesandbox-credentials', credFile,
      '--json',
    ];
    if (teamId) args.push('--workspace', teamId);

    // Remove _XVFB_REEXEC from the inherited env so the child script can
    // re-exec under xvfb-run even if the parent was already under xvfb-run.
    const childEnv = { ...process.env };
    delete childEnv._XVFB_REEXEC;

    const child = spawn(process.execPath, args, {
      env: childEnv,
    });

    let stdout = '';
    let stderr = ''; // eslint-disable-line no-unused-vars
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        console.warn(
          `[credits-scraper] Timeout (${timeoutMs}ms) for ${path.basename(credFile)}`
        );
        resolve(null);
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0 && code !== null) {
        console.warn(
          `[credits-scraper] Script exited ${code} for ${path.basename(credFile)}`
        );
      }

      // The script emits log lines before the JSON block.
      // Find the last line that starts with '{' — that is the JSON output.
      const lines = stdout.split('\n');
      const jsonLine = [...lines].reverse().find((l) => l.trim().startsWith('{'));
      if (!jsonLine) return resolve(null);

      try {
        const parsed = JSON.parse(jsonLine.trim());
        resolve(typeof parsed === 'object' && parsed !== null ? parsed : null);
      } catch {
        console.warn(
          `[credits-scraper] JSON parse failed for ${path.basename(credFile)}`
        );
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Team matching
// ---------------------------------------------------------------------------

/**
 * Return true when a scrape result belongs to the requested team.
 *
 * - The script extracts team from the page URL or localStorage and returns it
 *   as `result.team`. Exact match is authoritative.
 * - When team is absent from the result (rare edge case), accept the result
 *   as a last-resort if ok:true and credit fields are present.
 *
 * @param {object|null} parsed - Parsed JSON from the scraper script
 * @param {string} teamId      - Expected workspace ID
 * @returns {boolean}
 */
function resultMatchesTeam(parsed, teamId) {
  if (!parsed || !parsed.ok) return false;
  if (parsed.team && teamId) return parsed.team === teamId;
  // Team absent in result — accept if credit data is present
  return parsed.includedCredits != null || parsed.usedCredits != null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape credit balance for a CodeSandbox workspace.
 *
 * Tries codesandbox-web/*.json session files sequentially.
 * Stops at the first file whose dashboard shows the target team ID.
 * Returns null when no match is found or scraping is disabled.
 * Never throws (errors are caught internally or result in null).
 *
 * @param {string} teamId  - Workspace ID from meta.auth.team (e.g. ws_...)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  - Per-candidate timeout (default from env or 60s)
 * @returns {Promise<ScrapedCredits|null>}
 *
 * @typedef {object} ScrapedCredits
 * @property {number|null} included       - Included credits for the billing period
 * @property {number|null} used           - Credits consumed so far
 * @property {number|null} remaining      - max(0, included - used) or null
 * @property {string|null} billingPeriod  - e.g. "4 Aug – 4 Sep 2026"
 * @property {string|null} team           - Workspace ID confirmed by scraper
 * @property {string|null} url            - URL that was scraped
 * @property {string}      fetchedAt      - ISO timestamp
 */
async function scrapeCreditsForTeam(teamId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!teamId) return null;

  // In test mode skip real browser scraping — tests stub this module directly.
  if (process.env.NODE_ENV === 'test') return null;

  const cached = getCachedScrape(teamId);
  if (cached !== null) return cached;

  const candidates = listWebCredentialFiles();
  if (candidates.length === 0) {
    console.warn(
      '[credits-scraper] No web credential files found in',
      resolveWebCredentialsDir()
    );
    return null;
  }

  // Sequential: one Playwright/Chromium process at a time.
  // Stop at the first candidate that matches the target team.
  for (const credFile of candidates) {
    let parsed;
    try {
      parsed = await runScraperWithCredential(credFile, teamId, timeoutMs);
    } catch {
      parsed = null;
    }

    if (!parsed) continue;

    if (resultMatchesTeam(parsed, teamId)) {
      const result = {
        included:      parsed.includedCredits  ?? null,
        used:          parsed.usedCredits       ?? null,
        remaining:     parsed.remainingCredits  ?? null,
        billingPeriod: parsed.billingPeriod     ?? null,
        team:          parsed.team              ?? teamId,
        url:           parsed.url               ?? null,
        fetchedAt:     parsed.fetchedAt         ?? new Date().toISOString(),
      };
      putCachedScrape(teamId, result);
      return result;
    }

    console.log(
      `[credits-scraper] ${path.basename(credFile)} returned team=${parsed.team || 'unknown'}, want ${teamId} — skipping`
    );
  }

  console.warn(
    `[credits-scraper] No web credential matched team ${teamId} after ${candidates.length} candidates`
  );
  return null;
}

// ---------------------------------------------------------------------------
// parseCreditsFromBody — shared parsing helper
// ---------------------------------------------------------------------------

/**
 * Parse credits from dashboard body text.
 * Shared helper — mirrors the parsing logic in get-codesandbox-credits.js.
 * Kept here so unit tests can verify parsing without spawning a browser.
 *
 * @param {string} bodyText - Raw text content from the usage page
 * @returns {{ included, used, freeUsed, billingPeriod, remaining }}
 */
function parseCreditsFromBody(bodyText) {
  let included = null, used = null, freeUsed = null, billingPeriod = null;
  const period = bodyText.match(
    /(\d{1,2}\s+[A-Za-z]+)\s*[–-]\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/
  );
  if (period) billingPeriod = period[0].trim();
  const inc = bodyText.match(/Included credits\s*[:\n]*\s*(\d+)/i);
  if (inc) included = parseInt(inc[1], 10);
  const usedM = bodyText.match(/Credits used\s*[:\n]*\s*(\d+)/i);
  if (usedM) used = parseInt(usedM[1], 10);
  const freeM = bodyText.match(/(\d+)\s*free credits used/i);
  if (freeM) freeUsed = parseInt(freeM[1], 10);
  if (included == null || used == null) {
    const slash = bodyText.match(/(\d+)\s*\/\s*(\d+)\s*credits/i);
    if (slash) {
      const first = parseInt(slash[1], 10), second = parseInt(slash[2], 10);
      if (/run out of credits/i.test(bodyText) && first === second) {
        used = first; included = second;
      } else {
        used = first; included = second;
      }
    }
  }
  if (/run out of credits/i.test(bodyText) && included != null && used == null) {
    used = included;
  }
  const remaining = included != null && used != null
    ? Math.max(0, included - used)
    : null;
  return { included, used, freeUsed, billingPeriod, remaining };
}

module.exports = {
  parseCreditsFromBody,
  scrapeCreditsForTeam,
  listWebCredentialFiles,
  clearScrapeCache,
  // Exported for test inspection only:
  getCachedScrape,
  putCachedScrape,
  // Internal helpers exported for unit testing:
  resultMatchesTeam,
  runScraperWithCredential,
};
