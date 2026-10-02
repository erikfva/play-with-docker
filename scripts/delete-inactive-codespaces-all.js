#!/usr/bin/env node
'use strict';

/**
 * scripts/delete-inactive-codespaces-all.js
 *
 * Deletes all stopped (inactive) codespaces for every VPS row that belongs to
 * the `codespaces` provider. For each VPS it:
 *
 *   1. Looks up the credential file from the github credentials directory
 *      (GITHUB_CREDENTIALS_DIR, ./github-credentials, or /mnt/s3/github)
 *      as <name>/github.json.
 *   2. Spawns  node scripts/delete-inactive-codespaces-http.js
 *        --credentials <file> [--dry-run] [--debug] [--delay <secs>]
 *   3. Reports per-VPS outcome and a final summary.
 *
 * VPS rows without a matching credential file are skipped (reported, not failed).
 *
 * Usage:
 *   node scripts/delete-inactive-codespaces-all.js [options]
 *
 * Options:
 *   --url <url>           API base URL (default: $PWD_API_URL → http://localhost:3000)
 *   --token <token>       Server token (default: $SERVER_TOKEN)
 *   --credentials-dir <p> Directory containing github/<name>/github.json files
 *                         (default: $GITHUB_CREDENTIALS_DIR → ./github-credentials → /mnt/s3/github)
 *   --name <substr>       Only VPS whose name contains <substr>
 *   --id <vpsId>          Only this VPS id
 *   --delay <secs>        Seconds between delete requests inside each account (default: 1)
 *   --timeout-minutes <n> Per-VPS timeout in minutes (default: 5)
 *   --debug               Pass --debug to child script (saves HTML snapshots)
 *   --dry-run             Pass --dry-run to child script (list only, no deletions)
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
const { resolveApiBase, ApiBaseConfigError } = require('./lib/api-base');

// ── Args ─────────────────────────────────────────────────────────────────────

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
  console.log(`Usage: node scripts/delete-inactive-codespaces-all.js [options]

Options:
  --url <url>           API base URL (default: $PWD_API_URL → http://localhost:$PORT → http://localhost:3000)
  --token <token>       Server token (default: $SERVER_TOKEN)
  --credentials-dir <p> Directory containing <name>/github.json credential files.
                        Defaults: $GITHUB_CREDENTIALS_DIR → ./github-credentials → /mnt/s3/github
  --name <substr>       Only VPS whose name contains <substr>
  --id <vpsId>          Only this VPS id
  --delay <secs>        Seconds between delete requests per account (default: 1)
  --timeout-minutes <n> Per-VPS timeout in minutes (default: 5)
  --debug               Save HTML debug snapshots (passed to child)
  --dry-run             List inactive codespaces without deleting (passed to child)
  --help                Show this help

Credential file lookup:
  <credentials-dir>/<vps-name>/github.json
  VPS rows without a matching file are skipped.

Examples:
  node scripts/delete-inactive-codespaces-all.js
  node scripts/delete-inactive-codespaces-all.js --dry-run
  node scripts/delete-inactive-codespaces-all.js --name vm-manager232
  node scripts/delete-inactive-codespaces-all.js --id 9951be32-be3a-465a-ba9a-73edd0691c59
  node scripts/delete-inactive-codespaces-all.js --credentials-dir ./github-credentials --dry-run
  SERVER_TOKEN=xxx PWD_API_URL=http://localhost:3000 node scripts/delete-inactive-codespaces-all.js
`);
  process.exit(0);
}

// ── Config ────────────────────────────────────────────────────────────────────

const rawBase = getArg('--url', process.env.PWD_API_URL || process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`);
let baseUrl;
try {
  baseUrl = resolveApiBase(rawBase);
} catch (err) {
  if (err instanceof ApiBaseConfigError) {
    console.error(`ERROR: ${err.code ? err.code + ' ' : ''}${err.message}`);
  } else {
    console.error(`ERROR: ${err.message}`);
  }
  process.exit(1);
}

const serverToken = getArg('--token', process.env.SERVER_TOKEN || '');
if (!serverToken) {
  console.error('ERROR: Server token is required. Set SERVER_TOKEN env var or pass --token <token>');
  process.exit(1);
}

const credentialsDirOverride = getArg('--credentials-dir', null);
const onlyId = getArg('--id', null);
const nameFilter = getArg('--name', null);
const delay = getArg('--delay', '1');
const timeoutMinutes = Math.max(1, parseInt(getArg('--timeout-minutes', '5'), 10) || 5);
const dryRun = hasFlag('--dry-run');
const debug = hasFlag('--debug');

// ── Credential directory resolution ──────────────────────────────────────────

function credentialDirs() {
  const dirs = [];
  if (credentialsDirOverride) dirs.push(credentialsDirOverride);
  if (process.env.GITHUB_CREDENTIALS_DIR) dirs.push(process.env.GITHUB_CREDENTIALS_DIR);
  dirs.push(path.join(process.cwd(), 'github-credentials'));
  dirs.push('/mnt/s3/github');
  return [...new Set(dirs)];
}

function findCredentialFile(vpsName) {
  for (const dir of credentialDirs()) {
    const p = path.join(dir, vpsName, 'github.json');
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (_) {}
  }
  return null;
}

// ── Child runner ──────────────────────────────────────────────────────────────

function runChild(credFile) {
  const script = path.join(__dirname, 'delete-inactive-codespaces-http.js');
  const childArgs = ['--credentials', credFile, '--delay', delay];
  if (dryRun) childArgs.push('--dry-run');
  if (debug) childArgs.push('--debug');

  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...childArgs], {
      timeout: timeoutMinutes * 60_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function lastLines(text, n = 8) {
  return String(text || '')
    .trim()
    .split('\n')
    .filter((l) => l.trim() && !l.includes('dotenv'))
    .slice(-n)
    .join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. List codespaces VPS rows from the backend.
  let list;
  try {
    const r = await fetch(`${baseUrl}/api/v1/vps?provider=codespaces&limit=100`, {
      headers: { 'x-server-token': serverToken },
    });
    if (!r.ok) {
      console.error(`ERROR: GET /api/v1/vps?provider=codespaces failed — HTTP ${r.status}`);
      process.exit(1);
    }
    const j = await r.json();
    list = j.vps || j.rows || [];
  } catch (err) {
    console.error(`Network error: ${err.message}`);
    console.error(`Is the server running at ${baseUrl}?`);
    process.exit(1);
  }

  // 2. Apply filters.
  if (onlyId) list = list.filter((v) => v.id === onlyId);
  if (nameFilter) list = list.filter((v) => String(v.name || '').includes(nameFilter));

  if (!list.length) {
    console.log('(no codespaces VPS rows matched the filter)');
    return;
  }

  // 3. Plan: match each VPS to its github.json credential file.
  const plan = list.map((v) => ({
    vps: v,
    credFile: findCredentialFile(v.name),
  }));

  const runnable = plan.filter((p) => p.credFile);
  const skipped = plan.filter((p) => !p.credFile);

  console.log(`\nDelete inactive codespaces — ${runnable.length} to run, ${skipped.length} skipped (no credential), ${plan.length} total`);
  console.log(`Credential dirs searched: ${credentialDirs().join(', ')}\n`);

  for (const p of skipped) {
    console.log(`  ○ skip  ${p.vps.name} (${p.vps.id}) — no github.json found`);
  }

  if (dryRun) {
    console.log('');
    for (const p of runnable) {
      console.log(`  · run   ${p.vps.name} (${p.vps.id}) — ${p.credFile}`);
    }
    console.log('\n(dry-run: spawning child scripts to list inactive codespaces without deleting)\n');
  }

  // 4. Run sequentially — one GitHub account at a time.
  let succeeded = 0;
  let failed = 0;

  for (const p of runnable) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${p.vps.name}  (${p.vps.id})`);
    console.log(`  cred: ${p.credFile}`);
    console.log('─'.repeat(60));

    const { error, stdout, stderr } = await runChild(p.credFile);

    if (error) {
      failed++;
      const reason = error.killed
        ? `timeout after ${timeoutMinutes}min`
        : (error.message || 'non-zero exit');
      console.log(`  ✗ ${reason}`);
      const tail = lastLines(stderr) || lastLines(stdout);
      if (tail) console.log('  ' + tail.split('\n').join('\n  '));
    } else {
      succeeded++;
      // Print the child's JSON RESULT block if present, otherwise last lines.
      const jsonBlockMatch = stdout.match(/JSON RESULT\n={3,}\n([\s\S]+?)(?:\n={3,}|$)/);
      if (jsonBlockMatch) {
        console.log('  ' + jsonBlockMatch[1].trim().split('\n').join('\n  '));
      } else {
        const tail = lastLines(stdout);
        console.log('  ✓\n  ' + (tail ? tail.split('\n').join('\n  ') : '(no output)'));
      }
    }
  }

  // 5. Summary.
  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Total     : ${plan.length}`);
  console.log(`  Succeeded : ${succeeded}`);
  console.log(`  Failed    : ${failed}`);
  console.log(`  Skipped   : ${skipped.length} (no credential file)`);
  console.log('═'.repeat(60) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
