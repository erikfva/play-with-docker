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
 *   1. List current codespaces     — GET  github.com/codespaces
 *   2. Delete the first one         — POST github.com/codespaces/{slug}
 *   3. Create a new blank codespace — POST github.com/codespaces
 *   4. Stop the new codespace       — POST github.com/codespaces/{slug}/suspend
 *   5. Return the new VM information
 *
 * All timing and endpoint details are tracked and printed.
 */

const fs = require('fs');
const path = require('path');

// ── Args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { credentials: null, keepExisting: false, debug: false, stopDelay: 5 };
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--credentials') args.credentials = raw[++i];
    else if (a.startsWith('--credentials=')) args.credentials = a.slice('--credentials='.length);
    else if (a === '--keep-existing') args.keepExisting = true;
    else if (a === '--debug') args.debug = true;
    else if (a === '--stop-delay') args.stopDelay = parseInt(raw[++i], 10) || 0;
    else if (a.startsWith('--stop-delay=')) args.stopDelay = parseInt(a.slice('--stop-delay='.length), 10) || 0;
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
  --credentials <path>   Playwright storageState file for GitHub. Also honors GITHUB_AUTH_FILE env.
  --keep-existing        Skip deletion; only create + stop.
  --debug                Save HTML responses to /tmp/cs-http-debug-*.html
  --stop-delay <secs>    Wait N seconds after create before suspend (lets codespace provision). Default: 5
`);
}

// ── Cookie loading ──────────────────────────────────────────────────────────

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
 * Simple approach: replace matching cookie names, keep the rest.
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

// ── HTTP fetch with tracking ─────────────────────────────────────────────────

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

  // Capture Location header for redirects
  const location = res.headers.get('location');
  if (location) entry.location = location;

  // Update cookies from Set-Cookie headers
  const setCookies = res.headers.getSetCookie?.() || [];
  if (setCookies.length > 0) {
    cookieJar.value = updateCookies(cookieJar.value, setCookies);
  }

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

// ── HTML parsing helpers ────────────────────────────────────────────────────

/**
 * Extract CSRF token from HTML (meta tag or hidden input).
 */
function extractCsrfToken(html) {
  // <meta name="csrf-token" content="..." />
  const meta = html.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i);
  if (meta) return meta[1];
  // <input ... name="authenticity_token" ... value="..." />
  const input = html.match(/<input[^>]*name=["']authenticity_token["'][^>]*value=["']([^"']+)["']/i);
  if (input) return input[1];
  // Try reversed attribute order: value before name
  const input2 = html.match(/<input[^>]*value=["']([^"']+)["'][^>]*name=["']authenticity_token["']/i);
  if (input2) return input2[1];
  return null;
}

/**
 * Parse codespace list from the /codespaces HTML page.
 * Status is determined by suspend form presence: present = active, absent = stopped.
 */
function parseCodespaceList(html) {
  const codespaces = [];
  const seen = new Set();

  // Find all unique slugs from href and action attributes
  const slugRegex = /(?:href|action)=["']\/codespaces\/([a-z0-9][a-z0-9-]+)["']/gi;
  let match;
  while ((match = slugRegex.exec(html)) !== null) {
    const slug = match[1];
    // Filter out non-codespace entries: "templates", "new"
    if (slug === 'templates' || slug === 'new' || seen.has(slug)) continue;
    seen.add(slug);

    // Status: check if the suspend form is present for this slug
    const suspendForm = html.includes(`/codespaces/${slug}/suspend`);

    // Display name: look for span.h5 near the slug
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
 * Extract all hidden input fields from a form matching the given action.
 * Returns { name: value } pairs.
 */
function extractFormFields(html, formAction) {
  // Find the form with the matching action
  const escapedAction = formAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const formRegex = new RegExp(
    `<form[^>]*action=["']${escapedAction}["'][^>]*>([\\s\\S]*?)</form>`,
    'i'
  );
  const formMatch = html.match(formRegex);
  if (!formMatch) return null;

  const formBody = formMatch[1];
  const fields = {};
  const inputRegex = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi;
  const inputRegex2 = /<input[^>]*value=["']([^"']*)["'][^>]*name=["']([^"']+)["']/gi;
  let m;
  while ((m = inputRegex.exec(formBody)) !== null) {
    fields[m[1]] = m[2];
  }
  while ((m = inputRegex2.exec(formBody)) !== null) {
    if (!(m[2] in fields)) fields[m[2]] = m[1];
  }
  return fields;
}

/**
 * Find a specific form's fields by action URL and _method value.
 * GitHub renders multiple forms with the same action but different _method
 * (delete, patch, etc.). Each has its own authenticity_token.
 */
function findFormFields(html, slug, method) {
  const action = `/codespaces/${slug}`;
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match all forms with this action
  const formRegex = new RegExp(
    `<form[^>]*action=["']${escaped}["'][^>]*>([\\s\\S]*?)</form>`,
    'gi'
  );
  let formMatch;
  while ((formMatch = formRegex.exec(html)) !== null) {
    const formBody = formMatch[1];
    // Extract all inputs
    const fields = {};
    const inputRegex = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi;
    const inputRegex2 = /<input[^>]*value=["']([^"']*)["'][^>]*name=["']([^"']+)["']/gi;
    let m;
    while ((m = inputRegex.exec(formBody)) !== null) {
      fields[m[1]] = m[2];
    }
    while ((m = inputRegex2.exec(formBody)) !== null) {
      if (!(m[2] in fields)) fields[m[2]] = m[1];
    }
    // Check if this form's _method matches
    if (fields._method === method) {
      return fields;
    }
  }
  return null;
}

/**
 * Extract the new codespace slug from the create response HTML.
 * Looks for {slug}.github.dev or /codespaces/{slug} patterns.
 */
function extractNewSlug(html) {
  // Look for *.github.dev hostname
  const devMatch = html.match(/https?:\/\/([a-z0-9][a-z0-9-]+)\.github\.dev/i);
  if (devMatch) return devMatch[1];
  // Look for /codespaces/{slug} that's not "templates"
  const csMatch = html.match(/\/codespaces\/([a-z0-9][a-z0-9-]+)/i);
  if (csMatch && csMatch[1] !== 'templates') return csMatch[1];
  return null;
}

function displayNameFromSlug(slug) {
  const m = slug.match(/^(.*)-[a-z0-9]{10,}$/);
  return (m ? m[1] : slug).replace(/-/g, ' ');
}

// ── Main flow ───────────────────────────────────────────────────────────────

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

  // ── Step 1: List ────────────────────────────────────────────────────────
  startTimer('list');
  const listRes = await httpFetch('https://github.com/codespaces', {}, cookieJar, 'list');
  let listHtml = await listRes.text();
  if (listRes.status === 302) {
    const redirectRes = await followRedirect(listRes, cookieJar, 'list:redirect');
    if (redirectRes) {
      listHtml = await redirectRes.text();
    }
  }
  if (args.debug) fs.writeFileSync('/tmp/cs-http-debug-list.html', listHtml);
  const existing = parseCodespaceList(listHtml);
  endTimer('list');
  console.log(`  → found ${existing.length} codespaces: ${existing.map((c) => `${c.name} (${c.slug}) - ${c.status}`).join(', ')}\n`);

  // ── Step 2: Delete first ────────────────────────────────────────────────
  if (!args.keepExisting && existing.length > 0) {
    const first = existing[0];

    // Extract the per-form token from the delete form (_method=delete)
    let deleteFields = findFormFields(listHtml, first.slug, 'delete');
    if (!deleteFields) {
      // Fallback to meta tag token
      const metaToken = extractCsrfToken(listHtml);
      if (!metaToken) throw new Error('Could not extract CSRF token for delete');
      deleteFields = { authenticity_token: metaToken, _method: 'delete' };
    }

    startTimer('delete');
    const deleteBody = new URLSearchParams(deleteFields);

    const deleteRes = await httpFetch(
      `https://github.com/codespaces/${first.slug}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://github.com/codespaces',
          'Origin': 'https://github.com',
        },
        body: deleteBody.toString(),
      },
      cookieJar,
      'delete'
    );

    // Follow 302 redirect if any
    if (deleteRes.status === 302) {
      await followRedirect(deleteRes, cookieJar, 'delete:redirect');
    }

    endTimer('delete');
    const ok = deleteRes.status === 302 || deleteRes.status === 200;
    deleted = { name: first.name, slug: first.slug, status: ok ? 'deleted' : `error:${deleteRes.status}` };
    console.log(`  → delete ${first.name} (${first.slug}): ${deleteRes.status} ${ok ? 'OK' : 'FAILED'}\n`);
  } else {
    console.log('  → no codespaces to delete (or --keep-existing)\n');
  }

  // ── Step 3: Create ───────────────────────────────────────────────────────
  startTimer('create');

  // First GET the templates page to extract form data
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

  // Try to find the "blank" template form (first form with action="/codespaces").
  // extractFormFields captures all hidden inputs including the per-form authenticity_token.
  // Do NOT overwrite authenticity_token with the meta csrf-token — GitHub requires the
  // per-form token; the session-level meta token returns 400/422.
  let createFields = extractFormFields(templatesHtml, '/codespaces');
  if (!createFields) {
    // Fallback: look for form with action containing /codespaces/new
    createFields = extractFormFields(templatesHtml, '/codespaces/new');
  }

  if (createFields) {
    console.log(`  → found create form with fields: ${Object.keys(createFields).join(', ')}`);
  } else {
    // Last-resort fallback: extract session-level CSRF token from meta tag
    const createToken = extractCsrfToken(templatesHtml);
    if (!createToken) throw new Error('Could not extract CSRF token from /codespaces/templates');
    createFields = { authenticity_token: createToken };
    console.log('  → no form found, using minimal fields (authenticity_token only)');
  }

  if (args.debug) console.log(`  → form data: ${JSON.stringify(createFields)}`);

  // POST to create
  const createBody = new URLSearchParams(createFields);
  const createRes = await httpFetch(
    'https://github.com/codespaces',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://github.com/codespaces/templates',
        'Origin': 'https://github.com',
      },
      body: createBody.toString(),
    },
    cookieJar,
    'create:post'
  );

  let createHtml = await createRes.text();
  if (args.debug) fs.writeFileSync('/tmp/cs-http-debug-create-response.html', createHtml);

  // Extract the new codespace slug from the response
  newSlug = extractNewSlug(createHtml);

  // If not found, follow redirect and try again
  if (!newSlug && createRes.status === 302) {
    const cr = await followRedirect(createRes, cookieJar, 'create:redirect');
    if (cr) {
      createHtml = await cr.text();
      if (args.debug) fs.writeFileSync('/tmp/cs-http-debug-create-redirect.html', createHtml);
      newSlug = extractNewSlug(createHtml);
    }
  }

  // If still not found, GET /codespaces and find the newest one.
  // Retry up to 6 times (30s total) since codespace provisioning is async.
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
      const reListed = parseCodespaceList(reListHtml);
      // The newest codespace should be one that wasn't in the original list
      const newOnes = reListed.filter((c) => !originalSlugs.has(c.slug));
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

  // ── Step 4: Stop ──────────────────────────────────────────────────────────
  // Optional delay before stop — lets codespace fully provision so suspend works
  if (args.stopDelay > 0) {
    console.log(`  → waiting ${args.stopDelay}s before stop (codespace provisioning)...\n`);
    await new Promise((r) => setTimeout(r, args.stopDelay * 1000));
  }
  // GET /codespaces to get a fresh page with the suspend form for the new codespace
  startTimer('stop');
  let stopStatus = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const stopListRes = await httpFetch('https://github.com/codespaces', {}, cookieJar, `stop:get-list:${attempt}`);
    const stopListHtml = await stopListRes.text();

    // The suspend form has action="/codespaces/{slug}/suspend" with just authenticity_token (no _method)
    let stopFields = extractFormFields(stopListHtml, `/codespaces/${newSlug}/suspend`);
    if (!stopFields) {
      // Fallback to meta tag token alone
      const metaToken = extractCsrfToken(stopListHtml);
      if (!metaToken) throw new Error('Could not extract CSRF token for stop action');
      stopFields = { authenticity_token: metaToken };
    }

    const stopBody = new URLSearchParams(stopFields);

    const stopRes = await httpFetch(
      `https://github.com/codespaces/${newSlug}/suspend`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://github.com/codespaces',
          'Origin': 'https://github.com',
        },
        body: stopBody.toString(),
      },
      cookieJar,
      `stop:post-suspend:${attempt}`
    );

    stopStatus = stopRes.status;

    if (stopRes.status === 302) {
      await followRedirect(stopRes, cookieJar, 'stop:redirect');
      break; // success
    }

    if (stopRes.status === 422 && attempt < 3) {
      console.log(`  → stop attempt ${attempt}: ${stopRes.status} (retrying in 5s…)`);
      await new Promise((r) => setTimeout(r, 5000));
    } else {
      // Read the error body for debugging
      const errBody = await stopRes.text();
      if (args.debug) fs.writeFileSync(`/tmp/cs-http-debug-stop-error-${attempt}.html`, errBody);
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
  for (const [key, ep] of eps) {
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
    status: stopOk ? (args.stopDelay >= 3 ? 'stopped' : 'stopping (async, may take 10-20min)') : 'failed',
    note: args.stopDelay >= 3
      ? `Stopped immediately (suspend after ${args.stopDelay}s provisioning delay).`
      : 'Suspend POST returns 302 but codespace may not stop immediately without a provisioning delay. Use --stop-delay 5 (default) for immediate stop.',
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
