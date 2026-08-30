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
      // The JSON output is pretty-printed across multiple lines, starting with
      // a line that begins with '{'. Find the character offset of the last such
      // line and take everything from there — that is the full JSON object.
      const jsonStart = (() => {
        let pos = -1;
        let search = 0;
        while (search < stdout.length) {
          const nl = stdout.indexOf('\n', search);
          const lineStart = search;
          const lineEnd = nl === -1 ? stdout.length : nl;
          const line = stdout.slice(lineStart, lineEnd).trimStart();
          if (line.startsWith('{')) pos = lineStart;
          search = lineEnd + 1;
        }
        return pos;
      })();
      if (jsonStart === -1) return resolve(null);

      const jsonStr = stdout.slice(jsonStart).trim();

      try {
        const parsed = JSON.parse(jsonStr);
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
// Result builder
// ---------------------------------------------------------------------------

/** Normalise a raw scraper script result into the ScrapedCredits shape. */
function buildResult(parsed, teamId) {
  return {
    included:      parsed.includedCredits  ?? null,
    used:          parsed.usedCredits       ?? null,
    remaining:     parsed.remainingCredits  ?? null,
    billingPeriod: parsed.billingPeriod     ?? null,
    team:          parsed.team              ?? teamId,
    url:           parsed.url               ?? null,
    fetchedAt:     parsed.fetchedAt         ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape credit balance for a CodeSandbox workspace.
 *
 * When `opts.credentialHint` is provided (the basename of the API token file,
 * e.g. "vm-manager232.json"), the scraper first tries the file with the same
 * name in the web-credentials directory. This avoids iterating all candidates
 * when the naming convention matches (API token file and web session file share
 * the same basename). Falls back to sequential search if the hint file is
 * absent or does not match the target team.
 *
 * Returns null when no match is found or scraping is disabled.
 * Never throws (errors are caught internally or result in null).
 *
 * @param {string} teamId  - Workspace ID from meta.auth.team (e.g. ws_...)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]      - Per-candidate timeout (default from env or 60s)
 * @param {string} [opts.credentialHint] - Basename of the API token file to try first
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
async function scrapeCreditsForTeam(teamId, { timeoutMs = DEFAULT_TIMEOUT_MS, credentialHint } = {}) {
  if (!teamId) return null;

  // In test mode skip real browser scraping — tests stub this module directly.
  if (process.env.NODE_ENV === 'test') return null;

  const cached = getCachedScrape(teamId);
  if (cached !== null) return cached;

  const webDir = resolveWebCredentialsDir();

  // --- hint-first: try the same-named file in codesandbox-web/ directly ----
  // When the API token file and the web session file share the same basename
  // (e.g. codesandbox/vm-manager232.json → codesandbox-web/vm-manager232.json),
  // skip the sequential candidate search entirely.
  if (credentialHint) {
    const hintBasename = path.basename(credentialHint);
    const hintFile = path.join(webDir, hintBasename);
    if (fs.existsSync(hintFile)) {
      let parsed;
      try {
        parsed = await runScraperWithCredential(hintFile, teamId, timeoutMs);
      } catch {
        parsed = null;
      }
      if (parsed && resultMatchesTeam(parsed, teamId)) {
        const result = buildResult(parsed, teamId);
        putCachedScrape(teamId, result);
        return result;
      }
      if (parsed) {
        console.log(
          `[credits-scraper] hint ${hintBasename} returned team=${parsed.team || 'unknown'}, want ${teamId} — falling back to full search`
        );
      }
    } else {
      console.log(
        `[credits-scraper] hint file ${hintBasename} not found in ${webDir} — falling back to full search`
      );
    }
  }

  // --- fallback: sequential search across all candidates -------------------
  const candidates = listWebCredentialFiles();
  if (candidates.length === 0) {
    console.warn(
      '[credits-scraper] No web credential files found in',
      webDir
    );
    return null;
  }

  // Skip the hint file if we already tried it above
  const hintPath = credentialHint ? path.join(webDir, path.basename(credentialHint)) : null;

  for (const credFile of candidates) {
    if (hintPath && credFile === hintPath) continue; // already tried

    let parsed;
    try {
      parsed = await runScraperWithCredential(credFile, teamId, timeoutMs);
    } catch {
      parsed = null;
    }

    if (!parsed) continue;

    if (resultMatchesTeam(parsed, teamId)) {
      const result = buildResult(parsed, teamId);
      putCachedScrape(teamId, result);
      return result;
    }

    console.log(
      `[credits-scraper] ${path.basename(credFile)} returned team=${parsed.team || 'unknown'}, want ${teamId} — skipping`
    );
  }

  console.warn(
    `[credits-scraper] No web credential matched team ${teamId} after searching ${candidates.length} candidate(s)`
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
