'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Parse credits from dashboard body text. Handles:
 * - "Included credits 400" / "Credits used 403"
 * - "400 / 400 credits" (sidebar) + "You have run out of credits"
 * - "8 August – 8 September 2026" period
 */
function parseCreditsFromBody(bodyText) {
  let included = null, used = null, freeUsed = null, billingPeriod = null;
  const period = bodyText.match(/(\d{1,2}\s+[A-Za-z]+)\s*[–-]\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
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
      if (/run out of credits/i.test(bodyText) && first === second) { used = first; included = second; }
      else { used = first; included = second; }
    }
  }
  if (/run out of credits/i.test(bodyText) && included != null && used == null) used = included;
  const remaining = (included != null && used != null) ? Math.max(0, included - used) : null;
  return { included, used, freeUsed, billingPeriod, remaining };
}

function candidateAuthFiles() {
  const candidates = [];
  if (process.env.GITHUB_AUTH_FILE && fs.existsSync(process.env.GITHUB_AUTH_FILE)) {
    candidates.push(process.env.GITHUB_AUTH_FILE);
  }
  // Known S3 mounts for this deployment
  const s3Candidates = [
    '/mnt/s3/github/vm-manager123/github.json',
    '/mnt/s3/github/vm-manager123-1/github.json',
    '/mnt/s3/github/vm-manager232/github.json',
    '/mnt/s3/github/vm-manager232-1/github.json',
    '/mnt/s3/github/vm-manager234/github.json',
  ];
  for (const p of s3Candidates) {
    if (fs.existsSync(p) && !candidates.includes(p)) candidates.push(p);
  }
  // Also check credentials dir for any github.json
  try {
    const dir = '/config/workspace/play-with-docker/credentials';
    if (fs.existsSync(dir)) {
      // not exhaustive, just check default profile dir fallback is handled by github-browser
    }
  } catch {}
  return candidates;
}

/**
 * Scrape credits for a given team (workspace) id.
 * Spawns scripts/get-codesandbox-credits.js with GITHUB_AUTH_FILE and --workspace.
 * Returns { used, included, remaining, billingPeriod, url, team } or null if not available.
 * Best-effort, never throws (returns null on failure).
 */
const scrapeCache = new Map(); // teamId -> { value, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000;

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
  scrapeCache.set(teamId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function clearScrapeCache() {
  scrapeCache.clear();
}

async function scrapeCreditsForTeam(teamId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!teamId) return null;

  // In test mode, skip real browser scraping (fast, deterministic). Tests can stub this module.
  if (process.env.NODE_ENV === 'test' || process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED === '0') {
    return null;
  }

  const cached = getCachedScrape(teamId);
  if (cached !== null) return cached;

  const candidates = candidateAuthFiles();
  if (candidates.length === 0) {
    putCachedScrape(teamId, null);
    return null;
  }

  // Try candidates in parallel, return first success (faster than sequential 5*45s)
  const promises = candidates.map(authFile =>
    runScraperWithAuth(authFile, teamId, timeoutMs)
      .then(result => {
        if (result && (typeof result.usedCredits === 'number' || typeof result.includedCredits === 'number')) {
          if (result.team && result.team !== teamId) return null;
          return {
            used: result.usedCredits,
            included: result.includedCredits,
            remaining: result.remainingCredits,
            billingPeriod: result.billingPeriod,
            freeUsed: result.freeCreditsUsed,
            url: result.url,
            team: result.team || teamId,
          };
        }
        if (result && result.ok) {
          return {
            used: result.usedCredits,
            included: result.includedCredits,
            remaining: result.remainingCredits,
            billingPeriod: result.billingPeriod,
            url: result.url,
            team: result.team || teamId,
          };
        }
        return null;
      })
      .catch(() => null)
  );

  const results = await Promise.all(promises);
  const hit = results.find(r => r && (r.used != null || r.included != null));
  const value = hit || null;
  putCachedScrape(teamId, value);
  return value;
}

function runScraperWithAuth(authFile, teamId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const script = path.resolve(__dirname, '../../../../scripts/get-codesandbox-credits.js');
    const args = ['--credentials', authFile, '--workspace', teamId, '--json', '--headful'];
    // Use xvfb-run if available and no DISPLAY
    const useXvfb = !process.env.DISPLAY;
    const cmd = useXvfb ? 'xvfb-run' : 'node';
    const cmdArgs = useXvfb
      ? ['-a', '--server-args=-screen 0 1366x850x24', 'node', script, ...args]
      : [script, ...args];

    const child = spawn(cmd, cmdArgs, {
      env: { ...process.env, GITHUB_AUTH_FILE: authFile },
      timeout: timeoutMs + 5000,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(null);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve(null);
      // stdout contains dotenv logs + JSON; extract JSON object
      const jsonStart = stdout.indexOf('{');
      const jsonEnd = stdout.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd === -1) return resolve(null);
      const jsonStr = stdout.slice(jsonStart, jsonEnd + 1);
      try {
        const parsed = JSON.parse(jsonStr);
        // The script outputs { ok, team, url, billingPeriod, includedCredits, usedCredits, ... }
        // We need to ensure it has ok=true
        if (parsed && typeof parsed === 'object') {
          resolve(parsed);
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
  });
}

module.exports = { parseCreditsFromBody, scrapeCreditsForTeam, candidateAuthFiles, clearScrapeCache, getCachedScrape, putCachedScrape };
