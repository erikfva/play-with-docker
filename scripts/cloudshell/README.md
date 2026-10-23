# scripts/cloudshell

Create, inspect, and **run commands in** a Google Cloud Shell VM using a saved
Google browser session (a Playwright `storageState` file).

No third-party dependencies — Python 3 stdlib only (`urllib`, `socket`, `ssl`) plus
the system `ssh`/`ssh-keygen` binaries. Browser automation, `gcloud`, and an OAuth
client are all unnecessary.

Protocol details and the evidence behind each step live in
[`ai/LAB-14_google-cloudshell/research.md`](../../ai/LAB-14_google-cloudshell/research.md).

---

## Quick start

```bash
cd scripts/cloudshell

# 1. Is the saved session still alive?
./cloudshell.py validate

# 2. Is a VM already up?
./cloudshell.py list

# 3. Start one (waits for RUNNING)
./cloudshell.py start --wait

# 4. Run something
./cloudshell.py exec -- ls -la
./cloudshell.py exec -- 'docker ps && uname -a'

# 5. Interactive shell
./cloudshell.py shell

# 6. Tear down (stops billing)
./cloudshell.py abandon
```

Default credential path:
`/config/workspace/play-with-docker/credentials/google/etecnologysys/google.json`.
Override with `--credentials` or `$GOOGLE_AUTH_FILE`.

---

## Why this is not a normal REST client

Cloud Shell has **no public API** usable with a browser session. Everything goes
through the private RPC surface the Cloud Shell web app itself calls. Three things
in that surface are easy to get wrong, and all three are handled here:

| Trap | Symptom if unhandled | Handled by |
|---|---|---|
| `newtoken` / `cloudshell/ca` need redirects followed, and the Cookie header must survive the redirect | `302` to a sign-in page, which looks exactly like an expired credential | manual redirect loop in `http_request()` |
| The relay needs a `CloudShellAuthorization` cookie from `/_cloudshell/login` first | websocket `503` (looks like a wrong host) | `relay_login()` |
| The login URL is written with JS escapes (`\x26` = `&`) | `400` with an empty body | `_unescape_js()` |
| SSH username is the **account name**, not `cloudshelluser` | `Permission denied (publickey)` | `Session.ssh_user` |

The `urllib` redirect handler is not used on purpose: it rebuilds the request and
drops our `Cookie` header, which breaks Google's redirect chains. `http_request()`
follows hops itself so cookies are re-read from the store on every hop and each
response's `Set-Cookie` is fed back in.

Set `CLOUDSHELL_TRACE=1` to print every hop (`[http] 302 shell.cloud.google.com/…`).
It logs status codes and hosts only — never token values.

---

## Commands

### `validate`

Proves the saved session is live before you spend quota. Prints JSON.

```bash
./cloudshell.py validate
```

Exit `0` when authenticated, `1` with `CREDENTIAL_INVALID` otherwise.

Signals used, strongest first:

- `myaccount.google.com` → `200` authenticated, `302` not
- `mail.google.com/mail/feed/atom` → `401` means **not** authenticated
  (`mail.google.com/.../#inbox` returns `200` either way — do not use it)
- `SID` / `__Secure-1PSID` present in the cookie set

Expired `OTZ` cookies are normal and not an auth failure.

### `list`

```bash
./cloudshell.py list
./cloudshell.py list --json
```

```
default      RUNNING  etecnologysys    34.168.245.26    cs-666362651618-default.cs-us-west1-ijlt.cloudshell.dev
```

### `start`

Calls `setupsession`, which **provisions and starts** (there is no separate start
RPC). Registers the local SSH key with the environment.

```bash
./cloudshell.py start --wait          # poll until RUNNING (default timeout 90s)
./cloudshell.py start --json
./cloudshell.py start --timeout 180
```

The environment usually already exists but sits at `state 1` (STOPPED); `start`
brings it to `state 3` (RUNNING). `setupsession` failure codes are surfaced as
`SETUP_REJECTED` — code `7` means quota/limit/abuse/region.

### `status`

```bash
./cloudshell.py status
./cloudshell.py status --json
```

Reports state, IP, host, SSH user, and how many keys are registered.

### `exec`

Runs a command in the VM over SSH through the relay. **This is the point of the
tool.** Exit status is the remote command's exit status.

```bash
./cloudshell.py exec -- ls
./cloudshell.py exec -- 'whoami; hostname; uname -a'
./cloudshell.py exec -- docker ps
./cloudshell.py exec -- 'exit 7' ; echo $?     # → 7
```

Everything after `--` is joined into one remote command string. `exec` wakes the
VM automatically if it is stopped.

### `shell`

Interactive SSH session (`ssh -t`). Ctrl-D / `exit` to leave.

```bash
./cloudshell.py shell
```

### `bridge`

Debug helper: performs the full handshake, opens the relay, and prints the SSH
banner. Useful to separate "relay/auth is broken" from "SSH auth is broken".

```bash
./cloudshell.py bridge
# relay: 101 OK, first frame opcode=2 len=43
# banner: SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.19
```

### `abandon`

`POST /devshell/abandon`, then verify with `status` (expect `state 1`).

> **Untested.** LAB-14 §11 never exercised this call. It is the documented teardown
> path and the request shape comes from the JS bundle, but confirm the state
> actually drops with `./cloudshell.py status` before trusting it. Otherwise the VM
> idles out after ~20 minutes.

---

## Options

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--credentials`, `-c` | `GOOGLE_AUTH_FILE` | `…/credentials/google/etecnologysys/google.json` | Playwright `storageState` |
| `--state-dir` | `CLOUDSHELL_STATE_DIR` | `scripts/cloudshell/.state` | tokens/keys, created mode `0700` |
| `--verbose`, `-v` | | off | progress on stderr |
| | `CLOUDSHELL_TRACE` | off | log every HTTP hop (status + host only) |

Exit codes: `0` success · `1` runtime/API failure · `2` usage or bad credential file
· `130` interrupted · otherwise the remote command's own exit status (`exec`).

---

## What ends up on disk

`--state-dir` (default `scripts/cloudshell/.state/`, mode `0700`):

| Path | Contents | Sensitivity |
|---|---|---|
| `ssh/id_ecdsa`, `.pub` | SSH keypair, generated on first use | **private key — full command execution in the VM** |
| `access_token` | `_cloudshellAccessToken`, short-lived | grants relay access; rotate by re-running `start` |
| `relay_cookie` | `CloudShellAuthorization` | short-lived |
| `session.json` | last `setupsession` result (env, editor URL, start time) | metadata only |

The keypair is **durable**: `setupsession` appends the public key to the
environment's key array, so the same private key keeps working on later sessions
(it appears at index 9 of 10 on the lab account). Treat it as a credential and
delete it when you are done.

`cloudshell.py` never writes tokens to stdout. The only things it prints are status
codes, lengths, and environment metadata.

---

## Files

| File | Purpose |
|---|---|
| `cloudshell.py` | The whole client: cookie store, HTTP, API calls, WebSocket bridge, SSH driver |
| `proxycmd.py` | `ssh` `ProxyCommand` shim — pipes stdio to the local bridge port |
| `README.md` | This file |

The bridge lives inside `cloudshell.py`; `proxycmd.py` is a separate process because
`ssh` execs it.

---

## Troubleshooting

**`CREDENTIAL_INVALID` / `validate` fails on `myaccount`** — the saved session is
genuinely dead. Re-run `ai-brain/google/google-auth.js` to regenerate `google.json`.
Expired `OTZ` cookies are not the cause.

**`RELAY_HANDSHAKE_FAILED` with `503`** — `/_cloudshell/login` did not run or did not
return `CloudShellAuthorization`. The host is *not* the problem. Re-run `start`.

**`Permission denied (publickey)`** — the SSH user must be the **account name**
(`etecnologysys`), which `cloudshell.py` reads from the environment's field 4. If you
are driving `ssh` by hand, `cloudshelluser` is the wrong value.

**`ConnectionRefusedError` / `Connection closed by UNKNOWN`** — the bridge accepts a
single connection. Each `ssh` invocation needs a fresh bridge; `cloudshell.py exec`
creates one per call.

**Everything worked, then stopped after ~20 min** — Cloud Shell idles out. Re-run
`exec` (it wakes the VM) or `start --wait`.

---

## Relation to the lab write-up

This tool is the executable form of `ai/LAB-14_google-cloudshell/research.md` §5
(create), §6.2a (relay authorisation), and §8.1 (SSH command execution). The lab doc
also covers the protocol discovery, error-code tables, and the corrections that
overturned its original "SSH blocker" conclusion — read it when something behaves
differently from what is documented here.
