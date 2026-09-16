#!/usr/bin/env node
'use strict';

/**
 * refresh-codespace-http.js
 *
 * Same VM refresh flow as refresh-codespace.js, but uses direct HTTP requests
 * to GitHub's Web UI endpoints instead of browser automation. No Chromium
 * needed — just cookies + CSRF tokens extracted from HTML.
 *
 * Flow:
 *   1. List current codespaces        — GET  github.com/codespaces
 *   2. Delete the first one            — POST github.com/codespaces/{slug}
 *   3. Create a new blank codespace    — POST github.com/codespaces
 *   4. Wait for codespace to be ready  — GET  github.com/codespaces (polls HTML page)
 *      (polls until the suspend form for the slug appears in the HTML)
 *      Suspend form present = active = Docker initialized. No PAT needed.
 *   5. Stop the new codespace          — POST github.com/codespaces/{slug}/suspend
 *   6. Return the new VM information
 *
 * All timing and endpoint details are tracked and printed.
 *
 * WHY THE PROVISION WAIT IS REQUIRED
 * -----------------------------------
 * When GitHub creates a codespace via the Web UI (step 3), the actual
 * devcontainer provisioning — installing Docker, running post-create hooks,
 * starting the Docker engine — happens asynchronously.  The create POST
 * returns (and the slug is assigned) before that work is done.
 *
 * If the codespace is stopped too early, the Docker engine and devcontainer
 * setup never complete.  The backend orchestrator later adopts this codespace
 * and runs `docker system prune -af` as its initialization check; that command
 * fails because Docker is not running, so every subsequent `docker` command in
 * the session will also fail.
 *
 * Waiting for the suspend form to appear on GET /codespaces (session cookies,
 * no PAT needed) guarantees the same "fully provisioned" baseline that the
 * Playwright browser flow achieves by waiting for the editor URL to load.
 * Per research: status keywords (Active/Stopped) are NOT in raw HTML — only
 * the suspend form presence is a reliable active/inactive signal.
 */

const fs = require('fs');
const path = require('path');

// ── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    credentials: null,
    keepExisting: false,
    debug: false,
    // How long (seconds) to wait for the codespace to become active.
    provisionTimeout: 300,
    // Poll interval (seconds) when waiting for active state.
    pollInterval: 10,
  };
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--credentials') args.credentials = raw[++i];
    else if (a.startsWith('--credentials=')) args.credentials = a.slice('--credentials='.length);
    else if (a === '--keep-existing') args.keepExisting = true;
    else if (a === '--debug') args.debug = true;
    else if (a === '--provision-timeout') args.provisionTimeout = parseInt(raw[++i], 10) || 300;
    else if (a.startsWith('--provision-timeout=')) args.provisionTimeout = parseInt(a.slice('--provision-timeout='.length), 10) || 300;
    else if (a === '--poll-interval') args.pollInterval = parseInt(raw[++i], 10) || 10;
    else if (a.startsWith('--poll-interval=')) args.pollInterval = parseInt(a.slice('--poll-interval='.length), 10) || 10;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/refresh-codespace-http.js --credentials <github.json> [--keep-existing] [--debug]

Options:
  --credentials <path>        Playwright storageState file for GitHub. Also honors GITHUB_AUTH_FILE env.
  --keep-existing             Skip deletion; only create + stop.
  --debug                     Save HTML responses to /tmp/cs-http-debug-*.html
  --provision-timeout <secs>  Max seconds to wait for the new codespace to become active
                              before stopping it. Default: 300 (5 min). Set to 0 to skip.
                              Polls GET /codespaces for the suspend form — no PAT needed.
                              Suspend form present = active = Docker fully initialized.
  --poll-interval <secs>      Polling interval in seconds. Default: 10.

Why provision-timeout matters:
  GitHub provisions codespaces asynchronously — Docker and devcontainer setup run
  after the create POST returns. The script polls the /codespaces page and waits
  for the suspend form to appear (suspend form present = codespace active = Docker
  initialized). Stopping before that leaves Docker uninitialized, causing the
  backend adoption to fail. Status keywords (Active/Stopped) are NOT in the raw
  HTML — only the suspend form presence is a reliable signal (per research).
`);
}

// ── Cookie loading ────────────────────────────────────────────────────────────

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

/**
 * Update the cookie string with Set-Cookie response headers.
 * Replaces matching cookie names, keeps the rest.
 */
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

// ── Provision wait ────────────────────────────────────────────────────────────

/**
 * Check whether a codespace is active by looking for its suspend form in the
 * raw HTML of the /codespaces page.
 *
 * Per research-lifecycle.md: GitHub does NOT render status keywords (Active,
 * Stopped, etc.) in the raw server-rendered HTML. The only reliable signal is
 * the presence or absence of the suspend form:
 *
 *   present  → codespace is active / running / provisioning
 *   absent   → codespace is stopped / idle / shutdown
 *
 * api.github.com returns 401 with session cookies (requires a PAT), so the
 * REST API cannot be used for status polling without a token.
 */
function isCodespaceActive(html, slug) {
  return html.includes(`/codespaces/${slug}/suspend`);
}

/**
 * Poll GET /codespaces (using session cookies, no PAT needed) until the
 * suspend form for the new slug appears in the HTML.
 *
 * Suspend form present = codespace is active = devcontainer and Docker engine
 * are fully initialized. This is the HTTP equivalent of the Playwright script
 * waiting for the editor page (*.github.dev) to load.
 *
 * Returns { status: 'active', html } when the suspend form is found,
 * or { status: null, html: null } on timeout.
 */
async function waitForActiveStatus(slug, cookieJar, { timeoutMs = 300_000, pollIntervalMs = 10_000, requestLog } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  console.log(`  → polling /codespaces for suspend form of ${slug} (timeout ${timeoutMs / 1000}s, interval ${pollIntervalMs / 1000}s)…`);

  while (Date.now() < deadline) {
    attempt++;
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    const url = 'https://github.com/codespaces';
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Cookie': cookieJar.value,
        },
        redirect: 'manual',
      });
    } catch (fetchErr) {
      console.warn(`  → poll attempt ${attempt}: fetch error (${fetchErr.message}), retrying…`);
      continue;
    }

    if (requestLog) {
      requestLog.push({
        ts: new Date().toISOString(),
        method: 'GET',
        url,
        status: res.status,
        label: `provision-poll:${attempt}`,
      });
    }

    const setCookies = res.headers.getSetCookie?.() || [];
    if (setCookies.length > 0) cookieJar.value = updateCookies(cookieJar.value, setCookies);

    if (!res.ok && res.status !== 302) {
      console.warn(`  → poll attempt ${attempt}: HTTP ${res.status}, retrying…`);
      continue;
    }

    const html = await res.text();
    const active = isCodespaceActive(html, slug);
    console.log(`  → [poll ${attempt}] suspend form ${active ? 'PRESENT (active)' : 'absent (still provisioning)'}`);

    if (active) {
      console.log(`  → codespace is active after ${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s\n`);
      return { status: 'active', html };
    }
  }

  console.warn(`  → provision wait timed out after ${timeoutMs / 1000}s. Proceeding with stop anyway.`);
  return { status: null, html: null };
}

// ── HTTP fetch with tracking ──────────────────────────────────────────────────

const requests = [];
const timings = {};

function startTimer(label) {
  timings[label] = { start: Date.now() };
  console.log(`[timing] ${label} started`);
}
function endTimer(label) {
  const t = timings[label];
  if (t) {
    t.ms = Date.now() - t.start;
    console.log(`[timing] ${label} — ${t.ms}ms`);
  }
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

  const res = await fetch(url, {
    ...options,
    redirect: 'manual',
    headers,
  });

  entry.status = res.status;
  entry.statusText = res.statusText;

  const location = res.headers.get('location');
  if (location) entry.location = location;

  const setCookies = res.headers.getSetCookie?.() || [];
  if (setCookies.length > 0) cookieJar.value = updateCookies(cookieJar.value, setCookies);

  return res;
}

/**
 * Follow a 302 redirect (GET the Location header).
 */
async function followRedirect(res, cookieJar, label) {
  const location = res.headers.get('location');
  if (!location) return null;
  const fullUrl = location.startsWith('http') ? location : `https://github.com${location}`;
  return httpFetch(fullUrl, {}, cookieJar, label);
}

// ── HTML parsing helpers ──────────────────────────────────────────────────────

/**
 * Parse codespace list from the /codespaces HTML page.
 * Status is determined by suspend form presence: present = active, absent = stopped.
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

    codespaces.push({ slug, name, status: suspendForm ? 'active' : 'stopped' });
  }

  return codespaces;
}

/**
 * Extract hidden input fields from a form by its action URL.
 * When method is provided, only the form whose _method hidden input matches is
 * returned (GitHub renders multiple forms with the same action but different
 * _method values, each with its own authenticity_token).
 * When method is null, the first matching form is returned.
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

/**
 * Extract the new codespace slug from the create response HTML.
 * Looks for {slug}.github.dev or /codespaces/{slug} patterns.
 */
function extractNewSlug(html) {
  const devMatch = html.match(/https?:\/\/([a-z0-9][a-z0-9-]+)\.github\.dev/i);
  if (devMatch) return devMatch[1];
  const csMatch = html.match(/\/codespaces\/([a-z0-9][a-z0-9-]+)/i);
  if (csMatch && csMatch[1] !== 'templates') return csMatch[1];
  return null;
}

function displayNameFromSlug(slug) {
  const m = slug.match(/^(.*)-[a-z0-9]{10,}$/);
  return (m ? m[1] : slug).replace(/-/g, ' ');
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

  let deleted = null;
  let newSlug = null;

  // ── Step 1: List ─────────────────────────────────────────────────────────
  startTimer('list');
  const listRes = await httpFetch('https://github.com/codespaces', {}, cookieJar, 'list');
  let listHtml = await listRes.text();
  if (listRes.status === 302) {
    const redirectRes = await followRedirect(listRes, cookieJar, 'list:redirect');
    if (redirectRes) listHtml = await redirectRes.text();
  }
  if (args.debug) fs.writeFileSync('/tmp/cs-http-debug-list.html', listHtml);
  const existing = parseCodespaceList(listHtml);
  endTimer('list');
  console.log(`  → found ${existing.length} codespaces: ${existing.map((c) => `${c.name} (${c.slug}) - ${c.status}`).join(', ')}\n`);

  // ── Step 2: Delete first ──────────────────────────────────────────────────
  if (!args.keepExisting && existing.length > 0) {
    const first = existing[0];

    const deleteFields = extractFormFields(listHtml, `/codespaces/${first.slug}`, 'delete');
    if (!deleteFields) throw new Error(`Could not extract delete form for ${first.slug}`);

    startTimer('delete');
    const deleteRes = await httpFetch(
      `https://github.com/codespaces/${first.slug}`,
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
      'delete'
    );

    if (deleteRes.status === 302) await followRedirect(deleteRes, cookieJar, 'delete:redirect');

    endTimer('delete');
    const ok = deleteRes.status === 302 || deleteRes.status === 200;
    deleted = { name: first.name, slug: first.slug, status: ok ? 'deleted' : `error:${deleteRes.status}` };
    console.log(`  → delete ${first.name} (${first.slug}): ${deleteRes.status} ${ok ? 'OK' : 'FAILED'}\n`);
  } else {
    console.log('  → no codespaces to delete (or --keep-existing)\n');
  }

  // ── Step 3: Create ────────────────────────────────────────────────────────
  startTimer('create');

  const templatesRes = await httpFetch(
    'https://github.com/codespaces/templates',
    {},
    cookieJar,
    'create:get-templates'
  );
  let templatesHtml = await templatesRes.text();
  if (templatesRes.status === 302) {
    const tr = await followRedirect(templatesRes, cookieJar, 'create:templates-redirect');
    if (tr) templatesHtml = await tr.text();
  }
  if (args.debug) fs.writeFileSync('/tmp/cs-http-debug-templates.html', templatesHtml);

  // Per-form authenticity_token is required — the session-level meta token causes 422.
  const createFields = extractFormFields(templatesHtml, '/codespaces') ||
    extractFormFields(templatesHtml, '/codespaces/new');
  if (!createFields) throw new Error('Could not extract create form from /codespaces/templates');

  console.log(`  → found create form with fields: ${Object.keys(createFields).join(', ')}`);
  if (args.debug) console.log(`  → form data: ${JSON.stringify(createFields)}`);

  const createRes = await httpFetch(
    'https://github.com/codespaces',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://github.com/codespaces/templates',
        'Origin': 'https://github.com',
      },
      body: new URLSearchParams(createFields).toString(),
    },
    cookieJar,
    'create:post'
  );

  let createHtml = await createRes.text();
  if (args.debug) fs.writeFileSync('/tmp/cs-http-debug-create-response.html', createHtml);

  newSlug = extractNewSlug(createHtml);

  if (!newSlug && createRes.status === 302) {
    const cr = await followRedirect(createRes, cookieJar, 'create:redirect');
    if (cr) {
      createHtml = await cr.text();
      if (args.debug) fs.writeFileSync('/tmp/cs-http-debug-create-redirect.html', createHtml);
      newSlug = extractNewSlug(createHtml);
    }
  }

  // Slug may not appear in create response — poll until the new codespace appears.
  if (!newSlug) {
    console.log('  → slug not in create response, polling /codespaces…');
    const originalSlugs = new Set(existing.map((c) => c.slug));
    for (let attempt = 1; attempt <= 6; attempt++) {
      if (attempt > 1) {
        console.log(`  → relist attempt ${attempt}, waiting 5s…`);
        await new Promise((r) => setTimeout(r, 5000));
      }
      const reListRes = await httpFetch('https://github.com/codespaces', {}, cookieJar, `create:relist:${attempt}`);
      const reListHtml = await reListRes.text();
      const newOnes = parseCodespaceList(reListHtml).filter((c) => !originalSlugs.has(c.slug));
      if (newOnes.length > 0) {
        newSlug = newOnes[0].slug;
        break;
      }
      console.log(`  → no new codespace yet (attempt ${attempt}/6)`);
    }
  }

  endTimer('create');
  if (!newSlug) throw new Error('Could not determine the new codespace slug after create');
  console.log(`  → created ${displayNameFromSlug(newSlug)} (${newSlug})\n`);

  // ── Step 4: Wait for provisioning ────────────────────────────────────────
  // Poll GET /codespaces until the suspend form for the new slug appears in the
  // HTML. Suspend form present = codespace fully active = Docker initialized.
  // Per research-lifecycle.md: status keywords are NOT in raw HTML; the suspend
  // form is the only reliable signal available without a PAT.
  startTimer('provision-wait');
  let finalProvisionState = null;
  let provisionHtml = null;

  if (args.provisionTimeout > 0) {
    const result = await waitForActiveStatus(newSlug, cookieJar, {
      timeoutMs: args.provisionTimeout * 1000,
      pollIntervalMs: args.pollInterval * 1000,
      requestLog: requests,
    });
    finalProvisionState = result.status;
    provisionHtml = result.html;
  } else {
    console.warn('  → WARNING: provision wait disabled (--provision-timeout 0). Docker initialization not confirmed.');
  }
  endTimer('provision-wait');

  // ── Step 5: Stop ──────────────────────────────────────────────────────────
  // Reuse the last provision-poll HTML on the first attempt (it already has the
  // suspend form with a fresh authenticity_token), avoiding an extra GET request.
  startTimer('stop');
  let stopStatus = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    let stopListHtml;
    if (attempt === 1 && provisionHtml) {
      stopListHtml = provisionHtml;
    } else {
      const stopListRes = await httpFetch('https://github.com/codespaces', {}, cookieJar, `stop:get-list:${attempt}`);
      stopListHtml = await stopListRes.text();
    }

    const stopFields = extractFormFields(stopListHtml, `/codespaces/${newSlug}/suspend`);
    if (!stopFields) throw new Error(`Could not extract suspend form for ${newSlug}`);

    const stopRes = await httpFetch(
      `https://github.com/codespaces/${newSlug}/suspend`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://github.com/codespaces',
          'Origin': 'https://github.com',
        },
        body: new URLSearchParams(stopFields).toString(),
      },
      cookieJar,
      `stop:post-suspend:${attempt}`
    );

    stopStatus = stopRes.status;

    if (stopRes.status === 302) {
      await followRedirect(stopRes, cookieJar, 'stop:redirect');
      break;
    }

    if (stopRes.status === 422 && attempt < 3) {
      console.log(`  → stop attempt ${attempt}: ${stopRes.status} (retrying in 5s…)`);
      await new Promise((r) => setTimeout(r, 5000));
    } else {
      if (args.debug) fs.writeFileSync(`/tmp/cs-http-debug-stop-error-${attempt}.html`, await stopRes.text());
      break;
    }
  }

  endTimer('stop');
  const stopOk = stopStatus === 302;
  console.log(`  → stop response: ${stopStatus} (${stopOk ? 'success' : 'failed'})\n`);

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalMs = Date.now() - overallStart;
  timings.total = { ms: totalMs };

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TIMINGS (ms)');
  console.log('═══════════════════════════════════════════════════════════════');
  for (const [k, v] of Object.entries(timings)) {
    console.log(`  ${k.padEnd(22)} ${String(v.ms).padStart(8)} ms`);
  }

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`HTTP REQUESTS (${requests.length})`);
  console.log('═══════════════════════════════════════════════════════════════');
  for (const r of requests) {
    const status = r.status ? `${r.status}` : '---';
    console.log(`  ${r.ts}  ${r.method.padEnd(5)} ${status.padEnd(4)} ${r.label.padEnd(24)} ${r.url.slice(0, 100)}`);
    if (r.location) console.log(`  ${' '.repeat(42)} → ${r.location.slice(0, 100)}`);
  }

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log('UNIQUE ENDPOINTS');
  console.log('═══════════════════════════════════════════════════════════════');
  const eps = new Map();
  for (const r of requests) {
    try {
      const u = new URL(r.url);
      const key = `${r.method} ${u.hostname}${u.pathname}`;
      if (!eps.has(key)) eps.set(key, { method: r.method, host: u.hostname, path: u.pathname, count: 0, statuses: new Set() });
      const ep = eps.get(key);
      ep.count++;
      if (r.status) ep.statuses.add(r.status);
    } catch {}
  }
  for (const [, ep] of eps) {
    console.log(`  ${ep.method.padEnd(6)} ${ep.host}${ep.path}  [${[...ep.statuses].join(',') || '---'}]  ×${ep.count}`);
  }

  // ── JSON output ───────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('JSON RESULT');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(JSON.stringify({
    ok: true,
    timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, v.ms])),
    totalMs,
    deleted,
    name: displayNameFromSlug(newSlug),
    slug: newSlug,
    url: `https://github.com/codespaces/${newSlug}`,
    editorUrl: `https://${newSlug}.github.dev/`,
    machine: '2-core • 8GB RAM • 32GB',
    status: stopOk ? 'stopped' : 'failed',
    provisionState: finalProvisionState,
    note: (() => {
      if (!stopOk) return 'Suspend POST did not return 302; codespace may still be running.';
      if (finalProvisionState === 'active') return 'Codespace was fully active (suspend form confirmed) before stop — Docker and devcontainer initialized.';
      return 'Provision wait timed out or was disabled; Docker initialization not confirmed.';
    })(),
    endpoints: [...eps.values()].map((e) => ({
      method: e.method,
      host: e.host,
      path: e.path,
      count: e.count,
      statuses: [...e.statuses],
    })),
    requestCount: requests.length,
  }, null, 2));
}

main().catch((err) => {
  console.error('\nERROR:', err.message || err);
  if (err.stack && process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
