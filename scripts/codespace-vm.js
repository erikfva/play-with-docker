#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function printUsage() {
  console.log(`Usage:
  node scripts/codespace-vm.js --credentials <github-auth.json> --action create [options]
  node scripts/codespace-vm.js --credentials <github-auth.json> --action delete --target <codespace-name-or-slug> [options]
  node scripts/codespace-vm.js --credentials <github-auth.json> --action list
  node scripts/codespace-vm.js --credentials <github-auth.json> --action refresh [options]
  node scripts/codespace-vm.js --credentials <github-auth.json> --action refresh-http [options]

Required:
  --credentials <path>  Playwright storage state file created by github-auth.js
  --action <action>     Action to run: create, delete, list, refresh, or refresh-http

Create options:
  --template <name>     Template to use. Default: blank
  --stop                Stop the codespace after creation
  --no-wait             Do not wait for the codespace to appear in /codespaces

Delete options:
  --target <name>       Codespace name or slug to delete
  --force               Stop an active codespace before deleting it

Shared refresh options (refresh + refresh-http):
  --keep-existing       Skip deletion; only create a new codespace and stop it

Refresh options (browser only):
  --template <name>     Template to use for the new codespace. Default: blank
  --no-wait-stop        Fire the stop action without waiting for GitHub status confirmation

Refresh-http options (HTTP only):
  --provision-timeout <secs>  Max seconds to wait for active before stop. Default: 300 (0 to skip)
  --poll-interval <secs>      Polling interval for the provision wait. Default: 10
  --debug               Save HTML responses to /tmp/cs-http-debug-*.html

Examples:
  node scripts/codespace-vm.js --credentials ./github-auth.json --action create --stop
  node scripts/codespace-vm.js --credentials ./github-auth.json --action list
  node scripts/codespace-vm.js --credentials ./github-auth.json --action delete --target my-codespace --force
  node scripts/codespace-vm.js --credentials ./github-auth.json --action refresh
  node scripts/codespace-vm.js --credentials ./github-auth.json --action refresh --keep-existing
  node scripts/codespace-vm.js --credentials ./github-auth.json --action refresh-http
  node scripts/codespace-vm.js --credentials ./github-auth.json --action refresh-http --provision-timeout 300`);
}

function takeValue(argv, index, name) {
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

function parseArgs(argv) {
  const args = { passthrough: [] };
  const raw = argv.slice(2);

  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--credentials') {
      args.credentials = takeValue(raw, i, '--credentials');
      i++;
    } else if (arg.startsWith('--credentials=')) {
      args.credentials = arg.slice('--credentials='.length);
    } else if (arg === '--action') {
      args.action = takeValue(raw, i, '--action');
      i++;
    } else if (arg.startsWith('--action=')) {
      args.action = arg.slice('--action='.length);
    } else if (arg === '--target') {
      args.target = takeValue(raw, i, '--target');
      i++;
    } else if (arg.startsWith('--target=')) {
      args.target = arg.slice('--target='.length);
    } else if (arg === '--template') {
      args.passthrough.push(`--template=${takeValue(raw, i, '--template')}`);
      i++;
    } else if (arg.startsWith('--template=')) {
      args.passthrough.push(arg);
    } else if (arg === '--stop' || arg === '--no-wait' || arg === '--force' || arg === '--keep-existing' || arg === '--no-wait-stop' || arg === '--debug') {
      args.passthrough.push(arg);
    } else if (arg === '--provision-timeout') {
      const val = takeValue(raw, i, '--provision-timeout');
      args.passthrough.push(`--provision-timeout=${val}`);
      i++;
    } else if (arg.startsWith('--provision-timeout=')) {
      args.passthrough.push(arg);
    } else if (arg === '--poll-interval') {
      const val = takeValue(raw, i, '--poll-interval');
      args.passthrough.push(`--poll-interval=${val}`);
      i++;
    } else if (arg.startsWith('--poll-interval=')) {
      args.passthrough.push(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function validateCredentialFile(credentials) {
  if (!credentials) throw new Error('Missing required argument: --credentials <github-auth.json>');

  const absolutePath = path.resolve(credentials);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Credential file not found: ${absolutePath}`);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
      throw new Error('expected Playwright storage state with cookies and origins arrays');
    }
  } catch (err) {
    throw new Error(`Invalid credential file ${absolutePath}: ${err.message}`);
  }

  return absolutePath;
}

function scriptForAction(action) {
  if (action === 'create') return 'create-codespace.js';
  if (action === 'delete') return 'delete-codespace.js';
  if (action === 'list') return 'list-codespaces.js';
  if (action === 'refresh') return 'refresh-codespace.js';
  if (action === 'refresh-http') return 'refresh-codespace-http.js';
  throw new Error(`Unsupported action "${action}". Use create, delete, list, refresh, or refresh-http.`);
}

// Flags each action's child script actually accepts. The dispatcher collects
// flags generically, so validate here to fail fast with a clear message
// instead of the child's generic "Unknown argument" (exit 2).
// NOTE: exact matches are compared with equality (not prefix), so --no-wait
// never collides with --no-wait-stop.
const ACTION_FLAGS = {
  create: { exact: ['--stop', '--no-wait'], prefix: ['--template='] },
  delete: { exact: ['--force'], prefix: [] },
  list: { exact: [], prefix: [] },
  refresh: { exact: ['--keep-existing', '--no-wait-stop'], prefix: ['--template='] },
  'refresh-http': { exact: ['--keep-existing', '--debug'], prefix: ['--provision-timeout=', '--poll-interval='] },
};

function validateFlagsForAction(action, passthrough) {
  const spec = ACTION_FLAGS[action];
  for (const arg of passthrough) {
    if (spec.exact.includes(arg)) continue;
    if (spec.prefix.some((p) => arg.startsWith(p))) continue;
    throw new Error(`--action ${action} does not support "${arg}"`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return;
  }

  if (!args.action) throw new Error('Missing required argument: --action <create|delete|list|refresh|refresh-http>');
  const credentials = validateCredentialFile(args.credentials);
  const scriptName = scriptForAction(args.action);
  const scriptArgs = [...args.passthrough];

  if (args.action === 'delete') {
    if (!args.target) throw new Error('Delete requires --target <codespace-name-or-slug>');
    scriptArgs.unshift(args.target);
  } else if (args.target) {
    throw new Error('--target is only valid with --action delete');
  }

  if (args.action === 'list' && scriptArgs.length > 0) {
    throw new Error('List does not accept create/delete/refresh options');
  }

  // Validate the passthrough flags (not scriptArgs — for delete, scriptArgs[0]
  // is the positional target, which is not a flag).
  validateFlagsForAction(args.action, args.passthrough);

  const result = spawnSync(process.execPath, [path.join(__dirname, scriptName), ...scriptArgs], {
    stdio: 'inherit',
    env: {
      ...process.env,
      GITHUB_AUTH_FILE: credentials,
    },
  });

  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
