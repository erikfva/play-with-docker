#!/usr/bin/env node
'use strict';

/**
 * scripts/seed-credentials.js
 *
 * Bulk-imports credential files from a local credentials/ directory into the
 * vps table via POST /api/v1/vps.
 *
 * Usage:
 *   node scripts/seed-credentials.js [options]
 *
 * Options:
 *   --base-dir <path>   Base directory to scan (default: ./credentials)
 *   --url <url>         API base URL (default: http://localhost:3000)
 *   --token <token>     Server token (default: $SERVER_TOKEN env var)
 *
 * Directory layout expected:
 *   <base-dir>/
 *     gcs/           or  gcloud/        → provider "gcs"
 *     codesandbox/                       → provider "codesandbox"
 *     codespaces/                        → provider "codespaces"
 *
 * Only .json and .txt files are processed.
 * Files that already exist (409 VPS_ALREADY_EXISTS) are skipped.
 * Files that collide on token fingerprint (409 VPS_DUPLICATE_TOKEN) are noted.
 */

const fs = require('fs');
const path = require('path');

if (process.env.NODE_ENV !== 'production') {
  try {
    require('dotenv').config({ override: true });
    const scriptsEnv = path.join(__dirname, '.env');
    if (fs.existsSync(scriptsEnv)) {
      require('dotenv').config({ path: scriptsEnv, override: true });
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultValue;
}

const baseDir = path.resolve(getArg('--base-dir', './credentials'));
const baseUrl = (getArg('--url', process.env.PWD_API_URL || process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`)).replace(/\/$/, '');
const serverToken = getArg('--token', process.env.SERVER_TOKEN || '');

if (!serverToken) {
  console.error('ERROR: Server token is required. Set SERVER_TOKEN env var or pass --token <token>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Provider folder → provider identifier mapping
// ---------------------------------------------------------------------------
const FOLDER_TO_PROVIDER = {
  gcs: 'gcs',
  gcloud: 'gcs',
  codesandbox: 'codesandbox',
  codespaces: 'codespaces'
};

const ACCEPTED_EXTENSIONS = new Set(['.json', '.txt']);

// ---------------------------------------------------------------------------
// Collect files to import
// ---------------------------------------------------------------------------
function collectFiles(dir) {
  const files = [];

  if (!fs.existsSync(dir)) {
    console.warn(`Base directory does not exist: ${dir}`);
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const folderName = entry.name.toLowerCase();
    const provider = FOLDER_TO_PROVIDER[folderName];

    if (!provider) {
      console.warn(`Skipping unknown folder: ${entry.name} (no provider mapping)`);
      continue;
    }

    const folderPath = path.join(dir, entry.name);
    const folderEntries = fs.readdirSync(folderPath, { withFileTypes: true });

    for (const file of folderEntries) {
      if (!file.isFile()) continue;

      const ext = path.extname(file.name).toLowerCase();
      if (!ACCEPTED_EXTENSIONS.has(ext)) continue;

      const name = path.basename(file.name, ext); // filename without extension
      files.push({
        provider,
        name,
        credentialFileName: file.name,
        filePath: path.join(folderPath, file.name)
      });
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// POST to /api/v1/vps
// ---------------------------------------------------------------------------
async function registerVps({ provider, name, credentialFileName, filePath }) {
  let credentialContent;
  try {
    credentialContent = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { status: 'failed', reason: `Cannot read file: ${err.message}` };
  }

  const body = JSON.stringify({ provider, name, credentialFileName, credentialContent });

  let response;
  try {
    response = await fetch(`${baseUrl}/api/v1/vps`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-server-token': serverToken
      },
      body
    });
  } catch (err) {
    return { status: 'failed', reason: `Network error: ${err.message}` };
  }

  if (response.status === 201) {
    return { status: 'imported' };
  }

  let responseBody;
  try {
    responseBody = await response.json();
  } catch (_) {
    responseBody = { code: 'UNKNOWN', error: `HTTP ${response.status}` };
  }

  if (response.status === 409) {
    if (responseBody.code === 'VPS_ALREADY_EXISTS') {
      return { status: 'skipped', reason: 'Already exists (name collision)' };
    }
    if (responseBody.code === 'VPS_DUPLICATE_TOKEN') {
      return { status: 'skipped', reason: 'Duplicate token already registered under a different name' };
    }
  }

  return {
    status: 'failed',
    reason: `HTTP ${response.status} — ${responseBody.code || 'UNKNOWN'}: ${responseBody.error || 'unknown error'}`
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nSeed credentials`);
  console.log(`  Base dir : ${baseDir}`);
  console.log(`  API URL  : ${baseUrl}`);
  console.log('');

  const files = collectFiles(baseDir);

  if (files.length === 0) {
    console.log('No credential files found. Nothing to import.');
    return;
  }

  console.log(`Found ${files.length} credential file(s) to process.\n`);

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const label = `${file.provider}/${file.name} (${file.credentialFileName})`;
    const result = await registerVps(file);

    if (result.status === 'imported') {
      console.log(`  ✓ Imported  ${label}`);
      imported++;
    } else if (result.status === 'skipped') {
      console.log(`  ~ Skipped   ${label} — ${result.reason}`);
      skipped++;
    } else {
      console.error(`  ✗ Failed    ${label} — ${result.reason}`);
      failed++;
    }
  }

  console.log('');
  console.log('─────────────────────────────────');
  console.log(`  Imported : ${imported}`);
  console.log(`  Skipped  : ${skipped}`);
  console.log(`  Failed   : ${failed}`);
  console.log(`  Total    : ${files.length}`);
  console.log('─────────────────────────────────\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
