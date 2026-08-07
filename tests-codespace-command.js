#!/usr/bin/env node
/**
 * Standalone test: run a command in an EXISTING GitHub Codespace VM,
 * using exactly the mechanism the play-with-docker app uses
 * (src/services/providers/codespaces/cli-executor.js).
 *
 * The credential file only needs { "token": "<PAT>" }; the codespace is
 * addressed by its name, like the app addresses a session's providerSessionId.
 *
 * Usage:
 *   node tests-codespace-command.js <codespace-name> "<command>"
 *   GH_TOKEN_FILE=/path/to/credential.json node ... (defaults to the santi account file)
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_CRED = '/project/workspace/config/workspace/play-with-docker/credentials/codespaces/vm-manager1-santi.json';
const credFile = process.env.GH_TOKEN_FILE || DEFAULT_CRED;

const codespaceName = process.argv[2];
const command = process.argv[3];

if (!codespaceName || !command) {
  console.error('Usage: node tests-codespace-command.js <codespace-name> "<command>"');
  process.exit(1);
}

function loadToken(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === 'string') return parsed.token.trim();
  } catch {
    /* not JSON -> treat whole file as token */
  }
  return raw;
}

const token = loadToken(credFile);
if (!token) {
  console.error(`No token found in ${credFile}`);
  process.exit(1);
}

console.log(`codespace: ${codespaceName}`);
console.log(`command:   ${command}`);
console.log('--- exec (mirroring cli-executor.js, no timeout override) ---');

// Mirrors cli-executor.js: execFile('gh', ['codespace','ssh','-c',<name>,'--',<cmd>], {env:{GH_TOKEN}})
execFile(
  'gh',
  ['codespace', 'ssh', '-c', codespaceName, '--', command],
  { env: { ...process.env, GH_TOKEN: token } },
  (error, stdout, stderr) => {
    if (error) {
      console.error('ERROR:', error.message);
      console.error(stderr);
      process.exit(error.killed ? 124 : 1);
    }
    process.stdout.write(stdout + stderr);
    process.stdout.write('\n');
    console.log('--- rc 0 (success) ---');
  }
);