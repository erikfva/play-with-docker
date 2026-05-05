#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
KEEP_SANDBOX="${KEEP_SANDBOX:-0}"
SANDBOX_TITLE="${SANDBOX_TITLE:-api-token-smoke-test}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Create .env and set CSB_API_KEY or CODESANDBOX_API_KEY." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

CSB_TOKEN="${CSB_API_KEY:-${CODESANDBOX_API_KEY:-}}"

if [ -z "$CSB_TOKEN" ]; then
  echo "Missing CodeSandbox token." >&2
  echo "Set CSB_API_KEY or CODESANDBOX_API_KEY in $ENV_FILE." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codesandbox-api-test.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat > "$TMP_DIR/package.json" <<'JSON'
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@codesandbox/sdk": "latest"
  }
}
JSON

cat > "$TMP_DIR/test-codesandbox-api.mjs" <<'JS'
import { CodeSandbox } from "@codesandbox/sdk";

const token = process.env.CSB_API_KEY || process.env.CODESANDBOX_API_KEY;
const keepSandbox = process.env.KEEP_SANDBOX === "1";
const title = process.env.SANDBOX_TITLE || "api-token-smoke-test";

if (!token) {
  throw new Error("CSB_API_KEY or CODESANDBOX_API_KEY is required");
}

const sdk = new CodeSandbox(token);
let sandbox;

try {
  sandbox = await sdk.sandboxes.create({
    title,
    privacy: "private",
    hibernationTimeoutSeconds: 300,
  });

  const client = await sandbox.connect();
  let commandOutput;

  try {
    commandOutput = await client.commands.run("echo codesandbox-api-ok && pwd");
  } finally {
    if (typeof client.dispose === "function") {
      await client.dispose();
    }
  }

  const response = {
    ok: true,
    sandbox: {
      id: sandbox.id,
      title,
      cluster: sandbox.cluster ?? null,
      bootupType: sandbox.bootupType ?? null,
      isUpToDate: sandbox.isUpToDate ?? null,
    },
    commandOutput,
    deleted: false,
  };

  if (!keepSandbox) {
    await sdk.sandboxes.delete(sandbox.id);
    response.deleted = true;
  }

  console.log(JSON.stringify(response, null, 2));
} catch (error) {
  if (sandbox?.id && !keepSandbox) {
    try {
      await sdk.sandboxes.delete(sandbox.id);
    } catch (_) {
      // Best-effort cleanup after a failed smoke test.
    }
  }

  console.error(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
    name: error?.name || null,
    status: error?.status || error?.statusCode || null,
  }, null, 2));
  process.exit(1);
}
JS

echo "Installing @codesandbox/sdk in temporary directory..."
npm install --prefix "$TMP_DIR" --silent

echo "Testing CodeSandbox API token with official SDK..."
CSB_API_KEY="$CSB_TOKEN" \
KEEP_SANDBOX="$KEEP_SANDBOX" \
SANDBOX_TITLE="$SANDBOX_TITLE" \
node "$TMP_DIR/test-codesandbox-api.mjs"
