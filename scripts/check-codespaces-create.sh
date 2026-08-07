#!/usr/bin/env bash
#
# check-codespaces-create.sh
#
# Verifies whether a VM (codespace) can be created using a GitHub credential
# via the `gh` CLI. Mirrors what the play-with-docker backend's Codespaces
# provider does on create: authenticate with the token, then list codespaces.
#
# The backend's create now ADOPTS the first existing codespace for the account
# (it does not create one). This script reports the account, how many codespaces
# it has, whether creation itself is permitted by GitHub, and the first VM's name.
#
# Usage:
#   ./scripts/check-codespaces-create.sh <credential.json> [<codespace-name>]
#
# Prerequisites:
#   - `gh` on PATH (or GH_BIN pointing at a gh binary)
#   - the credential file containing { "token": "<PAT>" }
#
set -euo pipefail

CRED_FILE="${1:-}"
TARGET_NAME="${2:-}"
GH_BIN="${GH_BIN:-gh}"

if [[ -z "$CRED_FILE" ]]; then
  echo "Usage: $0 <credential.json> [<codespace-name>]" >&2
  exit 2
fi
if [[ ! -f "$CRED_FILE" ]]; then
  echo "ERROR: credential file not found: $CRED_FILE" >&2
  exit 2
fi
if ! command -v "$GH_BIN" >/dev/null 2>&1; then
  echo "ERROR: '$GH_BIN' not found on PATH. Install gh or set GH_BIN." >&2
  exit 2
fi

# Extract token (JSON {token} or plain-text)
TOKEN="$(node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1],"utf8").trim();try{const j=JSON.parse(s);process.stdout.write((j.token||"").trim())}catch{process.stdout.write(s)}' "$CRED_FILE")"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: no token found in $CRED_FILE" >&2
  exit 2
fi
export GH_TOKEN="$TOKEN"

echo "== Credential =="
echo "file: $CRED_FILE"

echo
echo "== Step 1: validate token =="
login="$("$GH_BIN" api user --jq .login)"
echo "login: $login"
id="$("$GH_BIN" api user --jq .id)"
echo "id: $id"

echo
echo "== Step 2: list existing codespaces (what backend create uses) =="
# Use JSON output for reliable parsing/counting, driven by the credential token.
set +e
cs_json="$("$GH_BIN" codespace list --json name,state 2>&1)"
cs_rc=$?
set -e
echo "list rc: $cs_rc"
echo "---"
echo "$cs_json"
echo "---"

# Count codespaces from the JSON array
count="$(printf '%s' "$cs_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);console.log(Array.isArray(a)?a.length:0)}catch{console.log(0)}})' 2>/dev/null || echo 0)"
echo "existing codespaces: $count"

first_name=""
if [[ "$count" -gt 0 ]]; then
  first_name="$(printf '%s' "$cs_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);console.log(a[0]?.name||"")}catch{}})' 2>/dev/null || echo "")"
  echo "first codespace name: ${first_name:-<none>}"
fi

echo
echo "== Step 3: can this account create a codespace? =="
# The decisive check: attempt the GitHub API POST for create. Codespaces has a
# per-account provision throttle (HTTP 429, resource "codespaces"). A 2xx means
# creation is allowed; 429/403 means GitHub is limiting provisioning.
create_status="$(curl -sS -o /tmp/cs-create-body.json -w '%{http_code}' -X POST \
  "https://api.github.com/user/codespaces" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  -d "{\"repository_id\":$(node -e 'process.stdout.write(process.env.CODESPACES_DEFAULT_REPOSITORY_ID||"1318669895")'),\"ref\":\"main\",\"machine\":\"basicLinux32gb\",\"geo\":\"UsEast\"}" 2>/dev/null || echo 000)"
echo "create HTTP status: $create_status"

# The backend's create now ADOPTS the first existing codespace, so creation is
# not required for the app to work. Still, report whether GitHub permits a new
# codespace (per-account provision throttle).
if [[ "$count" -gt 0 ]]; then
  echo "RESULT: The app can reuse an existing VM -> ${first_name:-<first codespace>} (available for adoption)."
else
  echo "RESULT: No existing codespaces. The app would error with 'No existing Codespaces VM found'."
fi

case "$create_status" in
  2*)
    echo "RESULT: CAN ALSO create a new codespace (HTTP $create_status)"
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log("  name:",j.name);console.log("  state:",j.state);console.log("  web_url:",j.web_url||"")}catch{console.log("  (non-JSON body)")}})' < /tmp/cs-create-body.json
    echo "NOTE: A codespace was created by this check. Stop or delete it if you don't need it:"
    echo "  gh codespace stop -c $(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).name)}catch{}})') 2>/dev/null || true"
    exit 0
    ;;
  429|403)
    echo "RESULT: GitHub is THROTTLING codespace creation for this account (HTTP $create_status)."
    echo "  The credential is valid, but provisioning is rate-limited. Wait and retry, or use the GitHub web UI."
    exit 1
    ;;
  *)
    echo "RESULT: UNKNOWN create status HTTP $create_status."
    echo "  Body:"; cat /tmp/cs-create-body.json 2>/dev/null | head -c 400; echo
    exit 1
    ;;
esac
