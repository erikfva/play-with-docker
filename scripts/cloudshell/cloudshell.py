#!/usr/bin/env python3
"""
cloudshell.py — control Google Cloud Shell VMs from a saved browser session.

Reuses the private Cloud Shell web app RPC surface (there is no public REST API
usable with a browser session). See ai/LAB-14_google-cloudshell/research.md for
the protocol write-up and the reasoning behind each step.

Subcommands:
    validate    Check that the credential's session is still live
    list        List Cloud Shell environments and their state
    start       Provision + start the environment (setupsession), wait for RUNNING
    status      Show one environment's state
    exec        Run a command in the VM over the relay (SSH)
    shell       Open an interactive SSH shell in the VM
    bridge      Open the relay only and print the SSH banner (debug)
    abandon     Tear the VM down (untested — verify with `status`)

No third-party dependencies: HTTP via urllib, WebSocket via a stdlib RFC6455
client, SSH via the system `ssh` binary and a ProxyCommand shim.

The credential is a Playwright storageState file (the shape produced by
ai-brain/google/google-auth.js).
"""

import argparse
import base64
import hashlib
import json
import os
import re
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from email.utils import parsedate_to_datetime
from http.cookies import SimpleCookie

SHELL_HOST = "https://shell.cloud.google.com"
SSH_LOGIN_HOST = "https://ssh.cloud.google.com"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

STATE_RUNNING = 3
STATE_NAMES = {1: "STOPPED", 2: "STARTING", 3: "RUNNING"}

DEFAULT_CREDENTIAL = "/config/workspace/play-with-docker/credentials/google/etecnologysys/google.json"
DEFAULT_STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".state")

HERE = os.path.dirname(os.path.abspath(__file__))
PROXY_SHIM = os.path.join(HERE, "proxycmd.py")


# --------------------------------------------------------------------------- #
# errors
# --------------------------------------------------------------------------- #

class CloudShellError(Exception):
    def __init__(self, message, code=None, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


# --------------------------------------------------------------------------- #
# cookie store
# --------------------------------------------------------------------------- #

class CookieStore:
    """Minimal RFC6265 cookie store backed by a Playwright storageState file.

    Deliberately hand-rolled rather than using http.cookiejar so that domain
    matching, the `__Host-`/`__Secure-` prefixes, and Set-Cookie rotation behave
    exactly as observed against Google (LAB-14 §5.1a).
    """

    def __init__(self, path=None):
        self.cookies = []
        if path:
            self.load(path)

    def load(self, path):
        with open(path, encoding="utf-8") as fh:
            state = json.load(fh)
        if not isinstance(state, dict) or "cookies" not in state:
            raise CloudShellError(
                f"{path} is not a Playwright storageState (no 'cookies' key)",
                code="BAD_CREDENTIAL_FILE")
        self.cookies = []
        for c in state.get("cookies") or []:
            self._put(
                name=c["name"], value=c["value"], domain=c["domain"],
                path=c.get("path", "/"),
                expires=c.get("expires"),
                secure=bool(c.get("secure")),
                http_only=bool(c.get("httpOnly")),
            )

    def _put(self, name, value, domain, path, expires, secure, http_only):
        for i, c in enumerate(self.cookies):
            if c["name"] == name and c["domain"] == domain and c["path"] == path:
                self.cookies[i] = {
                    "name": name, "value": value, "domain": domain, "path": path,
                    "expires": expires, "secure": secure, "http_only": http_only,
                }
                return
        self.cookies.append({
            "name": name, "value": value, "domain": domain, "path": path,
            "expires": expires, "secure": secure, "http_only": http_only,
        })

    def _matches(self, cookie, host, path, scheme):
        domain = cookie["domain"]
        if domain.startswith("."):
            bare = domain[1:]
            if host != bare and not host.endswith(domain):
                return False
        elif host != domain:
            return False
        if cookie["secure"] and scheme != "https":
            return False
        if not path.startswith(cookie["path"]):
            return False
        exp = cookie.get("expires")
        if exp not in (None, -1) and float(exp) < time.time():
            return False
        return True

    def header_for(self, url):
        parts = urllib.parse.urlsplit(url)
        host, path, scheme = parts.hostname or "", parts.path or "/", parts.scheme
        picked = [c for c in self.cookies if self._matches(c, host, path, scheme)]
        # Longest path first, per RFC6265 §5.4 ordering.
        picked.sort(key=lambda c: len(c["path"]), reverse=True)
        return "; ".join(f"{c['name']}={c['value']}" for c in picked)

    def update_from_headers(self, url, headers):
        parts = urllib.parse.urlsplit(url)
        host = parts.hostname or ""
        default_path = parts.path.rsplit("/", 1)[0] or "/"
        for raw in headers:
            sc = SimpleCookie()
            try:
                sc.load(raw)
            except Exception:
                continue
            for name, morsel in sc.items():
                domain = morsel["domain"] or host
                if morsel["domain"] and not morsel["domain"].startswith("."):
                    domain = "." + morsel["domain"] if "." in morsel["domain"] else domain
                expires = morsel["expires"] or morsel["max-age"] or None
                if morsel["max-age"]:
                    try:
                        expires = time.time() + int(morsel["max-age"])
                    except ValueError:
                        expires = None
                elif morsel["expires"]:
                    try:
                        expires = parsedate_to_datetime(morsel["expires"]).timestamp()
                    except Exception:
                        expires = None
                if name.startswith("__Host-"):
                    domain, path = host, "/"
                else:
                    path = morsel["path"] or default_path
                self._put(
                    name=name, value=morsel.value, domain=domain, path=path,
                    expires=expires,
                    secure=bool(morsel["secure"]) or name.startswith("__Secure-")
                    or name.startswith("__Host-"),
                    http_only=bool(morsel["httponly"]),
                )

    def save(self, path):
        state = {"cookies": [], "origins": []}
        for c in self.cookies:
            state["cookies"].append({
                "name": c["name"], "value": c["value"], "domain": c["domain"],
                "path": c["path"],
                "expires": -1 if c["expires"] in (None, -1) else float(c["expires"]),
                "httpOnly": c["http_only"], "secure": c["secure"],
                "sameSite": "Lax",
            })
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2)
        os.replace(tmp, path)

    def auth_summary(self):
        names = {c["name"] for c in self.cookies}
        now = time.time()
        expired = [c for c in self.cookies
                   if c.get("expires") not in (None, -1) and float(c["expires"]) < now]
        return {
            "total": len(self.cookies),
            "expired": [{"name": c["name"], "domain": c["domain"]} for c in expired],
            "has_sid": "SID" in names,
            "has_psid": "__Secure-1PSID" in names,
        }


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _Req:
    """A tiny response record, returned by http_request."""

    def __init__(self, status, url, body, headers):
        self.status = status
        self.url = url
        self.body = body
        self.headers = headers

    @property
    def text(self):
        return self.body.decode("utf-8", "replace")


def _say(text):
    if os.environ.get("CLOUDSHELL_TRACE"):
        print(f"[http] {text}", file=sys.stderr)


def http_request(url, store, method="GET", body=None, headers=None,
                 follow=True, timeout=45, max_redirects=8):
    """One HTTP request, following redirects **manually**.

    urllib's own redirect handler has two problems here:
      * it drops our `Cookie` header when rebuilding the request;
      * it cannot be told to stop and hand us the `Set-Cookie` of a 302.

    Google's redirect chains (newtoken, /cloudshell/ca, /_cloudshell/login) all
    depend on cookies surviving, and the login step needs the 302 itself. So we
    follow redirects by hand: rebuild headers on every hop, re-read cookies from
    the store, and feed each response's Set-Cookie back in.
    """
    current = url
    for _hop in range(max_redirects + 1):
        hdrs = {
            "user-agent": UA,
            "accept": "*/*",
            "referer": SHELL_HOST + "/",
            "origin": SHELL_HOST,
            "x-requested-with": "XMLHttpRequest",
        }
        if headers:
            hdrs.update(headers)
        cookie = store.header_for(current)
        if cookie:
            hdrs["cookie"] = cookie
        data = body.encode() if isinstance(body, str) else body
        if data is not None and "content-type" not in hdrs:
            hdrs["content-type"] = "application/json"

        req = urllib.request.Request(current, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.build_opener(_NoRedirect).open(
                    req, timeout=timeout) as resp:
                raw = resp.read()
                status = resp.status
                hdrs_out = resp.headers
        except urllib.error.HTTPError as e:
            raw = e.read()
            status = e.code
            hdrs_out = e.headers
        except urllib.error.URLError as e:
            raise CloudShellError(f"network error: {e.reason}",
                                  code="NETWORK_ERROR",
                                  details={"url": current}) from e

        store.update_from_headers(current, hdrs_out.get_all("Set-Cookie") or [])
        _say(f"{status} {urllib.parse.urlsplit(current).netloc}"
             f"{urllib.parse.urlsplit(current).path}")

        location = hdrs_out.get("location")
        if follow and status in (301, 302, 303, 307, 308) and location:
            current = urllib.parse.urljoin(current, location)
            if status == 303 or (status in (301, 302) and method == "POST"):
                method, body = "GET", None
            continue
        return _Req(status, current, raw, hdrs_out)

    raise CloudShellError("too many redirects", code="REDIRECT_LOOP",
                          details={"url": url})


def strip_xssi(raw):
    if isinstance(raw, _Req):
        raw = raw.body
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    return re.sub(r"^\)\]\}'\s*\n?", "", text).strip()


def jload(raw):
    text = strip_xssi(raw)
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise CloudShellError(f"unexpected non-JSON response: {text[:200]!r}",
                              code="BAD_RESPONSE", details={"error": str(e)})


# --------------------------------------------------------------------------- #
# Cloud Shell API
# --------------------------------------------------------------------------- #

class CloudShell:
    def __init__(self, store, state_dir=DEFAULT_STATE_DIR, verbose=False):
        self.store = store
        self.state_dir = state_dir
        self.verbose = verbose
        self.token = None
        os.makedirs(state_dir, mode=0o700, exist_ok=True)
        try:
            os.chmod(state_dir, 0o700)
        except OSError:
            pass

    def log(self, *a):
        if self.verbose:
            print("[cloudshell]", *a, file=sys.stderr)

    # -- state files ------------------------------------------------------- #

    def _write_state(self, name, value):
        path = os.path.join(self.state_dir, name)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(value)

    def _read_state(self, name):
        path = os.path.join(self.state_dir, name)
        try:
            return open(path, encoding="utf-8").read().strip()
        except OSError:
            return None

    # -- account ----------------------------------------------------------- #

    def validate(self):
        """Prove the session is live. Returns a dict; raises on clear failure."""
        checks = {}
        resp = http_request("https://myaccount.google.com/", self.store)
        resp2 = http_request("https://mail.google.com/mail/feed/atom",
                             self.store, follow=False)
        checks["myaccount"] = {"status": resp.status, "authenticated": resp.status == 200}
        checks["mail_feed"] = {"status": resp2.status,
                               "authenticated": resp2.status == 200}
        checks["cookies"] = self.store.auth_summary()
        ok = checks["myaccount"]["authenticated"] and checks["cookies"]["has_sid"]
        checks["valid"] = ok
        if not ok:
            raise CloudShellError(
                "credential is not authenticated — re-run ai-brain/google/google-auth.js",
                code="CREDENTIAL_INVALID", details=checks)
        return checks

    # -- xsrf -------------------------------------------------------------- #

    def xsrf(self):
        """Fetch the XSRF token. NOTE: the redirect must be followed (§5.1a)."""
        resp = http_request(
            f"{SHELL_HOST}/newtoken?authuser=0", self.store, follow=True)
        text = strip_xssi(resp)
        m = re.search(r'"([A-Za-z0-9_\-:.]{16,})"', text)
        if resp.status != 200 or not m:
            raise CloudShellError(
                "could not obtain XSRF token",
                code="XSRF_FAILED",
                details={"status": resp.status, "body": text[:200]})
        self.token = m.group(1)
        self.log("xsrf token acquired (%d chars)" % len(self.token))
        return self.token

    def _token_qs(self):
        if not self.token:
            self.xsrf()
        return urllib.parse.urlencode({"authuser": "0", "token": self.token})

    # -- environments ------------------------------------------------------ #

    def eligible(self):
        resp = http_request(
            f"{SHELL_HOST}/cloudshell/ca?{self._token_qs()}", self.store,
            follow=True)
        body = strip_xssi(resp)
        if resp.status == 403:
            raise CloudShellError("account is not eligible for Cloud Shell",
                                  code="NOT_ELIGIBLE", details={"status": 403})
        if resp.status != 200:
            raise CloudShellError("eligibility check failed", code="CA_FAILED",
                                  details={"status": resp.status, "body": body[:200]})
        # An empty array means allowed; a populated one carries a denial reason.
        return {"eligible": body in ("[]", ""), "raw": body}

    def list_envs(self):
        req = urllib.parse.quote(json.dumps(["users/me"], separators=(",", ":")))
        resp = http_request(
            f"{SHELL_HOST}/cloudshell/environments/list?{self._token_qs()}&request={req}",
            self.store, follow=True)
        data = jload(resp)
        envs = (data[0] if isinstance(data, list) and data else []) or []
        return [self._map_env(e) for e in envs]

    def get_env(self, env_id="default"):
        path = f"users/me/environments/{env_id}"
        req = urllib.parse.quote(json.dumps([path], separators=(",", ":")))
        resp = http_request(
            f"{SHELL_HOST}/cloudshell/environments/get?{self._token_qs()}&request={req}",
            self.store, follow=True)
        data = jload(resp)
        # environments/get returns the Environment array **flat**:
        #   ["users/…/environments/default", "default", "<image>", 3, "<user>", …]
        # setupsession nests it at [3]; accept both shapes.
        if isinstance(data, list) and data and isinstance(data[0], str):
            return self._map_env(data)
        if isinstance(data, list) and len(data) > 3 and isinstance(data[3], list):
            return self._map_env(data[3])
        if isinstance(data, list) and data and isinstance(data[0], list):
            return self._map_env(data[0])
        raise CloudShellError("unexpected environments/get shape",
                              code="BAD_RESPONSE",
                              details={"body": strip_xssi(resp)[:300]})

    @staticmethod
    def _map_env(e):
        def at(i, default=None):
            return e[i] if isinstance(e, list) and len(e) > i else default
        state = at(3)
        return {
            "name": at(0),
            "id": at(1),
            "image": at(2),
            "state": state,
            "stateName": STATE_NAMES.get(state, str(state)),
            "sshUser": at(4),
            "ip": at(5),
            "host": at(11),
            "keys": at(7) if isinstance(at(7), list) else [],
        }

    def setupsession(self, env_id="default", key_pub=None):
        """Provision + start. Field 4 takes the env **id**, not the resource path.

        Field 3 is [<enum>, <base64 SSH wire blob>]. The blob must be the middle
        token of the .pub line — NOT the PEM text.
        """
        if key_pub is None:
            raise CloudShellError("setupsession needs an SSH public key",
                                  code="NO_KEY")
        blob = key_pub.split()[1]
        body = json.dumps([None, None, [2, blob], [env_id]])
        resp = http_request(
            f"{SHELL_HOST}/cloudshell/setupsession?authuser=0&token={self.token}",
            self.store, method="POST", body=body)
        data = jload(resp)
        if resp.status != 200 or not isinstance(data, list):
            raise CloudShellError(
                "setupsession failed", code="SETUP_FAILED",
                details={"status": resp.status, "body": strip_xssi(resp)[:300]})
        if len(data) > 2 and data[2] not in (None, []):
            # e.g. [null, null, 7] — see LAB-14 §5.7 for the code table
            raise CloudShellError(
                "setupsession rejected by Cloud Shell", code="SETUP_REJECTED",
                details={"status": resp.status, "code": data[2],
                         "hint": "code 7 = quota/limit/abuse/region (LAB-14 §5.7)"})
        access_token = data[1][0]
        env = self._map_env(data[3]) if len(data) > 3 else {}
        self._write_state("access_token", access_token)
        self._write_state("session.json", json.dumps({
            "env": env,
            "startType": data[0],
            "editorUrl": (data[1][1][3] if len(data[1]) > 1 and
                          isinstance(data[1][1], list) and len(data[1][1]) > 3 else None),
            "startedAt": int(time.time()),
        }, indent=2))
        self.log("setupsession ok: state=%s ip=%s" % (env.get("state"), env.get("ip")))
        return {"accessToken": access_token, "env": env, "startType": data[0]}

    def wait_running(self, env_id="default", timeout=90, interval=3):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            last = self.get_env(env_id)
            if last["state"] == STATE_RUNNING:
                return last
            time.sleep(interval)
        raise CloudShellError(
            "environment did not reach RUNNING", code="START_TIMEOUT",
            details={"state": last, "timeout": timeout})

    def abandon(self):
        resp = http_request(
            f"{SHELL_HOST}/devshell/abandon?authuser=0&token={self.token}",
            self.store, method="POST", body="[null]")
        return {"status": resp.status, "body": strip_xssi(resp)[:200]}

    # -- relay ------------------------------------------------------------- #

    def relay_login(self, access_token, host):
        """Exchange the access token for CloudShellAuthorization.

        Mandatory — the websocket returns 503 without it (§6.2a).
        """
        state = {
            "token": access_token,
            "target_host": host,
            "authuser": "",
            "cloud_shell_environment_name": "users/me/environments/default",
        }
        b64 = base64.b64encode(json.dumps(state).encode()).decode()
        url = (f"{SSH_LOGIN_HOST}/cloudshell/jwt"
               f"?redirect_uri={SSH_LOGIN_HOST}/&state=" + urllib.parse.quote(b64))
        resp = http_request(url, self.store, follow=True)
        text = resp.text
        m = re.search(r"window\.location = '([^']+)'", text)
        if not m:
            raise CloudShellError("jwt endpoint returned no redirect",
                                  code="JWT_FAILED",
                                  details={"status": resp.status, "body": text[:300]})
        login_url = _unescape_js(m.group(1))
        if "&redirect=" not in login_url:
            raise CloudShellError("login URL lost its &redirect param",
                                  code="LOGIN_URL_MANGLED",
                                  details={"url": login_url[:200]})
        resp = http_request(login_url, self.store, follow=False)
        cookie = "; ".join(
            c.split(";")[0] for c in (resp.headers.get_all("Set-Cookie") or []))
        if "CloudShellAuthorization" not in cookie:
            raise CloudShellError(
                "relay login did not return CloudShellAuthorization",
                code="RELAY_AUTH_FAILED",
                details={"status": resp.status, "cookies": cookie[:200]})
        self._write_state("relay_cookie", cookie)
        self.log("relay authorised")
        return cookie


def _unescape_js(text):
    text = text.replace("\\/", "/")
    return re.sub(r"\\x([0-9a-fA-F]{2})",
                  lambda m: chr(int(m.group(1), 16)), text)


# --------------------------------------------------------------------------- #
# WebSocket (RFC6455) <-> TCP bridge
# --------------------------------------------------------------------------- #

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WebSocket:
    def __init__(self, sock):
        self.sock = sock
        self.send_lock = threading.Lock()

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("websocket closed")
            buf += chunk
        return buf

    def recv_frame(self):
        head = self._recv_exact(2)
        opcode = head[0] & 0x0F
        masked = head[1] & 0x80
        length = head[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if masked else None
        payload = self._recv_exact(length) if length else b""
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
            self.sock.sendall(head + mask + masked)

    def close(self):
        try:
            self.send_frame(0x8, b"")
        except Exception:
            pass


def ws_connect(url, cookie, origin=SHELL_HOST, timeout=30):
    secure = url.startswith("wss://")
    hostport, _, path = url.split("://", 1)[1].partition("/")
    path = "/" + path
    host, _, port = hostport.partition(":")
    port = int(port or (443 if secure else 80))
    raw = socket.create_connection((host, port), timeout=timeout)
    if secure:
        raw = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
    key = base64.b64encode(os.urandom(16)).decode()
    raw.sendall((
        f"GET {path} HTTP/1.1\r\nHost: {hostport}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
        f"Origin: {origin}\r\nCookie: {cookie}\r\n"
        f"User-Agent: {UA}\r\n\r\n").encode())
    header = b""
    while b"\r\n\r\n" not in header:
        chunk = raw.recv(1)
        if not chunk:
            raise CloudShellError("websocket handshake closed early",
                                  code="RELAY_CLOSED")
        header += chunk
    status_line = header.split(b"\r\n", 1)[0].decode(errors="replace")
    if " 101 " not in status_line + " ":
        raise CloudShellError(
            f"websocket handshake failed: {status_line}",
            code="RELAY_HANDSHAKE_FAILED",
            details={"hint": "503 usually means the /_cloudshell/login step was "
                             "skipped, not that the host is wrong (§6.2a)"})
    accept = base64.b64encode(
        hashlib.sha1((key + _WS_GUID).encode()).digest()).decode()
    if accept.lower().encode() not in header.lower():
        raise CloudShellError("bad Sec-WebSocket-Accept", code="RELAY_HANDSHAKE_FAILED")
    return WebSocket(raw)


def _pump_ws_to_tcp(ws, tcp):
    try:
        while True:
            opcode, payload = ws.recv_frame()
            if opcode in (0x0, 0x1, 0x2):
                if payload:
                    tcp.sendall(payload)
            elif opcode == 0x8:
                break
            elif opcode == 0x9:
                ws.send_frame(0xA, payload)
    except Exception:
        pass
    finally:
        try:
            tcp.shutdown(socket.SHUT_WR)
        except Exception:
            pass


def _pump_tcp_to_ws(ws, tcp):
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


class RelayBridge:
    """Single-connection local TCP listener bridged to the Cloud Shell relay.

    The bridge accepts exactly one connection (ssh opens one). Restart it for
    each new ssh invocation — a consumed bridge yields ConnectionRefused.
    """

    def __init__(self, ws_url, cookie, host="127.0.0.1"):
        self.ws_url = ws_url
        self.cookie = cookie
        self.host = host
        self.srv = None
        self.port = None

    def start(self):
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind((self.host, 0))
        self.srv.listen(1)
        self.port = self.srv.getsockname()[1]
        return self.port

    def serve_once(self):
        tcp, _ = self.srv.accept()
        ws = ws_connect(self.ws_url, self.cookie)
        threading.Thread(target=_pump_ws_to_tcp, args=(ws, tcp), daemon=True).start()
        _pump_tcp_to_ws(ws, tcp)

    def close(self):
        try:
            self.srv.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# SSH session
# --------------------------------------------------------------------------- #

class Session:
    """A started + relay-authorised Cloud Shell VM."""

    def __init__(self, cs, env=None, access_token=None):
        self.cs = cs
        self.env = env
        self.access_token = access_token

    @property
    def ssh_user(self):
        return self.env.get("sshUser") or "cloudshelluser"

    @property
    def host(self):
        return self.env.get("host")

    @property
    def relay_host(self):
        return "970-" + self.host

    def ws_url(self):
        return (f"wss://{self.relay_host}/_cloudshell/tcp/22"
                f"?_cloudshellAccessToken={self.access_token}")

    def ensure(self, key_path, env_id="default", wait=90):
        if not self.cs.token:
            self.cs.xsrf()
        env = self.cs.get_env(env_id)
        if env["state"] != STATE_RUNNING:
            self.cs.log("env is %s — starting" % env["stateName"])
            pub = open(key_path + ".pub", encoding="utf-8").read()
            self.cs.setupsession(env_id, key_pub=pub)
            env = self.cs.wait_running(env_id, timeout=wait)
            self.access_token = self.cs._read_state("access_token")
        else:
            # Warm setupsession still mints a fresh access token.
            pub = open(key_path + ".pub", encoding="utf-8").read()
            res = self.cs.setupsession(env_id, key_pub=pub)
            env = res["env"]
            self.access_token = res["accessToken"]
        self.env = env
        if not self.access_token:
            raise CloudShellError("no access token available", code="NO_ACCESS_TOKEN")
        self.cookie = self.cs.relay_login(self.access_token, self.relay_host)
        return self

    def run(self, argv, key_path, allocate_tty=False, timeout=120):
        bridge = RelayBridge(self.ws_url(), self.cookie)
        port = bridge.start()
        thread = threading.Thread(target=bridge.serve_once, daemon=True)
        thread.start()
        cmd = [
            "ssh",
            "-o", f"ProxyCommand={sys.executable} -I {PROXY_SHIM} {port}",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR",
            "-o", "IdentitiesOnly=yes",
            "-o", "BatchMode=" + ("no" if allocate_tty else "yes"),
            "-i", key_path,
            f"{self.ssh_user}@{self.host}",
        ] + (["-t"] if allocate_tty else []) + list(argv)
        try:
            proc = subprocess.run(cmd, timeout=timeout)
            return proc.returncode
        finally:
            bridge.close()


def ensure_key(key_path):
    if os.path.exists(key_path) and os.path.exists(key_path + ".pub"):
        return key_path
    os.makedirs(os.path.dirname(key_path) or ".", mode=0o700, exist_ok=True)
    subprocess.run(
        ["ssh-keygen", "-t", "ecdsa", "-b", "256", "-N", "", "-C", "cloudshell",
         "-f", key_path],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.chmod(key_path, 0o600)
    return key_path


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def build_parser():
    p = argparse.ArgumentParser(
        prog="cloudshell.py",
        description="Control Google Cloud Shell VMs from a saved browser session.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""examples:
  %(prog)s validate
  %(prog)s list
  %(prog)s start --wait
  %(prog)s exec -- ls -la
  %(prog)s exec -- 'docker ps && uname -a'
  %(prog)s shell
  %(prog)s status --json
  %(prog)s abandon
""")
    p.add_argument("--credentials", "-c", default=os.environ.get("GOOGLE_AUTH_FILE",
                                                                DEFAULT_CREDENTIAL),
                   help="Playwright storageState file (default: %(default)s)")
    p.add_argument("--state-dir", default=os.environ.get("CLOUDSHELL_STATE_DIR",
                                                         DEFAULT_STATE_DIR),
                   help="where tokens/keys are kept, mode 0700 (default: %(default)s)")
    p.add_argument("--verbose", "-v", action="store_true")

    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("validate", help="check the credential's session is live")

    sp = sub.add_parser("list", help="list environments")
    sp.add_argument("--json", action="store_true")

    sp = sub.add_parser("start", help="provision + start the environment")
    sp.add_argument("--env", default="default")
    sp.add_argument("--wait", action="store_true", help="poll until RUNNING")
    sp.add_argument("--timeout", type=int, default=90)
    sp.add_argument("--json", action="store_true")

    sp = sub.add_parser("status", help="show one environment's state")
    sp.add_argument("--env", default="default")
    sp.add_argument("--json", action="store_true")

    sp = sub.add_parser("exec", help="run a command in the VM over SSH")
    sp.add_argument("argv", nargs=argparse.REMAINDER,
                    help="command to run (use -- before it)")
    sp.add_argument("--env", default="default")
    sp.add_argument("--timeout", type=int, default=120)

    sp = sub.add_parser("shell", help="interactive SSH shell")
    sp.add_argument("--env", default="default")

    sub.add_parser("bridge", help="open the relay and print the SSH banner")

    sub.add_parser("abandon", help="tear down the VM (untested)")
    return p


def _json_out(obj):
    json.dump(obj, sys.stdout, indent=2)
    sys.stdout.write("\n")


def main(argv=None):
    args = build_parser().parse_args(argv)
    os.umask(0o077)

    try:
        store = CookieStore(args.credentials)
    except FileNotFoundError:
        print(f"error: credential file not found: {args.credentials}", file=sys.stderr)
        return 2
    except CloudShellError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    cs = CloudShell(store, state_dir=args.state_dir, verbose=args.verbose)
    key_path = ensure_key(os.path.join(args.state_dir, "ssh", "id_ecdsa"))

    try:
        if args.command == "validate":
            _json_out(cs.validate())
            return 0

        if args.command == "list":
            envs = cs.list_envs()
            if args.json:
                _json_out(envs)
            else:
                for e in envs:
                    print(f"{e['id']:12s} {e['stateName']:8s} {e['sshUser'] or '-':16s} "
                          f"{e['ip'] or '-':16s} {e['host'] or '-'}")
            return 0

        if args.command == "status":
            env = cs.get_env(args.env)
            if args.json:
                _json_out(env)
            else:
                print(f"id:     {env['id']}")
                print(f"state:  {env['stateName']} ({env['state']})")
                print(f"ip:     {env['ip']}")
                print(f"host:   {env['host']}")
                print(f"user:   {env['sshUser']}")
                print(f"keys:   {len(env['keys'])}")
            return 0

        if args.command == "start":
            pub = open(key_path + ".pub", encoding="utf-8").read()
            res = cs.setupsession(args.env, key_pub=pub)
            if args.wait:
                env = cs.wait_running(args.env, timeout=args.timeout)
            else:
                env = cs.get_env(args.env)
            out = {"startType": res["startType"], "env": env}
            if args.json:
                _json_out(out)
            else:
                print(f"started: {env['stateName']}  ip={env['ip']}  host={env['host']}")
            return 0

        if args.command == "abandon":
            res = cs.abandon()
            _json_out(res)
            return 0 if res["status"] == 200 else 1

        if args.command == "bridge":
            cs.xsrf()
            env = cs.get_env()
            res = cs.setupsession(env_id="default",
                                  key_pub=open(key_path + ".pub", encoding="utf-8").read())
            session = Session(cs, env=res["env"], access_token=res["accessToken"])
            cookie = cs.relay_login(session.access_token, session.relay_host)
            ws = ws_connect(session.ws_url(), cookie)
            opcode, payload = ws.recv_frame()
            ws.close()
            print(f"relay: 101 OK, first frame opcode={opcode} len={len(payload)}")
            print(f"banner: {payload[:80].decode(errors='replace').strip()}")
            return 0

        if args.command in ("exec", "shell"):
            argv_cmd = args.argv
            if argv_cmd and argv_cmd[0] == "--":
                argv_cmd = argv_cmd[1:]
            if args.command == "exec" and not argv_cmd:
                print("error: exec needs a command, e.g. `exec -- ls -la`",
                      file=sys.stderr)
                return 2
            cs.xsrf()
            session = Session(cs).ensure(key_path, env_id=args.env)
            if args.command == "shell":
                return session.run([], key_path, allocate_tty=True)
            return session.run([" ".join(argv_cmd)] if len(argv_cmd) > 1 else argv_cmd,
                               key_path,
                               timeout=getattr(args, "timeout", 120))

        print(f"error: unknown command {args.command}", file=sys.stderr)
        return 2

    except CloudShellError as e:
        print(f"error [{e.code or 'ERROR'}]: {e}", file=sys.stderr)
        if e.details:
            print(json.dumps(e.details, indent=2), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
