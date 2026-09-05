#!/usr/bin/env node
'use strict';

/**
 * scripts/refresh-codesandbox-credits.js
 *
 * Runs get-codesandbox-credits.js once per CodeSandbox credential, so every
 * codesandbox VPS row gets fresh dashboard billing merged into vps.status.
 *
 * For each codesandbox VPS (GET /vps?provider=codesandbox) it locates the
 * matching browser session file <name>.json (CODESANDBOX_WEB_CREDENTIALS_DIR,
 * /mnt/s3/codesandbox-web, or credentials/codesandbox-web) and spawns:
 *   node scripts/get-codesandbox-credits.js --codesandbox-credentials <file> --vps-id <id>
 *
 * VPS rows without a matching session file are skipped (reported, not failed).
 * The child itself enforces CODESANDBOX_SCRAPER_TTL and skips fresh billing.
 *
 * Usage:
 *   node scripts/refresh-codesandbox-credits.js [options]
 *   node scripts/refresh-codesandbox-credits.js --name vm-manager232
 *   node scripts/refresh-codesandbox-credits.js --dry-run
 *
 * Options:
 *   --url <url>           API base URL (default: $PWD_API_URL or http://localhost:$PORT / http://localhost:3000)
 *   --token <token>       Server token (default: $SERVER_TOKEN env var)
 *   --id <vpsId>          Only this VPS id
 *   --name <substr>       Only VPS whose name contains <substr>
 *   --timeout-minutes <n> Per-credential timeout in minutes (default: 10)
 *   --no-update           Pass through: scrape only, don't update vps.status
 *   --headless            Pass through: force headless browser (no xvfb-run)
 *   --dry-run             List what would run without spawning anything
 *   --help                Show this help
 */

if (process.env.NODE_ENV !== 'production') {
  try {
    const path = require('path');
    const fs = require('fs');
    require('dotenv').config({ override: true });
    const scriptsEnv = path.join(__dirname, '.env');
    if (fs.existsSync(scriptsEnv)) {
      require('dotenv').config({ path: scriptsEnv, override: true });
    }
  } catch (_) {}
}

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(flag);
}

function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return args[idx + 1];
  const prefixed = args.find((a) => a.startsWith(`${flag}=`));
  if (prefixed) return prefixed.slice(flag.length + 1);
  return defaultValue;
}

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`Usage: node scripts/refresh-codesandbox-credits.js [options]

Options:
  --url <url>           API base URL (default: $PWD_API_URL or http://localhost:$PORT / http://localhost:3000)
  --token <token>       Server token (default: $SERVER_TOKEN env var)
  --id <vpsId>          Only this VPS id
  --name <substr>       Only VPS whose name contains <substr>
  --timeout-minutes <n> Per-credential timeout in minutes (default: 10)
  --no-update           Scrape only, don't update vps.status (passed through)
  --headless            Force headless browser, no xvfb-run (passed through)
  --dry-run             List planned runs without spawning anything
  --help                Show this help

Session files are looked up as <vps-name>.json in: $CODESANDBOX_WEB_CREDENTIALS_DIR,
/mnt/s3/codesandbox-web, credentials/codesandbox-web. VPS rows without a
matching file are skipped. Fresh billing per CODESANDBOX_SCRAPER_TTL is
skipped by the child script itself.

Examples:
  node scripts/refresh-codesandbox-credits.js
  node scripts/refresh-codesandbox-credits.js --name vm-manager232
  node scripts/refresh-codesandbox-credits.js --id df0cb683-1396-4006-a74b-56d12292ae52
  node scripts/refresh-codesandbox-credits.js --dry-run`);
  process.exit(0);
}

const baseUrl = (getArg('--url', process.env.PWD_API_URL || process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`)).replace(/\/$/, '');
const serverToken = getArg('--token', process.env.SERVER_TOKEN || '');
const onlyId = getArg('--id', null);
const nameFilter = getArg('--name', null);
const timeoutMinutes = Math.max(1, parseInt(getArg('--timeout-minutes', '10'), 10) || 10);
const dryRun = hasFlag('--dry-run');
const passthrough = [];
if (hasFlag('--no-update')) passthrough.push('--no-update');
if (hasFlag('--headless')) passthrough.push('--headless');

if (!serverToken) {
  console.error('ERROR: Server token is required. Set SERVER_TOKEN env var or pass --token <token>');
  process.exit(1);
}

function webSessionDirs() {
  const dirs = [];
  if (process.env.CODESANDBOX_WEB_CREDENTIALS_DIR) dirs.push(process.env.CODESANDBOX_WEB_CREDENTIALS_DIR);
  dirs.push('/mnt/s3/codesandbox-web');
  dirs.push(path.join(path.dirname(__dirname), 'credentials', 'codesandbox-web'));
  return [...new Set(dirs)];
}

function findSessionFile(name) {
  for (const d of webSessionDirs()) {
    const p = path.join(d, `${name}.json`);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (_) {}
  }
  return null;
}

function runChild(sessionFile, vpsId, vpsName) {
  const script = path.join(__dirname, 'get-codesandbox-credits.js');
  // Forward --url/--token explicitly: the child defaults to
  // http://localhost:3000 when PWD_API_URL is unset, which 404s when the
  // server actually listens on $PORT (e.g. 3200).
  const childArgs = ['--codesandbox-credentials', sessionFile, '--vps-id', vpsId,
    '--api-url', baseUrl, '--server-token', serverToken, ...passthrough];
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...childArgs], {
      timeout: timeoutMinutes * 60000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function lastLines(text, n = 6) {
  const lines = String(text || '').trim().split('\n').filter((l) => l.trim() && !l.includes('dotenv'));
  return lines.slice(-n).join('\n');
}

async function main() {
  // 1. List codesandbox VPS rows.
  let list;
  try {
    const r = await fetch(`${baseUrl}/api/v1/vps?provider=codesandbox&limit=100`, {
      headers: { 'x-server-token': serverToken },
    });
    if (!r.ok) {
      console.error(`ERROR: GET /vps?provider=codesandbox failed — HTTP ${r.status}`);
      process.exit(1);
    }
    const j = await r.json();
    list = j.vps || j.rows || [];
  } catch (err) {
    console.error(`Network error: ${err.message}`);
    console.error(`Is the server running at ${baseUrl}?`);
    process.exit(1);
  }

  if (onlyId) list = list.filter((v) => v.id === onlyId);
  if (nameFilter) list = list.filter((v) => String(v.name || '').includes(nameFilter));

  if (!list.length) {
    console.log('(no codesandbox VPS matched the filter)');
    return;
  }

  // 2. Plan: match each VPS to its browser session file.
  const plan = list.map((v) => ({ vps: v, sessionFile: findSessionFile(v.name) }));
  const runnable = plan.filter((p) => p.sessionFile);
  const skipped = plan.filter((p) => !p.sessionFile);

  console.log(`\nCodeSandbox credits refresh — ${runnable.length} to run, ${skipped.length} skipped (no session file), ${plan.length} matched`);
  for (const p of skipped) {
    console.log(`  ○ skip  ${p.vps.name} (${p.vps.id}) — no <name>.json in ${webSessionDirs().join(', ')}`);
  }
  if (dryRun) {
    for (const p of runnable) {
      console.log(`  · run   ${p.vps.name} (${p.vps.id}) — ${p.sessionFile}`);
    }
    console.log('\n(dry-run: nothing executed)\n');
    return;
  }
  console.log('');

  // 3. Run sequentially (browsers are heavy; parallel runs trip Cloudflare).
  let succeeded = 0;
  let failed = 0;
  for (const p of runnable) {
    console.log(`── ${p.vps.name} (${p.vps.id}) ──`);
    const { error, stdout, stderr } = await runChild(p.sessionFile, p.vps.id, p.vps.name);
    if (error) {
      failed++;
      const reason = error.killed ? `timeout after ${timeoutMinutes}min` : (error.message || 'failed');
      console.log(`  ✗ ${reason}`);
      const tail = lastLines(stderr) || lastLines(stdout);
      if (tail) console.log('  ' + tail.split('\n').join('\n  '));
    } else {
      succeeded++;
      const tail = lastLines(stdout);
      console.log(`  ✓\n  ` + (tail ? tail.split('\n').join('\n  ') : '(no output)'));
    }
    console.log('');
  }

  console.log('─────────────────────────────────────────');
  console.log(`  Total     : ${plan.length}`);
  console.log(`  Succeeded : ${succeeded}`);
  console.log(`  Failed    : ${failed}`);
  console.log(`  Skipped   : ${skipped.length} (no session file)`);
  console.log('─────────────────────────────────────────\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
