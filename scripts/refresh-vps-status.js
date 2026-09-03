#!/usr/bin/env node
'use strict';

/**
 * scripts/refresh-vps-status.js
 *
 * Refreshes the persisted credential status of VPS rows via the LAB-012
 * refresh endpoints. By default refreshes ALL VPS; can be filtered by
 * provider or targeted to a single VPS id.
 *
 * Endpoints used:
 *   POST /api/v1/vps/status/refresh[?provider=&force=]  (bulk)
 *   POST /api/v1/vps/:id/status/refresh[?force=]        (single)
 *
 * The refresh persists `status` (full normalized entry with quotas/details)
 * and `statusCheckedAt` in one DB write. Without --force the server may
 * serve the DB-cached status if checked within VPS_STATUS_TTL_MINUTES.
 *
 * Usage:
 *   node scripts/refresh-vps-status.js [options]
 *   SERVER_TOKEN=xxx node scripts/refresh-vps-status.js --provider codespaces --force
 *   node scripts/refresh-vps-status.js --id 9951be32-be3a-465a-ba9a-73edd0691c59
 *
 * Options:
 *   --url <url>        API base URL (default: http://localhost:3000)
 *   --token <token>    Server token (default: $SERVER_TOKEN env var)
 *   --provider <name>  Filter bulk refresh: gcs | codesandbox | codespaces
 *   --id <vpsId>       Refresh a single VPS instead of bulk
 *   --force            Bypass TTL/status cache (re-hits provider API)
 *   --json             Print raw JSON response and exit (no table)
 *   --help             Show this help
 */

if (process.env.NODE_ENV !== 'production') {
  try {
    const path = require('path');
    const fs = require('fs');
    // Load root .env first (if present), then scripts/.env to allow per-scripts overrides.
    // Neither is required — missing files are silently ignored.
    require('dotenv').config({ override: true });
    const scriptsEnv = path.join(__dirname, '.env');
    if (fs.existsSync(scriptsEnv)) {
      require('dotenv').config({ path: scriptsEnv, override: true });
    }
  } catch (_) {}
}

const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(flag);
}

function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return defaultValue;
}

if (hasFlag('--help') || hasFlag('-h')) {
  const help = `
Usage: node scripts/refresh-vps-status.js [options]

Options:
  --url <url>        API base URL (default: $PWD_API_URL or http://localhost:$PORT / http://localhost:3000)
  --token <token>    Server token (default: $SERVER_TOKEN env var)
  --provider <name>  Bulk filter: gcs | codesandbox | codespaces
  --id <vpsId>       Single VPS id (uses POST /vps/:id/status/refresh)
  --force            Bypass TTL cache (?force=true)
  --json             Print raw JSON response
  --help             Show this help

Precedence for the base URL: --url flag > $PWD_API_URL env var > http://localhost:$PORT > http://localhost:3000
See .env.example (PWD_API_URL) and scripts/README.md.

Examples:
  node scripts/refresh-vps-status.js
  node scripts/refresh-vps-status.js --provider codespaces
  node scripts/refresh-vps-status.js --provider gcs --force
  node scripts/refresh-vps-status.js --id 9951be32-be3a-465a-ba9a-73edd0691c59 --force
  PWD_API_URL=http://localhost:3200 node scripts/refresh-vps-status.js --json
  SERVER_TOKEN=xxx node scripts/refresh-vps-status.js --url http://localhost:3200 --json
`.trim();
  console.log(help);
  process.exit(0);
}

const baseUrl = (getArg('--url', process.env.PWD_API_URL || process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`)).replace(/\/$/, '');
const serverToken = getArg('--token', process.env.SERVER_TOKEN || '');
const provider = getArg('--provider', null);
const vpsId = getArg('--id', null);
const force = hasFlag('--force');
const jsonMode = hasFlag('--json');

if (!serverToken) {
  console.error('ERROR: Server token is required. Set SERVER_TOKEN env var or pass --token <token>');
  process.exit(1);
}

const VALID_PROVIDERS = new Set(['gcs', 'codesandbox', 'codespaces']);
if (provider && !VALID_PROVIDERS.has(provider)) {
  console.error(`ERROR: Invalid --provider "${provider}". Must be one of: gcs, codesandbox, codespaces`);
  process.exit(1);
}

if (provider && vpsId) {
  console.warn('WARN: --provider is ignored when --id is set (single refresh has no provider filter).');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatQuotas(quotas) {
  if (!Array.isArray(quotas) || quotas.length === 0) return '  (no quotas)';
  return quotas.map((q) => {
    const name = q.name ? `${q.name} — ` : '';
    const usage = q.usage ?? '—';
    const limit = q.limit ?? '—';
    const remaining = q.remaining ?? '—';
    return `  - ${name}${q.quotaUnit}/${q.quotaPeriod || '—'}  usage=${usage}  limit=${limit}  remaining=${remaining}`;
  }).join('\n');
}

function statusIcon(status) {
  switch (status) {
    case 'AVAILABLE': return '✓';
    case 'LIMITED': return '◐';
    case 'QUOTA_EXHAUSTED': return '⛔';
    case 'UNAVAILABLE': return '○';
    case 'INVALID':
    case 'EXPIRED': return '✗';
    case 'UNKNOWN': return '?';
    default: return '·';
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const qs = new URLSearchParams();
  if (!vpsId && provider) qs.set('provider', provider);
  if (force) qs.set('force', 'true');
  const qsStr = qs.toString() ? `?${qs.toString()}` : '';

  let url;
  let label;

  if (vpsId) {
    url = `${baseUrl}/api/v1/vps/${encodeURIComponent(vpsId)}/status/refresh${qsStr}`;
    label = `Single VPS ${vpsId}${force ? ' (force)' : ''}`;
  } else {
    url = `${baseUrl}/api/v1/vps/status/refresh${qsStr}`;
    const parts = [];
    if (provider) parts.push(`provider=${provider}`);
    if (force) parts.push('force=true');
    label = `Bulk VPS${parts.length ? ` (${parts.join(', ')})` : ' (all)'}`;
  }

  console.log(`\nRefreshing VPS status — ${label}`);
  console.log(`  ${url}`);
  console.log('');

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'x-server-token': serverToken },
    });
  } catch (err) {
    console.error(`Network error: ${err.message}`);
    console.error(`Is the server running at ${baseUrl}?`);
    process.exit(1);
  }

  let body;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }

  if (jsonMode) {
    console.log(JSON.stringify(body, null, 2));
    process.exit(res.ok ? 0 : 1);
  }

  if (!res.ok) {
    console.error(`✗ Request failed — HTTP ${res.status}`);
    if (body && typeof body === 'object') {
      console.error(`  code : ${body.code || '—'}`);
      console.error(`  error: ${body.error || JSON.stringify(body)}`);
      if (body.details) console.error(`  details: ${JSON.stringify(body.details)}`);
    } else if (body) {
      console.error(`  body: ${String(body).slice(0, 800)}`);
    }
    process.exit(1);
  }

  // --- Single response: full VPS object (same shape as GET /vps/:id) ---
  if (vpsId) {
    const vps = body;
    const s = vps.status;
    console.log(`  id               : ${vps.id}`);
    console.log(`  provider         : ${vps.provider}`);
    console.log(`  name             : ${vps.name}`);
    console.log(`  credentialFile   : ${vps.credentialFileName}`);
    console.log(`  fingerprint      : ${vps.credentialFingerprint}`);
    console.log(`  sessionActive    : ${vps.sessionActive}`);
    console.log(`  createdAt        : ${vps.createdAt}`);
    console.log(`  updatedAt        : ${vps.updatedAt}`);
    console.log(`  statusCheckedAt  : ${vps.statusCheckedAt}`);
    if (!s) {
      console.log(`  status           : null`);
    } else {
      console.log(`  status           : ${statusIcon(s.status)} ${s.status}  (checkedAt: ${s.checkedAt})`);
      if (s.details?.plan) console.log(`  plan             : ${s.details.plan}  adoptable=${s.details.adoptable ?? '—'}  validated=${s.details.validated}`);
      if (s.details?.localActiveSessions != null) console.log(`  localActive      : ${s.details.localActiveSessions}`);
      console.log(`  quotas:`);
      console.log(formatQuotas(s.quotas));
      if (Array.isArray(s.details?.limitations) && s.details.limitations.length) {
        console.log(`  limitations:`);
        for (const lim of s.details.limitations) {
          console.log(`    - [${lim.field}] ${lim.reason}`);
        }
      }
      if (s.status === 'UNKNOWN' && s.details) {
        console.log(`  errorCode        : ${s.details.errorCode || '—'}`);
        console.log(`  errorMessage     : ${s.details.errorMessage || '—'}`);
      }
    }
    console.log('');
    return;
  }

  // --- Bulk response: { summary: { total, succeeded, failed }, results: [...] } ---
  const { summary, results } = body;
  console.log('─────────────────────────────────────────');
  console.log(`  Total     : ${summary.total}`);
  console.log(`  Succeeded : ${summary.succeeded}  (status != UNKNOWN)`);
  console.log(`  Failed    : ${summary.failed}  (UNKNOWN)`);
  console.log('─────────────────────────────────────────');

  if (!results || results.length === 0) {
    console.log('  (no VPS matched the filter)');
    console.log('');
    return;
  }

  console.log('');
  for (const r of results) {
    const errPart = r.error ? `  ✗ ${r.error.code}: ${r.error.message}` : '';
    console.log(`  ${statusIcon(r.status)} ${r.id}  [${r.provider}]  ${r.status}  @ ${r.statusCheckedAt}${errPart}`);
  }

  // Verbose quota dump when only a few results
  if (results.length <= 10) {
    console.log('\nFetching quota details for each VPS...\n');
    for (const r of results) {
      try {
        const detailRes = await fetch(`${baseUrl}/api/v1/vps/${encodeURIComponent(r.id)}`, {
          headers: { 'x-server-token': serverToken },
        });
        const detailText = await detailRes.text();
        const detail = detailText ? JSON.parse(detailText) : null;
        if (!detailRes.ok || !detail?.status) continue;
        console.log(`  ${r.id} [${r.provider}] — ${detail.status.status}`);
        console.log(formatQuotas(detail.status.quotas));
        if (detail.status.quotas?.length) console.log('');
      } catch (_) { /* best-effort */ }
    }
  }

  console.log('');
  if (summary.failed > 0) {
    console.log(`Note: ${summary.failed} VPS returned UNKNOWN — check token validity / provider API / logs.`);
    console.log('');
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
