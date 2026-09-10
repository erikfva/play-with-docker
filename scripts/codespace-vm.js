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

Required:
  --credentials <path>  Playwright storage state file created by github-auth.js
  --action <action>     Action to run: create, delete, or list

Create options:
  --template <name>     Template to use. Default: blank
  --stop                Stop the codespace after creation
  --no-wait             Do not wait for the codespace to appear in /codespaces

Delete options:
  --target <name>       Codespace name or slug to delete
  --force               Stop an active codespace before deleting it

Examples:
  node scripts/codespace-vm.js --credentials ./github-auth.json --action create --stop
  node scripts/codespace-vm.js --credentials ./github-auth.json --action list
  node scripts/codespace-vm.js --credentials ./github-auth.json --action delete --target my-codespace --force`);
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
    } else if (arg === '--stop' || arg === '--no-wait' || arg === '--force') {
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
  throw new Error(`Unsupported action "${action}". Use create, delete, or list.`);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return;
  }

  if (!args.action) throw new Error('Missing required argument: --action <create|delete>');
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
    throw new Error('List does not accept create/delete options');
  }

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
