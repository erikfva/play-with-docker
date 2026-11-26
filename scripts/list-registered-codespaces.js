#!/usr/bin/env node
'use strict';

/**
 * Lists all Codespaces credential registrations through the backend VPS API.
 *
 * Usage:
 *   node scripts/list-registered-codespaces.js
 *   node scripts/list-registered-codespaces.js --json
 *   SERVER_TOKEN=xxx PWD_API_URL=http://localhost:3200 node scripts/list-registered-codespaces.js
 */

const fs = require('fs');
const path = require('path');

function loadEnvFile(filePath, override = false) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;

    const key = match[1];
    if (!override && process.env[key] !== undefined) continue;

    let value = match[2].trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }

    process.env[key] = value;
  }
}

loadEnvFile(path.resolve(__dirname, '..', '.env'), true);
loadEnvFile(path.resolve(__dirname, '.env'), true);

const { resolveApiBase, ApiBaseConfigError } = require('./lib/api-base');

const args = process.argv.slice(2);

function getArg(flag, defaultValue) {
  const index = args.indexOf(flag);
  if (index !== -1 && args[index + 1] && !args[index + 1].startsWith('--')) {
    return args[index + 1];
  }
  const prefixed = args.find((arg) => arg.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : defaultValue;
}

function hasFlag(flag) {
  return args.includes(flag);
}

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`Usage: node scripts/list-registered-codespaces.js [options]

Options:
  --url <url>     API base URL (default: $PWD_API_URL or http://localhost:$PORT)
  --token <tok>   Server token (default: $SERVER_TOKEN)
  --json          Print raw API rows as JSON
  --help          Show this help

Examples:
  node scripts/list-registered-codespaces.js
  PWD_API_URL=http://localhost:3200 node scripts/list-registered-codespaces.js --json
  node scripts/list-registered-codespaces.js --url http://localhost:3200 --token xxx`);
  process.exit(0);
}

const rawBase = getArg(
  '--url',
  process.env.PWD_API_URL
    || process.env.API_BASE_URL
    || `http://localhost:${process.env.PORT || 3000}`
);
let baseUrl;
try {
  baseUrl = resolveApiBase(rawBase);
} catch (error) {
  if (error instanceof ApiBaseConfigError) {
    console.error(`ERROR: ${error.code ? `${error.code} ` : ''}${error.message}`);
  } else {
    console.error(`ERROR: ${error.message}`);
  }
  process.exit(1);
}

const serverToken = getArg('--token', process.env.SERVER_TOKEN || '');
if (!serverToken) {
  console.error('ERROR: Server token is required. Set SERVER_TOKEN or pass --token.');
  process.exit(1);
}

function statusName(row) {
  if (row.status && typeof row.status === 'object') {
    return row.status.status || 'UNKNOWN';
  }
  return row.status || 'UNKNOWN';
}

function coreHoursRemaining(row) {
  if (!row.status || typeof row.status !== 'object' || !Array.isArray(row.status.quotas)) {
    return null;
  }
  const quota = row.status.quotas.find((item) =>
    item.name === 'Codespaces compute (core-hours)'
  );
  return quota && typeof quota.remaining === 'number' ? quota.remaining : null;
}

async function listRegisteredCodespaces() {
  const rows = [];
  const limit = 100;

  for (let offset = 0; ; offset += limit) {
    const url = `${baseUrl}/api/v1/vps?provider=codespaces&limit=${limit}&offset=${offset}&sortBy=name&sortOrder=asc`;
    const response = await fetch(url, {
      headers: { 'x-server-token': serverToken },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GET /api/v1/vps failed with HTTP ${response.status}: ${body}`);
    }

    const payload = await response.json();
    const page = payload.vps || payload.rows || [];
    rows.push(...page);

    if (rows.length >= payload.total || page.length === 0) {
      break;
    }
  }

  return rows;
}

async function main() {
  let rows;
  try {
    rows = await listRegisteredCodespaces();
  } catch (error) {
    console.error(`Network error: ${error.message}`);
    console.error(`Is the server running at ${baseUrl}?`);
    process.exit(1);
  }

  if (hasFlag('--json')) {
    console.log(JSON.stringify({
      provider: 'codespaces',
      total: rows.length,
      registered: rows,
    }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('(no registered Codespaces credentials)');
    return;
  }

  console.log(`Registered Codespaces credentials: ${rows.length}`);
  for (const row of rows) {
    const remaining = coreHoursRemaining(row);
    const hours = remaining === null ? '-' : `${remaining} core-hours`;
    console.log(
      `- ${row.name}`
      + ` | ${statusName(row)}`
      + ` | ${hours}`
      + ` | sessionActive=${row.sessionActive}`
      + ` | ${row.credentialFileName || '-'}`
      + ` | id=${row.id}`
    );
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
