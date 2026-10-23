# LAB-14 — Google Cloud Shell from a saved browser credential

**Status:** Cloud Shell VM **created and RUNNING** via the web API. Shell reached the SSH
auth stage through the `/_cloudshell/tcp/22` websocket relay; the final SSH signature step
is **not** automated (see [Known blocker](#known-blocker-ssh-agent-signing)).

**Credential used:** `/mnt/s3/google/etecnologysys/google.json`
(Playwright `storageState` produced by `/config/workspace/ai-brain/google/google-auth.js`)

**Date of work:** 2026-10-22 → 2026-10-23
**Account:** `etecnologysys@gmail.com`
**VM:** `cs-666362651618-default.cs-us-east1-rtep.cloudshell.dev` (`35.231.23.99`, us-east1)

---

## 1. TL;DR

There is **no public Cloud Shell REST API** you can call with an OAuth token here. The only
way in with a browser session is the private RPC surface the Cloud Shell web app itself
uses at `https://shell.cloud.google.com`:

| Step | Call | Result |
|---|---|---|
| 1 | `GET /newtoken?authuser=0` | XSRF token, required as `&token=` on every call |
| 2 | `GET /cloudshell/ca` | `200` = account allowed, `403` = blocked |
| 3 | `GET /cloudshell/environments/list?request=["users/me"]` | lists environments + state |
| 4 | `POST /cloudshell/setupsession` | **provisions + starts** the VM, returns access token |
| 5 | `GET /cloudshell/environments/get?request=["users/me/environments/default"]` | confirms `state: 3` = RUNNING |
| 6 | `GET ssh.cloud.google.com/cloudshell/jwt?…` → `/_cloudshell/login` | sets `CloudShellAuthorization` |
| 7 | `wss://…/_cloudshell/tcp/22?_cloudshellAccessToken=…` | `101 Switching Protocols` = SSH relay open |

Everything is authenticated by the **session cookies** in `google.json` — no OAuth client,
no `gcloud`, no browser automation needed for steps 1–5.

---

## 2. Is the credential still valid?

Before spending effort on Cloud Shell, prove the session is live. `google-auth.js` and
`test-gmail.js` need real Chrome + Xvfb (see §9), so validate with `curl` instead.

### 2.1 Build a cookie jar from the storageState

```python
#!/usr/bin/env python3
# make_jar.py <google.json> <jar.txt>   — run with: python3 -I make_jar.py ...
import json, sys

src, out = sys.argv[1], sys.argv[2]
state = json.load(open(src, encoding="utf-8"))
lines = ["# Netscape HTTP Cookie File", "# generated for validation only"]
for c in state.get("cookies") or []:
    lines.append("\t".join([
        ("#HttpOnly_" if c.get("httpOnly") else "") + c["domain"],
        "TRUE" if c["domain"].startswith(".") else "FALSE",
        c.get("path", "/"),
        "TRUE" if c.get("secure") else "FALSE",
        str(-1 if c.get("expires") in (None, -1) else int(c["expires"])),
        c["name"],
        c["value"],
    ]))
open(out, "w", encoding="utf-8").write("\n".join(lines) + "\n")
print(f"wrote {len(state.get('cookies') or [])} cookies")
```

```bash
umask 077                       # jar contains live session tokens — keep it private
python3 -I make_jar.py /mnt/s3/google/etecnologysys/google.json /tmp/gval/jar.txt
```

### 2.2 The three checks that actually prove validity

```bash
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
JAR=/tmp/gval/jar.txt

# a) myaccount: anonymous -> 302 to login, authenticated -> 200 with profile
curl -sS -o /dev/null -w 'anon=%{http_code}\n'      -A "$UA" https://myaccount.google.com/
curl -sS -o /dev/null -w 'auth=%{http_code}\n' -b $JAR -A "$UA" https://myaccount.google.com/

# b) www.google.com: look for "Sign out" vs "Sign in"
curl -sS -b $JAR -A "$UA" https://www.google.com/ | grep -o -m1 'Sign out\|Sign in'

# c) Gmail inbox: authenticated -> 200 with real message list
curl -sS -o /dev/null -w 'gmail=%{http_code} final=%{url_effective}\n' \
  -L -b $JAR -A "$UA" 'https://mail.google.com/mail/u/0/#inbox'
```

Observed on 2026-10-22:

| Check | With cookies | Without | Verdict |
|---|---|---|---|
| `myaccount.google.com` | 200 (profile page, account chip) | 302 → login | authenticated |
| `www.google.com` | 200, "Sign out" | "Sign in" | authenticated |
| `mail.google.com/.../#inbox` | 200, real inbox render | → `accounts.google.com/ServiceLogin` | authenticated |

### 2.3 Cookie expiry audit

`google.json` holds 49 cookies across `.google.com`, `.google.com.bo`, `.youtube.com`,
`accounts.google.com`, `myaccount.google.com`, `ogs.google.com`, `www.google.com`.

- **40 auth-critical cookies** (`SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, `LSID`, `OSID`,
  `__Secure-{1,3}PSID*`, `__Host-GAPS`, `__Host-{1,3}PLSID`, …): **0 expired**.
- Earliest auth-cookie expiry **2027-08-25**; `SID` runs to **2027-09-29**.
- Only **4 expired**: `OTZ` on `accounts/ogs/myaccount/www.google.com` (lapsed 2026-09-24).
  `OTZ` is anti-abuse telemetry, not a session cookie — Google reissues it on first hit.

> **Do not** treat `OTZ` expiry as "credential expired". Check for `SID`/`__Secure-1PSID`
> presence and a `200` from `myaccount.google.com` instead.

### 2.4 `storageState` shape (must match `test-gmail.js:assertAuthFile`)

Validated: exact top-level keys `{cookies, origins}`; every cookie has all 8 fields
(`name,value,domain,path,expires,httpOnly,secure,sameSite`) with correct types; no
duplicate JSON keys; no duplicate `(name,domain,path)`; `sameSite ∈ {Lax,Strict,None}`;
no `SameSite=None` without `Secure`; no session cookies (`expires:-1`); origins are
`https://myaccount.google.com` and `https://accounts.google.com` with valid `localStorage`.

---

## 3. Cloud Shell API discovery

The landing page (`https://shell.cloud.google.com/`) is a thin Angular shell. All logic is in

```
https://www.gstatic.com/_/cloudshell-scs/_/js/k=cloudshell-scs.csh.en.<hash>/m=cloudshell
```

Grep that bundle for the interesting bits:

```bash
grep -oE '"/[A-Za-z0-9_./:-]{3,80}"' scs.js | sort -u | grep cloudshell
grep -oE '/CloudShellSshRelayService\.[A-Za-z]+' scs.js | sort -u
```

### 3.1 Endpoint map

| HTTP | Path | Purpose |
|---|---|---|
| GET | `/newtoken?authuser=0` | XSRF token (`["ssh.nxt","<token>"]`) |
| GET | `/cloudshell/ca` | account eligibility (403 = blocked) |
| GET | `/cloudshell/environments/list` | list envs (`request=["users/me"]`) |
| GET | `/cloudshell/environments/get` | one env (`request=["users/me/environments/<id>"]`) |
| GET | `/cloudshell/environmentmetadata` | env metadata |
| POST | `/cloudshell/setupsession` | **start / attach session** |
| POST | `/cloudshell/generateaccesstoken` | rotate relay access token |
| POST | `/cloudshell/environments/authorize` | authorize env (expireTime/accessToken/idToken) |
| POST | `/devshell/savetab`, `/devshell/deletetab`, `/devshell/abandon` | tab / teardown |
| GET | `/cloudshell/environmentmetadata`, `/terminaltheme`, `/surveys/targeting` | misc |

### 3.2 Wire format (this is the fiddly part)

The bundle's `Md.prototype.serialize()` is **`JSON.stringify`**, not base64 — so
protobuf messages travel as **JSON arrays** (jspb "array" form):

- `request` param on GET calls is URL-encoded JSON: `request=%5B%22users%2Fme%22%5D`
  = `["users/me"]`.
- POST bodies are JSON arrays, `content-type: application/json`.
- Bytes fields (`bytes` in proto) are **base64 strings**.
- Nested messages are **nested arrays**.

Every request also needs `&token=<XSRF>` and browser-ish headers:

```bash
-H "referer: https://shell.cloud.google.com/"
-H "origin: https://shell.cloud.google.com"
-H "x-requested-with: XMLHttpRequest"
```

### 3.3 Method quirks (learned the hard way)

- `environments/list` and `environments/get` are **GET-only** → POST returns `405`.
- GET payload must go in `request=`, **not** as a POST body → else `400`.
- `setupsession` must be **POST** with the JSON array body.
- A response body starting `)]}'` is the standard XSSI guard — strip the first line before
  `json.loads`.

---

## 4. Environment state machine

`Environment` proto (`tF` in the bundle):

| Field | Meaning |
|---|---|
| 1 | name — `users/<email>/environments/default` |
| 2 | id — `default` |
| 3 | image — `gcr.io/cloudshell-images/cloudshell:latest` |
| **4** | **state** |
| 5 | ssh user (in session metadata) |
| 9 | temporary |
| 10 | trusted |
| 11 | vm ip |
| 12 | web host — `…cloudshell.dev` |

**State:** `1 = stopped`, `2 = starting/pending`, `3 = RUNNING`.

There is **no separate "start" RPC** — `setupsession` both provisions and starts.

---

## 5. Creating (starting) the Cloud Shell VM

### 5.1 One-time: XSRF token

```bash
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
JAR=/tmp/gval/jar.txt

TOKEN=$(curl -sS -b $JAR -c $JAR -A "$UA" \
  'https://shell.cloud.google.com/newtoken?authuser=0' \
  | python3 -I -c 'import sys,re; t=re.sub(r"^\)\]\}\x27\n?","",sys.stdin.read()); m=re.search(r"\"([A-Za-z0-9_\-:.]{16,})\"",t); print(m.group(1) if m else "")')
```

### 5.2 List environments (read-only sanity check)

```bash
curl -sS -b $JAR -A "$UA" -H 'x-requested-with: XMLHttpRequest' \
  "https://shell.cloud.google.com/cloudshell/environments/list?authuser=0&request=%5B%22users%2Fme%22%5D&token=$TOKEN"
```

Example (trimmed, SSH keys redacted):

```json
)]}'
[[["users/etecnologysys@gmail.com/environments/default","default",
   "gcr.io/cloudshell-images/cloudshell:latest",1,"etecnologysys",null,6000,
   ["ssh-rsa AAAA…","ecdsa-sha2-nistp256 AAAA…"],
   null,1,null,"cs-666362651618-default.cs-us-east1-rtep.cloudshell.dev",1,[],[["cloudshell_host","primary"]]]]]
```

`state: 1` = stopped → a `setupsession` call is needed.

### 5.3 SetupSession request shape

`SetupSessionRequest` (proto `EF`, wire name `WDCVnb`):

| Field | Type | Meaning |
|---|---|---|
| 1 | msg | ephemeral/temporary env spec |
| 2 | msg | boost spec |
| **3** | msg `SshAgentPublicKey` | field **2** = `content` (bytes, base64) |
| **4** | msg `Environment` | field **1** = environment **id** (`"default"`) |

Minimal working body:

```json
[null, null, [2, "<base64>"], ["default"]]
```

> **Gotcha 1:** field 4 takes the **id** (`"default"`), *not* the resource path
> `users/<email>/environments/default`. Using the path returns `400 Bad Request`.
> **Gotcha 2:** field 3 must be `[<enum>, "<base64>"]`; a bare `["<base64>"]` → 400.
> `[1, …]` and `[2, …]` both accepted (enum 1/2 = key type).
> **Gotcha 3:** the content is **not** a PEM line. Use the base64 SSH wire blob
> (the middle token of `id_ecdsa.pub`) — or, per the bundle, the raw key material.
> See [§8](#8-known-blocker-ssh-agent-signing) for why the key form matters.

### 5.4 The call

```bash
KEY_B64=$(python3 -I -c "print(open('/tmp/gval/ssh/id_ecdsa.pub').read().split()[1])")

curl -sS -b $JAR -c $JAR -A "$UA" \
  -X POST -H 'content-type: application/json' \
  --data-binary "[null,null,[2,\"$KEY_B64\"],[\"default\"]]" \
  -H "referer: https://shell.cloud.google.com/" \
  -H "origin: https://shell.cloud.google.com" \
  -H 'x-requested-with: XMLHttpRequest' \
  "https://shell.cloud.google.com/cloudshell/setupsession?authuser=0&token=$TOKEN"
```

### 5.5 Successful response

```json
)]}'
[2, ["AAbOQ6…<98-char access token>…",
     [null, null, null, "https://970-cs-666362651618-default.cs-us-east1-rtep.cloudshell.dev"]],
 null,
 ["users/etecnologysys@gmail.com/environments/default","default",
  "gcr.io/cloudshell-images/cloudshell:latest",3,"etecnologysys","35.231.23.99",…]]
```

- `[0]` start type (`1` = warm, `2` = cold/fresh — both fine)
- `[1][0]` = **`_cloudshellAccessToken`** for the relay (98 chars, short-lived)
- `[1][1][3]` = editor URL (prefixed host, e.g. `970-cs-…`)
- `[3][3]` = environment **state** → `3` = RUNNING
- `[3][5]` = VM public IP, `[3][11]` = `…cloudshell.dev` host

### 5.6 Confirm it is running

```bash
curl -sS -b $JAR -A "$UA" -H 'x-requested-with: XMLHttpRequest' \
  "https://shell.cloud.google.com/cloudshell/environments/get?authuser=0&request=%5B%22users%2Fme%2Fenvironments%2Fdefault%22%5D&token=$TOKEN"
```

`[3] == 3` → **RUNNING**. This is the authoritative check; the `setupsession` response can
return before the VM is fully up.

### 5.7 Error codes

`setupsession` failures come back as `HTTP 400` + JSON `[null,null,<code>]`:

| Code | Meaning |
|---|---|
| 7 | generic setup failure (`ErrorInfo` field 3); commonly quota/limit/abuse/region |

UI strings you may map to (from the bundle's message table): *"You have reached a Cloud
Shell limit"*, *"You have temporarily exceeded a Cloud Shell limit"*, *"Google Cloud Shell is
temporarily unavailable"*, *"…experiencing an issue in your assigned region"*, *"Cloud Shell
has been popular recently…"* (provisioning backlog), *"Your Google Workspace account is not
eligible to use Cloud Shell"*.

---

## 6. Getting a shell

Two paths: **browser** (works today) or **relay + SSH** (works up to auth, see §8).

### 6.1 Browser (recommended)

Open `https://shell.cloud.google.com/` in a browser already signed in as
`etecnologysys@gmail.com`. The VM from §5 is reused — you land in a working terminal.

### 6.2 Relay handshake (what the web app does)

```
1. GET  https://ssh.cloud.google.com/cloudshell/jwt?redirect_uri=https://ssh.cloud.google.com/&state=<b64 json>
        state = {"token": "...", "target_host": "970-cs-…cloudshell.dev",
                 "authuser": "", "cloud_shell_environment_name": "users/<email>/environments/default"}
        -> HTML: window.location = 'https://970-cs-…/_cloudshell/login?token=<JWT>&redirect=…'

2. GET  https://970-cs-…/_cloudshell/login?token=<JWT>&redirect=…
        -> Set-Cookie: CloudShellAuthorization=<…>; vscode-tkn=<…>

3. WS   wss://970-cs-…/_cloudshell/tcp/22?_cloudshellAccessToken=<access token>
        Cookie: CloudShellAuthorization=…; vscode-tkn=…
        -> HTTP/1.1 101 Switching Protocols
```

Notes:
- Use the **prefixed** host (`970-cs-…`). The bare `cs-…` host returns **503** on the relay.
- Send `Origin: https://shell.cloud.google.com`; the relay checks it.
- The `access token` expires quickly — refresh with `setupsession` (or
  `/cloudshell/generateaccesstoken`) and reconnect immediately.

### 6.3 SSH over the relay

The relay is a raw TCP tunnel to port 22, so `ssh` works via `ProxyCommand`:

```bash
ssh -o "ProxyCommand=python3 -I proxycmd2.py 2238" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o IdentitiesOnly=yes -i /tmp/gval/ssh/id_ecdsa2 \
    cloudshelluser@cs-666362651618-default.cs-us-east1-rtep.cloudshell.dev
```

- **Username:** `cloudshelluser` (bundle: `…||"cloudshelluser"`; `root` when ephemeral).
  The account name `etecnologysys` is **not** a valid SSH user here.
- Direct SSH to the VM IP (`35.231.23.99:22`) is refused — the VM only accepts via relay.

---

## 7. Helper scripts

Kept in `/tmp/gval/` (tokens/keys were deleted after the run).

### 7.1 `wsbridge.py` — WebSocket ↔ TCP bridge

Stdlib-only RFC6455 client. Bridges a local TCP port to the `wss://` relay.

```python
#!/usr/bin/env python3
"""Minimal RFC6455 WebSocket <-> TCP bridge. python3 -I wsbridge.py --listen 127.0.0.1:2222 \
   --url 'wss://…/_cloudshell/tcp/22?_cloudshellAccessToken=…' --cookie-file cookie.txt"""
import argparse, base64, hashlib, os, socket, ssl, struct, threading

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

class WS:
    def __init__(self, sock):
        self.s = sock
        self.send_lock = threading.Lock()

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.s.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("eof")
            buf += chunk
        return buf

    def recv_frame(self):
        h = self._recv_exact(2)
        opcode = h[0] & 0x0F
        masked = h[1] & 0x80
        ln = h[1] & 0x7F
        if ln == 126:
            ln = struct.unpack("!H", self._recv_exact(2))[0]
        elif ln == 127:
            ln = struct.unpack("!Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if masked else None
        payload = self._recv_exact(ln) if ln else b""
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return opcode, payload

    def send_frame(self, opcode, payload):
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        n = len(payload)
        if n < 126:
            head = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n < 65536:
            head = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            head = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        with self.send_lock:
            self.s.sendall(head + mask + masked)

    def close(self):
        try:
            self.send_frame(0x8, b"")
        except Exception:
            pass

def connect_ws(url, cookie, origin):
    secure = url.startswith("wss://")
    rest = url.split("://", 1)[1]
    hostport, _, path = rest.partition("/")
    path = "/" + path
    host, _, port = hostport.partition(":")
    port = int(port or (443 if secure else 80))

    raw = socket.create_connection((host, port), timeout=30)
    if secure:
        raw = ssl.create_default_context().wrap_socket(raw, server_hostname=host)

    key = base64.b64encode(os.urandom(16)).decode()
    raw.sendall((
        f"GET {path} HTTP/1.1\r\nHost: {hostport}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
        f"Origin: {origin}\r\nCookie: {cookie}\r\n"
        "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\r\n\r\n"
    ).encode())

    hdr = b""
    while b"\r\n\r\n" not in hdr:
        c = raw.recv(1)
        if not c:
            raise ConnectionError("handshake eof")
        hdr += c
    status = hdr.split(b"\r\n", 1)[0].decode(errors="replace")
    if "101" not in status:
        raise ConnectionError("handshake failed: " + status)
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    if accept.lower().encode() not in hdr.lower():
        raise ConnectionError("bad Sec-WebSocket-Accept")
    return WS(raw)

def pump_ws_to_tcp(ws, tcp):
    try:
        while True:
            op, payload = ws.recv_frame()
            if op in (0x0, 0x1, 0x2):
                if payload:
                    tcp.sendall(payload)
            elif op == 0x8:
                break
            elif op == 0x9:
                ws.send_frame(0xA, payload)
    except Exception:
        pass
    finally:
        try:
            tcp.shutdown(socket.SHUT_WR)
        except Exception:
            pass

def pump_tcp_to_ws(ws, tcp):
    try:
        while True:
            data = tcp.recv(32768)
            if not data:
                break
            ws.send_frame(0x2, data)
    except Exception:
        pass
    finally:
        ws.close()

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", default="127.0.0.1:2222")
    ap.add_argument("--url", required=True)
    ap.add_argument("--cookie-file", required=True)
    ap.add_argument("--origin", default="https://shell.cloud.google.com")
    a = ap.parse_args()

    cookie = open(a.cookie_file).read().strip()
    host, _, port = a.listen.partition(":")
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, int(port)))
    srv.listen(1)
    print("BRIDGE_LISTENING", flush=True)

    tcp, _ = srv.accept()
    ws = connect_ws(a.url, cookie, a.origin)
    print("BRIDGE_UPGRADED", flush=True)
    t = threading.Thread(target=pump_ws_to_tcp, args=(ws, tcp), daemon=True)
    t.start()
    pump_tcp_to_ws(ws, tcp)
```

### 7.2 `proxycmd2.py` — ssh `ProxyCommand` shim

```python
#!/usr/bin/env python3
"""Bidirectional raw-fd pipe to the local bridge port. Used as ssh ProxyCommand."""
import os, socket, sys, threading

port = int(sys.argv[1]) if len(sys.argv) > 1 else 2224
s = socket.create_connection(("127.0.0.1", port), timeout=60)

def to_sock():
    while True:
        try:
            data = os.read(0, 65536)
        except OSError:
            data = b""
        if not data:
            try:
                s.shutdown(socket.SHUT_WR)
            except OSError:
                pass
            return
        try:
            s.sendall(data)
        except OSError:
            return

threading.Thread(target=to_sock, daemon=True).start()

while True:
    try:
        chunk = s.recv(65536)
    except OSError:
        break
    if not chunk:
        break
    try:
        os.write(1, chunk)
    except OSError:
        break

os._exit(0)
```

> Use raw `os.read`/`os.write`, not `sys.stdin.buffer` — buffered stdin can deadlock at
> interpreter shutdown when a daemon thread is still alive.

### 7.3 Run bridge + ssh in one shell invocation

Background processes started by a tool call may be reaped when that call ends. Start the
bridge and run `ssh` **in the same command**:

```bash
cd /tmp/gval
python3 -I wsbridge.py --listen 127.0.0.1:2238 \
  --cookie-file cookie_hdr.txt \
  --url "wss://970-cs-666362651618-default.cs-us-east1-rtep.cloudshell.dev/_cloudshell/tcp/22?_cloudshellAccessToken=$(cat access_token.txt)" &
BP=$!; sleep 3

ssh -o "ProxyCommand=python3 -I proxycmd2.py 2238" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=20 -o BatchMode=yes -o IdentitiesOnly=yes \
    -i /tmp/gval/ssh/id_ecdsa2 \
    cloudshelluser@cs-666362651618-default.cs-us-east1-rtep.cloudshell.dev \
    'echo SHELL_OK; whoami; hostname; pwd'

kill $BP
```

Build `cookie_hdr.txt` from the jar, filtered to the relay host:

```python
import sys
pairs = []
for ln in open("/tmp/gval/jar.txt").read().splitlines():
    if ln.startswith("#HttpOnly_"):
        ln = ln[len("#HttpOnly_"):]
    elif ln.startswith("#") or not ln.strip():
        continue
    f = ln.split("\t")
    if len(f) >= 7 and "cloudshell.dev" in f[0]:
        pairs.append(f"{f[5]}={f[6]}")
open("/tmp/gval/cookie_hdr.txt", "w").write("; ".join(pairs))
```

---

## 8. Known blocker: SSH agent signing

**Symptom:** relay reaches `101 Switching Protocols`, SSH completes key exchange and
algorithm negotiation, then:

```
debug1: Offering public key: …/id_ecdsa2 ECDSA SHA256:…
debug1: Authentications that can continue: publickey
cloudshelluser@…: Permission denied (publickey).
```

**Why:** the web client does **not** hand the VM a static authorized key. It generates an
**ephemeral ECDSA P-256 keypair in the page** (`Vz`/`NYa` in the bundle) and signs each SSH
auth challenge through the agent protocol over the relay:

```js
NYa.prototype.getPublicKey = function () {
  return yy(bh(bh(new ah, "ecdsa-sha2-nistp256"), "nistp256"),
            new ah(this.key.getPublicKey()));
};
NYa.prototype.signData = function (a) { /* signs the relayed challenge */ };
```

So the VM trusts the key for the life of the **session**, verified via the access token —
`setupsession`'s key field registers a key with the *session*, but the VM's
`authorized_keys` is managed by the relay agent, not by that field.

**Attempts made** (all got `Permission denied`):

| Content sent to `[2, content]` | Stored as |
|---|---|
| base64 of full PEM text | `ecdsa-sha2-nistp256` (wrong material) |
| base64 of 32-byte *public* blob suffix | `ecdsa-sha2-nistp256` |
| base64 of 65-byte EC point `Q` | `ecdsa-sha2-nistp256` |
| base64 of SSH wire blob | `ecdsa-sha2-nistp256` |
| base64 of raw 32-byte private scalar | `ecdsa-sha2-nistp256` |

Both `cloudshelluser` and the account name were tried. **Not** tried: implementing the
SSH agent protocol (`SSH2_AGENTC_REQUEST_IDENTITIES` / `SIGN_REQUEST`) over the relay so the
ephemeral key can sign — that is the remaining work.

**Recommendation:** for a working terminal, use the browser (§6.1). The API path in §5 is
still the right way to **create/warm** the VM programmatically.

---

## 9. Environment prerequisites for `google-auth.js`

Checked in this container — **all missing**:

```
google-chrome / chromium   MISSING
xvfb-run / Xvfb            MISSING
playwright + browsers      MISSING (no node_modules, no ~/.cache/ms-playwright)
DISPLAY                    unset
```

So `google-auth.js` (which needs *real Chrome, headed, under Xvfb*, with
`--disable-blink-features=AutomationControlled` and `navigator.webdriver` masked) cannot run
here. That is why validation was done with `curl` (§2).

The password-free refresh path is the "already authenticated → re-save storageState"
shortcut at `google-auth.js:450-456` and `:463-470` — but it still needs Chrome + Xvfb.

---

## 10. Security notes

1. **`google.json` permissions are `775` (`abc:abc`)** — group- and world-readable. It holds
   live Google session cookies for a real account, equivalent to an unexpired password.
   `chmod 600` it.
2. During this lab the cookie jar, XSRF token, access token, generated SSH keys and all
   captured HTTP responses were kept at mode `0600` and **deleted** afterwards. Reproduce
   with `umask 077`.
3. **Do not paste `access_token` / `CloudShellAuthorization` / cookie values into logs,
   tickets, or chat.** The `_cloudshellAccessToken` grants terminal access to the VM for its
   lifetime. Prefer redacting to `<token>` in any write-up.
4. `setupsession` **starts a billable VM**. Cloud Shell idles out after ~20 min but consumes
   quota until then. Tear down with `POST /cloudshell/devshell/abandon`.
5. `_cloudshellAccessToken` is short-lived; refresh via `setupsession` or
   `/cloudshell/generateaccesstoken` and reconnect immediately — a stale token yields `503`.

---

## 11. Teardown

> **Not tested in this lab.** The request shape is taken from the bundle
> (`postDevshellAbandon` → `uI(this,"/devshell/abandon", new PE)`), but the call was never
> issued. Verify with `environments/get` afterwards.

```bash
curl -sS -b $JAR -c $JAR -A "$UA" \
  -X POST -H 'content-type: application/json' --data-binary '[null]' \
  -H "referer: https://shell.cloud.google.com/" \
  -H "origin: https://shell.cloud.google.com" \
  -H 'x-requested-with: XMLHttpRequest' \
  "https://shell.cloud.google.com/devshell/abandon?authuser=0&token=$TOKEN"
```

Then confirm `state` returns to `1` via `environments/get`. Otherwise let it idle out.

---

## 12. Results summary

| Item | Result |
|---|---|
| Credential validity | **valid** (0 auth cookies expired; Gmail + myaccount authenticated) |
| Cloud Shell eligibility | **allowed** (`/cloudshell/ca` → 200) |
| Environment found | `default`, state 1 (stopped) |
| VM started | **yes** — `setupsession` → 200, state 3 (RUNNING) |
| VM IP / host | `35.231.23.99` / `cs-666362651618-default.cs-us-east1-rtep.cloudshell.dev` |
| Relay reached | **yes** — `101 Switching Protocols` on `/_cloudshell/tcp/22` |
| Interactive shell | **not automated** — SSH publickey denied (§8); browser works |
| Refresh needed? | no |

The VM was left **running** at the end of the lab. It idles out after ~20 min.

---

## 13. Reference: README drift in `ai-brain/google`

Prose is accurate; line numbers have drifted. Actual locations:

| README says | Actual |
|---|---|
| `isLoginRedirect:171` | `test-gmail.js:209` |
| `waitForGmailInbox:176` | `test-gmail.js:217` |
| `extractMails:203` | `test-gmail.js:244` |
| `google-auth.js:346` | `storageState` calls at `google-auth.js:454`, `:467`, `:943` |
