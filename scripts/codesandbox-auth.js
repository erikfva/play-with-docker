#!/usr/bin/env node
'use strict';

/**
 * CodeSandbox Authentication CLI Tool
 *
 * Logs into CodeSandbox via an existing GitHub or Google Playwright
 * storageState (same format as ai-brain/github/github-auth.js) and saves
 * the resulting CodeSandbox session as a Playwright storageState JSON.
 *
 * After saving, you can reuse it WITHOUT re-OAuth:
 *   node scripts/get-codesandbox-credits.js --codesandbox-credentials ./playwright/.auth/codesandbox.json
 *
 * This mirrors ai-brain/github/github-auth.js --output pattern.
 *
 * Usage:
 *   node scripts/codesandbox-auth.js --google-credentials <google.json> --output <csb.json>
 *   node scripts/codesandbox-auth.js --credentials <github.json> --output <csb.json>
 *   node scripts/codesandbox-auth.js --codesandbox-credentials <existing-csb.json> --output <csb.json>  # refresh
 *
 * Env alternatives: GOOGLE_AUTH_FILE, GITHUB_AUTH_FILE, CODESANDBOX_AUTH_FILE
 */

try { require('dotenv').config(); } catch {}

const fs = require('fs');
const path = require('path');

function printUsage() {
  console.log(`
Usage: node scripts/codesandbox-auth.js --output <path> [--google-credentials <p>] [--credentials <p>] [--codesandbox-credentials <p>]

Required:
  --output <path>               Where to save CodeSandbox storageState (e.g. ./playwright/.auth/codesandbox.json)

One of (in priority order):
  --google-credentials <p>      Playwright storageState for Google (also honors GOOGLE_AUTH_FILE)
  --credentials <p>             Playwright storageState for GitHub (also honors GITHUB_AUTH_FILE)
  --codesandbox-credentials <p> Existing CodeSandbox storageState to refresh (also honors CODESANDBOX_AUTH_FILE)

Options:
  --headful / --headless        Force headed/headless (default: headful via xvfb-run on VPS)
  -h, --help                    Show this help

Examples:
  # From Google session (like simca.scz):
  node scripts/codesandbox-auth.js --google-credentials /mnt/s3/google/simca.scz/google.json --output ./playwright/.auth/codesandbox.json

  # From GitHub session:
  node scripts/codesandbox-auth.js --credentials /mnt/s3/github/vm-manager123/github.json --output ./playwright/.auth/codesandbox.json

  # Reuse (no re-OAuth, fastest – same as get-codesandbox-credits.js --codesandbox-credentials):
  node scripts/get-codesandbox-credits.js --codesandbox-credentials ./playwright/.auth/codesandbox.json --json

  # One-liner that also validates credits:
  node scripts/get-codesandbox-credits.js --google-credentials /mnt/s3/google/simca.scz/google.json --save-state ./playwright/.auth/codesandbox.json --json
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--headless') args.headless = true;
    else if (a === '--headful') args.headless = false;
    else if (a === '--output' || a === '--save-state' || a === '--save-auth') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      args.output = v;
    } else if (a.startsWith('--output=')) args.output = a.slice('--output='.length);
    else if (a === '--credentials') {
      const v = argv[++i];
      if (!v) throw new Error('--credentials requires a value');
      args.credentials = v;
    } else if (a.startsWith('--credentials=')) args.credentials = a.slice('--credentials='.length);
    else if (a === '--google-credentials') {
      const v = argv[++i];
      if (!v) throw new Error('--google-credentials requires a value');
      args.googleCredentials = v;
    } else if (a.startsWith('--google-credentials=')) args.googleCredentials = a.slice('--google-credentials='.length);
    else if (a === '--codesandbox-credentials' || a === '--cs-credentials' || a === '--csb-credentials') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} requires a value`);
      args.codesandboxCredentials = v;
    } else if (a.startsWith('--codesandbox-credentials=')) args.codesandboxCredentials = a.slice('--codesandbox-credentials='.length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printUsage(); return; }
  if (!args.output) {
    console.error('Error: --output <path> is required');
    printUsage();
    process.exit(1);
  }
  const outputPath = path.resolve(args.output);

  // Resolve credential sources (CLI > env) – same as get-codesandbox-credits.js
  const githubFile = args.credentials ? path.resolve(args.credentials) : (process.env.GITHUB_AUTH_FILE || null);
  const googleFile = args.googleCredentials ? path.resolve(args.googleCredentials) : (process.env.GOOGLE_AUTH_FILE || null);
  const csbFile = args.codesandboxCredentials ? path.resolve(args.codesandboxCredentials) : (process.env.CODESANDBOX_AUTH_FILE || null);

  if (githubFile && !fs.existsSync(githubFile)) throw new Error(`GitHub credential file not found: ${githubFile}`);
  if (googleFile && !fs.existsSync(googleFile)) throw new Error(`Google credential file not found: ${googleFile}`);
  if (csbFile && !fs.existsSync(csbFile)) throw new Error(`CodeSandbox credential file not found: ${csbFile}`);

  // Delegate to get-codesandbox-credits.js which already implements the full
  // OAuth + storageState save. This keeps a single source of truth for
  // ensureCodeSandboxSignedIn* / Cloudflare handling.
  const extra = [];
  if (csbFile) extra.push('--codesandbox-credentials', csbFile);
  else if (googleFile) extra.push('--google-credentials', googleFile);
  else if (githubFile) extra.push('--credentials', githubFile);
  else if (process.env.GITHUB_PROFILE_DIR) {
    // fallback to persistent profile – get-codesandbox-credits.js will use launchGitHubBrowser
  } else {
    throw new Error('No credentials supplied. Provide --google-credentials, --credentials, or --codesandbox-credentials (or set GOOGLE_AUTH_FILE/GITHUB_AUTH_FILE/CODESANDBOX_AUTH_FILE).');
  }

  // Re-exec via get-codesandbox-credits.js with --save-state.
  // --save-only skips the credits scrape: we only need the session file.
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, 'get-codesandbox-credits.js');
  const nodeArgs = [script, ...extra, '--save-state', outputPath, '--save-only', '--json'];
  if (args.headless === true) nodeArgs.push('--headless');
  if (args.headless === false) nodeArgs.push('--headful');

  console.log(`Saving CodeSandbox session to ${outputPath}...`);
  console.log(`Running: node ${nodeArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

  const env = { ...process.env };
  // Force the callee to not re-use CODESANDBOX_AUTH_FILE as input when we're saving a new one from Google/GitHub
  // (unless explicitly using csbFile as source)
  if (!csbFile && env.CODESANDBOX_AUTH_FILE) delete env.CODESANDBOX_AUTH_FILE;

  const result = spawnSync(process.execPath, nodeArgs, { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);

  // Verify output
  if (!fs.existsSync(outputPath)) throw new Error(`Expected output not found: ${outputPath}`);
  const stat = fs.statSync(outputPath);
  console.log(`\nAuthentication state saved to: ${outputPath} (${stat.size} bytes)`);
  console.log(`Reuse with: node scripts/get-codesandbox-credits.js --codesandbox-credentials ${outputPath} --json`);
  console.log(`Or set: CODESANDBOX_AUTH_FILE=${outputPath}`);
}

main().catch(err => {
  console.error(err.message || err);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
