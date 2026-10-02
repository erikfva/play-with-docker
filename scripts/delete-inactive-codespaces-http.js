#!/usr/bin/env node
'use strict';

/**
 * delete-inactive-codespaces-http.js
 *
 * Deletes all stopped (inactive) codespaces for a GitHub account using direct
 * HTTP requests to GitHub's Web UI endpoints. No Playwright or PAT needed —
 * only session cookies from a Playwright storageState JSON file.
 *
 * Flow:
 *   1. List codespaces         — GET  github.com/codespaces
 *   2. For each stopped one    — POST github.com/codespaces/{slug}  (_method=delete)
 *   3. Print summary
 *
 * Active codespaces (suspend form present in HTML) are always skipped.
 *
 * WHY "STOPPED" DETECTION WORKS WITHOUT A PAT
 * --------------------------------------------
 * GitHub does not render status keywords (Active, Stopped, etc.) in the raw
 * server-rendered HTML. The only reliable signal available without a token is
 * the presence or absence of the suspend form for a given slug:
 *
 *   present  → codespace is active / running
 *   absent   → codespace is stopped / idle / shutdown
 *
 * This matches the detection logic in refresh-codespace-http.js.
 */

const fs = require('fs');
const path = require('path');

// ── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    credentials: null,
    dryRun: false,
    debug: false,
    delayMs: 1000,
  };
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--help' || a === '-h') { args.help = true; }
    else if (a === '--credentials') { args.credentials = raw[++i]; }
    else if (a.startsWith('--credentials=')) { args.credentials = a.slice('--credentials='.length); }
    else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '--debug') { args.debug = true; }
    else if (a === '--delay') { args.delayMs = (parseInt(raw[++i], 10) || 1) * 1000; }
    else if (a.startsWith('--delay=')) { args.delayMs = (parseInt(a.slice('--delay='.length), 10) || 1) * 1000; }
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/delete-inactive-codespaces-http.js --credentials <github.json> [options]

Options:
  --credentials <path>  Playwright storageState file for GitHub. Also honors GITHUB_AUTH_FILE env.
  --dry-run             List stopped codespaces without deleting them.
  --delay <secs>        Seconds to wait between delete requests. Default: 1.
  --debug               Save HTML responses to /tmp/cs-delete-debug-*.html.

How inactive detection works:
  GitHub does not include status keywords in raw HTML. The suspend form presence
  is the only reliable signal — present = active, absent = stopped/inactive.
  Only codespaces with NO suspend form (inactive) are deleted.
`);
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

function loadCookies(statePath) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!Array.isArray(state.cookies)) throw new Error('Invalid storageState: no cookies array');
  return state.cookies
    .filter((c) => {
      const d = c.domain || '';
      return d === '.github.com' || d === 'github.com';
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function updateCookies(cookieStr, setCookieHeaders) {
  if (!setCookieHeaders || setCookieHeaders.length === 0) return cookieStr;
  const pairs = cookieStr.split('; ').filter(Boolean);
  const map = new Map(pairs.map((p) => [p.split('=')[0], p]));
  for (const header of setCookieHeaders) {
    const kv = header.split(';')[0];
    const name = kv.split('=')[0];
    map.set(name, kv);
  }
  return [...map.values()].join('; ');
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const requests = [];
const timings = {};

function startTimer(label) {
  timings[label] = { start: Date.now() };
}
function endTimer(label) {
  const t = timings[label];
  if (t) t.ms = Date.now() - t.start;
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function httpFetch(url, options, cookieJar, label) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Cookie': cookieJar.value,
    ...options.headers,
  };

  const entry = {
    ts: new Date().toISOString(),
    method: options.method || 'GET',
    url,
    label: label || '',
  };
  requests.push(entry);

  const res = await fetch(url, { ...options, redirect: 'manual', headers });

  entry.status = res.status;
  entry.statusText = res.statusText;

  const location = res.headers.get('location');
  if (location) entry.location = location;

  const setCookies = res.headers.getSetCookie?.() || [];
  if (setCookies.length > 0) cookieJar.value = updateCookies(cookieJar.value, setCookies);

  return res;
}

async function followRedirect(res, cookieJar, label) {
  const location = res.headers.get('location');
  if (!location) return null;
  const fullUrl = location.startsWith('http') ? location : `https://github.com${location}`;
  return httpFetch(fullUrl, {}, cookieJar, label);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── HTML parsing ──────────────────────────────────────────────────────────────

/**
 * Parse codespace slugs and their active/stopped state from the /codespaces HTML.
 * Active = suspend form present; stopped/inactive = suspend form absent.
 */
function parseCodespaceList(html) {
  const codespaces = [];
  const seen = new Set();

  const slugRegex = /(?:href|action)=["']\/codespaces\/([a-z0-9][a-z0-9-]+)["']/gi;
  let match;
  while ((match = slugRegex.exec(html)) !== null) {
    const slug = match[1];
    if (slug === 'templates' || slug === 'new' || seen.has(slug)) continue;
    seen.add(slug);

    const suspendForm = html.includes(`/codespaces/${slug}/suspend`);

    // Attempt to extract a display name from the nearby context.
    let name = slug;
    const ctxStart = Math.max(0, match.index - 1000);
    const ctxEnd = Math.min(html.length, match.index + 1000);
    const context = html.slice(ctxStart, ctxEnd);
    const nameMatch =
      context.match(/<span[^>]*class=["'][^"']*\bh5\b[^"']*["'][^>]*>([^<]+)</i) ||
      context.match(/class=["'][^"']*\bh5\b[^"']*["'][^>]*>\s*([^<]+)/i);
    if (nameMatch) {
      const candidate = nameMatch[1].trim();
      const skip = ['see repository', 'open in browser', 'code', 'settings', 'more', 'actions'];
      if (candidate && !skip.includes(candidate.toLowerCase())) name = candidate;
    }

    codespaces.push({ slug, name, active: suspendForm });
  }

  return codespaces;
}

/**
 * Extract hidden input fields from a form by its action URL.
 * When method is provided, only the form whose _method hidden input matches is
 * returned (GitHub renders multiple forms per slug, each with its own token).
 */
function extractFormFields(html, formAction, method = null) {
  const escaped = formAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const formRegex = new RegExp(
    `<form[^>]*action=["']${escaped}["'][^>]*>([\\s\\S]*?)</form>`,
    'gi'
  );
  let formMatch;
  while ((formMatch = formRegex.exec(html)) !== null) {
    const formBody = formMatch[1];
    const fields = {};
    const inputRegex = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi;
    const inputRegex2 = /<input[^>]*value=["']([^"']*)["'][^>]*name=["']([^"']+)["']/gi;
    let m;
    while ((m = inputRegex.exec(formBody)) !== null) fields[m[1]] = m[2];
    while ((m = inputRegex2.exec(formBody)) !== null) {
      if (!(m[2] in fields)) fields[m[2]] = m[1];
    }
    if (method === null || fields._method === method) return fields;
  }
  return null;
}

// ── Main flow ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printUsage(); return; }

  if (!args.credentials) args.credentials = process.env.GITHUB_AUTH_FILE || null;
  if (!args.credentials) throw new Error('Missing --credentials <github.json>');

  const credPath = path.resolve(args.credentials);
  if (!fs.existsSync(credPath)) throw new Error(`Credential file not found: ${credPath}`);

  const overallStart = Date.now();
  const cookieJar = { value: loadCookies(credPath) };
  console.log(`Loaded ${cookieJar.value.split(';').length} cookies from ${credPath}\n`);

  // ── Step 1: List ─────────────────────────────────────────────────────────
  startTimer('list');
  const listRes = await httpFetch('https://github.com/codespaces', {}, cookieJar, 'list');
  let listHtml = await listRes.text();
  if (listRes.status === 302) {
    const redirectRes = await followRedirect(listRes, cookieJar, 'list:redirect');
    if (redirectRes) listHtml = await redirectRes.text();
  }
  if (args.debug) fs.writeFileSync('/tmp/cs-delete-debug-list.html', listHtml);
  endTimer('list');

  const all = parseCodespaceList(listHtml);
  const active = all.filter((c) => c.active);
  const inactive = all.filter((c) => !c.active);

  console.log(`Found ${all.length} codespace(s): ${active.length} active, ${inactive.length} inactive.\n`);

  if (all.length === 0) {
    console.log('No codespaces found. Nothing to do.');
  } else {
    if (active.length > 0) {
      console.log('Active (will be skipped):');
      for (const c of active) console.log(`  • ${c.name} (${c.slug})`);
      console.log();
    }
    if (inactive.length > 0) {
      console.log(`Inactive (${args.dryRun ? 'would delete' : 'will delete'}):`);
      for (const c of inactive) console.log(`  • ${c.name} (${c.slug})`);
      console.log();
    }
  }

  if (inactive.length === 0) {
    console.log('No inactive codespaces to delete.');
    printSummary(overallStart, [], []);
    return;
  }

  if (args.dryRun) {
    console.log('[dry-run] Skipping deletions.');
    printSummary(overallStart, [], inactive.map((c) => c.slug));
    return;
  }

  // ── Step 2: Delete each inactive codespace ────────────────────────────────
  const deleted = [];
  const failed = [];

  // Keep a fresh copy of the list HTML so we always have up-to-date form tokens.
  // Re-fetch between each deletion to get a fresh authenticity_token.
  let currentListHtml = listHtml;

  for (let i = 0; i < inactive.length; i++) {
    const cs = inactive[i];

    if (i > 0) {
      // Introduce a short delay between requests to be respectful.
      await sleep(args.delayMs);

      // Re-fetch the list to get a fresh authenticity_token for this slug's form.
      startTimer(`relist:${i}`);
      const reListRes = await httpFetch('https://github.com/codespaces', {}, cookieJar, `relist:${i}`);
      currentListHtml = await reListRes.text();
      if (args.debug) fs.writeFileSync(`/tmp/cs-delete-debug-relist-${i}.html`, currentListHtml);
      endTimer(`relist:${i}`);
    }

    const deleteFields = extractFormFields(currentListHtml, `/codespaces/${cs.slug}`, 'delete');
    if (!deleteFields) {
      console.warn(`  → [${i + 1}/${inactive.length}] Could not extract delete form for ${cs.slug} — skipping.`);
      failed.push({ ...cs, error: 'form_not_found' });
      continue;
    }

    startTimer(`delete:${cs.slug}`);
    console.log(`  → [${i + 1}/${inactive.length}] Deleting ${cs.name} (${cs.slug})…`);

    const deleteRes = await httpFetch(
      `https://github.com/codespaces/${cs.slug}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://github.com/codespaces',
          'Origin': 'https://github.com',
        },
        body: new URLSearchParams(deleteFields).toString(),
      },
      cookieJar,
      `delete:${cs.slug}`
    );

    if (deleteRes.status === 302) await followRedirect(deleteRes, cookieJar, `delete:${cs.slug}:redirect`);
    endTimer(`delete:${cs.slug}`);

    const ok = deleteRes.status === 302 || deleteRes.status === 200;
    const durationMs = timings[`delete:${cs.slug}`]?.ms ?? 0;
    console.log(`     ${ok ? '✓' : '✗'} ${deleteRes.status} (${durationMs}ms)`);

    if (ok) {
      deleted.push(cs);
      // Use the redirect-followed response as the new list HTML if available,
      // otherwise the next iteration will re-fetch.
      currentListHtml = '';
    } else {
      if (args.debug) {
        fs.writeFileSync(`/tmp/cs-delete-debug-error-${cs.slug}.html`, await deleteRes.text());
      }
      failed.push({ ...cs, error: `http_${deleteRes.status}` });
    }
  }

  console.log();
  printSummary(overallStart, deleted, failed);
}

function printSummary(overallStart, deleted, failed) {
  const totalMs = Date.now() - overallStart;
  timings.total = { ms: totalMs };

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TIMINGS (ms)');
  console.log('═══════════════════════════════════════════════════════════════');
  for (const [k, v] of Object.entries(timings)) {
    if (v.ms !== undefined) console.log(`  ${k.padEnd(32)} ${String(v.ms).padStart(8)} ms`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`HTTP REQUESTS (${requests.length})`);
  console.log('═══════════════════════════════════════════════════════════════');
  for (const r of requests) {
    const status = r.status ? `${r.status}` : '---';
    console.log(`  ${r.ts}  ${r.method.padEnd(5)} ${status.padEnd(4)} ${r.label.padEnd(28)} ${r.url.slice(0, 90)}`);
    if (r.location) console.log(`  ${' '.repeat(42)} → ${r.location.slice(0, 90)}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('JSON RESULT');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(JSON.stringify({
    ok: failed.length === 0,
    totalMs,
    deleted: deleted.map ? deleted.map((c) => ({ slug: c.slug, name: c.name })) : deleted,
    deletedCount: Array.isArray(deleted) ? deleted.length : 0,
    failed: failed.map ? failed.map((c) => ({ slug: c.slug, name: c.name, error: c.error })) : failed,
    failedCount: Array.isArray(failed) ? failed.length : 0,
    requestCount: requests.length,
  }, null, 2));
}

main().catch((err) => {
  console.error('\nERROR:', err.message || err);
  if (err.stack && process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
