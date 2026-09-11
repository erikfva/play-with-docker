# Research: Codespace VM Lifecycle via Web UI Endpoints

## Context

The `play-with-docker` project manages GitHub Codespace VMs through browser automation (Playwright). The scripts under `scripts/` provide a `codespace-vm.js` dispatcher that delegates to `create-codespace.js`, `delete-codespace.js`, `list-codespaces.js`, and `refresh-codespace.js`.

This research explored whether the same VM lifecycle operations (list, delete, create, stop) can be performed via direct HTTP requests to GitHub's Web UI endpoints — eliminating the need for Chromium entirely.

## Testing Environment

- **Credential**: `vm-manager232-santi` (Playwright storageState JSON at `/mnt/s3/github/vm-manager232-santi/github.json`)
- **Node version**: 20+ (built-in `fetch`)
- **Testing dates**: 2026-09-11

---

## Two Approaches Tested

### Approach 1: Browser Automation (Playwright)

**Script**: `scripts/refresh-codespace.js` (via `scripts/codespace-vm.js --action refresh`)

Launches Chromium once and performs all actions via DOM interaction (clicking buttons, reading page text, waiting for toasts).

**Flow**:
1. Navigate to `github.com/codespaces`, parse DOM for codespace list
2. Click actions menu → "Delete" → confirm dialog → wait for toast
3. Navigate to `github.com/codespaces/templates` → click "Use this template" → wait for editor tab to open on `{slug}.github.dev`
4. Navigate back to `/codespaces` → click actions menu → "Stop codespace" → wait for toast

**Timings** (with `--no-wait-stop` flag, which skips status-change polling):

| Action | Time | Notes |
|---|---|---|
| signin | 1,699ms | Browser launch + session check |
| list | 4,064ms | Navigate + 3s built-in `waitForTimeout` + DOM parse |
| delete | 41,616ms | Form POST via UI + poll for deletion confirmation |
| create | 4,396ms | Navigate to templates, click, wait for editor page |
| stop:no-wait | 17,892ms | Navigate + menu + 15s `waitForToast` timeout |
| **total** | **71,785ms** | |

**Browser network trace**: 104 HTTP requests (most are noise: Copilot entitlements, notifications, in-product messaging, VS Code CDN assets).

### Approach 2: Direct HTTP Requests (No Browser)

**Script**: `scripts/refresh-codespace-http.js`

Extracts cookies from the Playwright storageState JSON, makes HTTP requests with `fetch`, and parses HTML with regex for CSRF tokens and codespace data.

**Flow**:
1. `GET github.com/codespaces` → parse HTML for codespace list + form tokens
2. `POST github.com/codespaces/{slug}` with `_method=delete` + per-form `authenticity_token`
3. `GET github.com/codespaces/templates` → parse for create form fields → `POST github.com/codespaces`
4. `GET github.com/codespaces` → extract suspend form token → `POST github.com/codespaces/{slug}/suspend`

**Timings**:

| Action | Time | Endpoint | Status |
|---|---|---|---|
| list | 883ms | `GET github.com/codespaces` | 200 |
| delete | 674ms | `POST github.com/codespaces/{slug}` | 302 |
| create | 2,034ms | `GET /codespaces/templates` + `POST /codespaces` | 200 |
| stop | 1,149ms | `POST github.com/codespaces/{slug}/suspend` | 302 |
| **total** | **4,777ms** | | |

**HTTP requests**: 8 total (5 unique endpoints). No browser, no Chromium, no Playwright.

### Comparison

| Metric | Browser | HTTP | Improvement |
|---|---|---|---|
| Total time | 71.8s | 4.8s | 15x faster |
| Requests | 104 | 8 | 13x fewer |
| Dependencies | Chromium + Playwright | None (Node `fetch`) | |
| Memory | ~200MB (browser) | ~20MB | 10x less |

---

## Web UI Endpoints Discovered

All endpoints are on `github.com` (not `api.github.com`). They use form POSTs with `application/x-www-form-urlencoded` content type, not JSON.

### 1. List Codespaces

```
GET https://github.com/codespaces
```
- **Response**: 200 HTML page
- **Data**: Codespace rows embedded in DOM — slugs extracted from `href` and `action` attributes matching `/codespaces/{slug}`
- **Status**: Determined by **suspend form presence** — if `action="/codespaces/{slug}/suspend"` is in the HTML, the codespace is active; if absent, it's stopped
- **Filter**: Must exclude `templates` and `new` slugs (these are navigation links, not codespaces)
- **Note**: Status keywords (Active/Idle/Stopped) are NOT in the raw HTML — the old approach of text matching was unreliable

### 2. Delete Codespace

```
POST https://github.com/codespaces/{slug}
Content-Type: application/x-www-form-urlencoded

_method=delete&authenticity_token={per-form-token}
```
- **Response**: 302 redirect to `/codespaces`
- **CSRF**: Per-form `authenticity_token` from the form with `_method=delete`

### 3. Create Codespace (blank template)

```
GET https://github.com/codespaces/templates
→ Parse HTML for form with action="/codespaces"

POST https://github.com/codespaces
Content-Type: application/x-www-form-urlencoded

authenticity_token={token}&codespace[template_repository_id]={id}&codespace[repository_id]={id}&codespace[ref]=main
```
- **Response**: 200 HTML document containing `{slug}.github.dev` hostname
- **Form fields** (from templates page):
  - `authenticity_token` — CSRF token
  - `codespace[template_repository_id]` — repo ID (e.g., `525552024` for blank template)
  - `codespace[repository_id]` — same repo ID
  - `codespace[ref]` — branch (e.g., `main`)
- **Slug extraction**: Regex for `[a-z0-9-]+\.github\.dev` in response HTML

### 4. Stop/Suspend Codespace

```
POST https://github.com/codespaces/{slug}/suspend
Content-Type: application/x-www-form-urlencoded

authenticity_token={per-form-token}
```
- **Response**: 302 redirect to `/codespaces`
- **CSRF**: Per-form `authenticity_token` from the form with `action="/codespaces/{slug}/suspend"` (no `_method` field)
- **Important**: The suspend form has its own `action` attribute pointing directly to `/codespaces/{slug}/suspend` — no JavaScript modification needed
- **CRITICAL**: The 302 response means the form was accepted, but the **actual stop takes 10-20 minutes** to take effect. The codespace remains active (suspend form stays in HTML) until GitHub's backend processes the shutdown. This is the same behavior whether using plain HTTP, browser fetch, or browser button click.

### 5. Status Check — Endpoints That Do NOT Work

#### `api.github.com` REST API (returns 401)

```
GET https://api.github.com/user/codespaces/{slug}?internal=true&refresh=true
```
- **Response**: **401 "Requires authentication"** — even when sent from within the browser context with valid session cookies
- The browser's JavaScript does NOT use this endpoint for status polling (confirmed via network trace)
- A PAT with `codespace` scope would be required to use this endpoint

#### `api.github.com` list endpoint (returns 401)

```
GET https://api.github.com/user/codespaces?internal=true
```
- **Response**: **401** — same authentication failure

#### `github.com/graphql` (returns 422)

```
POST https://github.com/graphql
{ "query": "{ viewer { codespaces(first: 10) { nodes { name cachedState lastUsedAt } } } }" }
```
- **Response**: **422** — the GraphQL endpoint requires proper query formatting and possibly additional headers

#### Browser network trace (what the browser actually calls)

During page load of `/codespaces`, the browser makes these XHR/fetch requests:
1. `GET /in-product-messaging/copilot-budget-request-banner` → 200
2. `GET /in-product-messaging/code-scanning-ai-findings-preview-banner` → 204
3. `GET /codespaces/{slug}/export_control` → 200 (export control check, NOT status)
4. `GET /github-copilot/chat/entitlement` → 200 JSON
5. `GET /notifications/indicator` → 200 JSON
6. `GET /_global-navigation/payloads.json` → 200 JSON
7. `GET /_side-panels/user.json` → 200 JSON
8. `POST api.github.com/_private/browser/stats` → 200 (analytics ping only)

**No call to `api.github.com/user/codespaces` is made!** The browser does NOT poll a REST API for status. The status is determined entirely from the server-rendered HTML.

---

## Stop/Suspend Verification — Critical Findings

### The suspend POST returns 302 but the stop is extremely delayed

**Extensive testing (2026-09-11) confirmed:**

1. `POST /codespaces/{slug}/suspend` → **302** (form accepted, redirect to `/codespaces`)
2. The codespace remains **Active** for **10-20 minutes** after the POST
3. Eventually the codespace transitions to stopped/idle and the suspend form disappears from the HTML

### Testing timeline (codespace `psychic-space-bassoon-gx74jpxr7767hw54`)

| Time | Suspend form in raw HTML | Interpretation |
|---|---|---|
| T+0s (immediately after POST) | PRESENT | Codespace still active |
| T+30s | PRESENT | Still active |
| T+60s | PRESENT | Still active |
| T+120s | PRESENT | Still active |
| T+300s (5 min) | PRESENT | Still active |
| T+617s (10 min) | PRESENT | Still active |
| T+1200s (20 min) | ABSENT | **Stopped** |

### Browser vs HTTP — Same result

The browser's Turbo form submission (via `fetch()` from the browser context) produces the **same 302 response**:

```
POST /codespaces/{slug}/suspend
  Accept: text/vnd.turbo-stream.html, text/html
  X-Requested-With: XMLHttpRequest
  → 302, Location: /codespaces, Content-Type: text/html
```

The browser's fetch gets the identical 302 redirect. The suspend form remains in the DOM after the fetch. The stop takes the same 10-20 minutes regardless of whether the form is submitted via:
- Plain HTTP `fetch` (our `refresh-codespace-http.js`)
- Browser's Turbo `fetch` (from `page.evaluate`)
- Browser's native form submission (button click via Playwright)

### Suspend form presence = reliable status indicator

The **suspend form** (`action="/codespaces/{slug}/suspend"`) in the raw HTML of `GET /codespaces` is a reliable indicator:

| Suspend form in HTML | Codespace state |
|---|---|
| Present | Active / Running / Provisioning |
| Absent | Stopped / Idle / Shutdown |

This works because:
- The server renders the suspend form only when the codespace can be stopped (is active)
- When the codespace is stopped, the server removes the suspend form from the HTML
- No JavaScript or API call is needed — just check the raw HTML

**Implementation:**
```javascript
function isCodespaceActive(html, slug) {
  return html.includes(`/codespaces/${slug}/suspend`);
}
```

### Why the initial `parseCodespaceList` status detection failed

The `parseCodespaceList` function in `refresh-codespace-http.js` looked for status keywords (`Stopped`, `Active`, `Running`, etc.) in the HTML near the codespace slug. This failed because:

1. **The status is NOT in the raw HTML** — GitHub does not render status text in the initial HTML
2. The status was previously thought to be loaded via `api.github.com` JavaScript polling, but network tracing revealed **no such API call is made**
3. The status is instead determined by the **presence or absence of the suspend form** — the server only renders the suspend form when the codespace is active

### Browser DOM vs raw HTML

The browser's JavaScript removes the suspend form from the DOM when the codespace is not active. This means:
- **Raw HTML (HTTP)**: suspend form present = active
- **Browser DOM (after JS)**: suspend form removed = not active (or still provisioning)

When a codespace is freshly created and still provisioning, the suspend form is present in the raw HTML but removed from the DOM by JavaScript. This means you cannot reliably check status from the browser DOM — you must check the raw HTML.

### Recommendations for stop verification

1. **Use `--no-wait-stop`** — The stop takes 10-20 minutes. Waiting is impractical.
2. **Verify later** — After the refresh script completes, check status later using the suspend form presence method:
   ```
   GET /codespaces → check if action="/codespaces/{slug}/suspend" is in the HTML
   ```
3. **Do not use `api.github.com`** — It returns 401 with session cookies alone. A PAT would be needed.
4. **Do not trust `parseCodespaceList` status** — The status keywords are not in the HTML. Use the suspend form presence instead.

---

## Form Structure Details

The `/codespaces` HTML page renders multiple `<form>` elements per codespace row. Each form has a **unique** `authenticity_token` — GitHub generates per-form CSRF tokens, not session-level tokens.

### Forms per codespace row (tested with slug `crispy-waffle-p7pj467wpjpgc79qp`)

| Form # | Action | `_method` | Extra fields | Purpose |
|---|---|---|---|---|
| 0 | `/codespaces/{slug}/suspend` | (none) | (none) | **Stop/suspend** |
| 1 | `/codespaces/{slug}` | `patch` | `codespace[keep]=true` | Pin/keep |
| 2 | `/codespaces/{slug}` | `patch` | `codespace[display_name]` | Rename |
| 3 | `/codespaces/{slug}` | `delete` | (none) | **Delete** |
| 4 | `/codespaces/{slug}` | `patch` | (none) | Unknown (possibly start/resume) |
| 5 | `/codespaces/{slug}/export` | (none) | `name`, `visibility` | Export |

### Key observations

1. **The suspend form (Form 0)** has `action="/codespaces/{slug}/suspend"` directly in the HTML — no JavaScript action modification needed. It contains only `authenticity_token` and no `_method` field.

2. **The delete form (Form 3)** has `action="/codespaces/{slug}"` with `_method=delete` and `authenticity_token`.

3. **Each form has a different `authenticity_token`** — you cannot reuse a token from one form for another action. The meta tag `csrf-token` also does not work as a universal token (returns 422 "Your browser did something unexpected").

4. **The create form** on `/codespaces/templates` has `action="/codespaces"` with template-specific fields (`template_repository_id`, `repository_id`, `ref`).

5. **Slug false positives**: `href="/codespaces/new"` (the "New codespace" button) and `href="/codespaces/templates"` (the templates link) must be filtered out when parsing the codespace list.

---

## CSRF Token Extraction

GitHub uses `authenticity_token` for CSRF protection on all form POSTs. The token is:
- Embedded as `<input type="hidden" name="authenticity_token" value="...">` within each `<form>`
- Also available as `<meta name="csrf-token" content="...">` in the `<head>` (session-level)
- **Per-form tokens are required** — the session-level meta tag token returns 422 when used for a specific action
- Each form on the page has a unique token, even forms with the same action URL

### Extraction strategy (regex-based, no external dependencies)

```javascript
// Extract per-form token for a specific form action
function extractFormFields(html, formAction) {
  const escaped = formAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const formRegex = new RegExp(
    `<form[^>]*action=["']${escaped}["'][^>]*>([\\s\\S]*?)</form>`, 'i'
  );
  const match = html.match(formRegex);
  if (!match) return null;
  // Extract <input name="..." value="..."> pairs from form body
  // ...
}
```

---

## Cookie Handling

The Playwright storageState JSON contains cookies in this format:
```json
{
  "cookies": [
    { "name": "user_session", "value": "...", "domain": ".github.com", "path": "/" },
    { "name": "_device_id", "value": "...", "domain": ".github.com", "path": "/" },
    ...
  ],
  "origins": [...]
}
```

### Cookie extraction for HTTP requests

1. Filter cookies by domain (`.github.com` or `github.com`)
2. Format as `Cookie: name1=value1; name2=value2; ...` header
3. Update cookies from `Set-Cookie` response headers (GitHub refreshes `user_session` on activity)
4. Use `redirect: 'manual'` in `fetch` to handle 302s explicitly and capture cookie updates from redirect responses

### Important cookies

| Cookie | Purpose | Lifetime |
|---|---|---|
| `user_session` | Session authentication | 14 days (sliding — renewed on activity) |
| `_device_id` | Device fingerprint | 1 year |
| `logged_in` | Login state | persistent |
| `dotcom_user` | Username | persistent |

---

## Retry Logic for Stop/Suspend

The initial HTTP implementation returned 422 for the suspend endpoint. Root cause: using the wrong form's `authenticity_token` (from a `_method=patch` form with `action="/codespaces/{slug}"` instead of the suspend form with `action="/codespaces/{slug}/suspend"`).

The script includes a 3-attempt retry with 5s delays, but after fixing the form extraction to target the correct suspend form, the first attempt succeeds (302) with no retries needed.

**However**, the 302 response is not an immediate success. The stop is asynchronous — the codespace remains active for 10-20 minutes after the POST. This is a server-side behavior, not a client-side issue. The browser version has the same limitation (confirmed via network trace — the browser's fetch gets the same 302).

---

## Browser Automation Issues Found & Fixed

During testing of the browser-based `refresh-codespace.js`, two bugs were found and fixed in `scripts/auth-browser.js`:

1. **"Templates" entry false positive** — `listCodespaces` was picking up the "Templates" navigation entry (slug `templates`) as a real codespace. Fixed by filtering out `templates` slug in the deduplication step.

2. **`stopCodespace` timing out** — newly created codespaces take >120s for GitHub to update the status from "active" to "idle". Fixed by:
   - Increasing polling timeout from 45s to 120s
   - Adding retry logic (2 attempts with re-click)
   - Adding `menuitem` fallback selector (GitHub may render as `menuitem` instead of `menuitemradio`)
   - Adding `noWait` option to skip status-change polling entirely

---

## Recommendations

### For the HTTP approach (preferred for automated/CI use)

- Use `refresh-codespace-http.js` as the production refresh script — 15x faster, no browser dependency
- Add it to the `codespace-vm.js` dispatcher as `--action refresh-http`
- The script handles cookie updates from `Set-Cookie` headers, so the storageState file could optionally be updated after each run to keep the session fresh (synergy with the keep-alive strategy in `plan.md`)
- **The stop is async** — `POST /codespaces/{slug}/suspend` returns 302 but the actual stop takes 10-20 minutes. Use `--no-wait-stop` or accept the delay.
- **Verify status later** with `check-codespace-status.js` — uses the suspend form presence as a reliable indicator

### For the browser approach (needed for edge cases)

- Keep `refresh-codespace.js` as a fallback for when the HTTP approach fails (e.g., GitHub changes form structure, adds CAPTCHA)
- The `--no-wait-stop` flag is essential for reasonable performance (17.9s vs 4m+)
- The browser's stop action produces the same 302 response as the HTTP version — the 10-20min async delay is a server-side behavior, not a client-side issue

### For stop verification

- **Use `check-codespace-status.js`** — checks suspend form presence in raw HTML
- **Do NOT use `api.github.com`** — returns 401 with session cookies (requires PAT)
- **Do NOT use `graphql`** — returns 422 (likely needs proper query/auth headers)
- **Do NOT look for status keywords** (Active/Idle/Stopped) in the HTML — they are not in the raw HTML. The status is determined solely by suspend form presence.

### For future direct API exploration

- The official GitHub REST API (`api.github.com/user/codespaces`) could replace all Web UI endpoints, but requires a PAT with `codespace` scope
- The browser does NOT use `api.github.com` for status — confirmed via network trace. The status is determined entirely from server-rendered HTML (suspend form presence/absence)
- The create endpoint needs a `repository_id` — the blank template uses repo ID `525552024` (this may change if GitHub updates the template repo)

---

## Scripts Created/Modified

| Script | Status | Purpose |
|---|---|---|
| `scripts/refresh-codespace.js` | Created | Browser-based refresh (list → delete first → create → stop) in one session |
| `scripts/refresh-codespace-http.js` | Created + Updated | HTTP-based refresh (no browser, 15x faster); updated `parseCodespaceList` to use suspend form presence for status |
| `scripts/check-codespace-status.js` | Created + Updated | Quick HTTP status checker using suspend form presence (active = form present, stopped = form absent) |
| `scripts/test-refresh-trace.js` | Created | Browser refresh with network tracing + timing instrumentation |
| `scripts/trace-stop.js` | Created | Browser network trace of the stop/suspend action (form submission via fetch) |
| `scripts/trace-page-load.js` | Created | Browser network trace of `/codespaces` page load (reveals no API calls for status) |
| `scripts/trace-browser-stop.js` | Created | Full flow: HTTP create + browser stop with network trace |
| `scripts/codespace-vm.js` | Modified | Added `refresh` action, `--keep-existing`, `--no-wait-stop` flags |
| `scripts/auth-browser.js` | Modified | Fixed Templates filter, added stop retry logic + `noWait` option + `menuitem` fallback |
| `scripts/README.md` | Modified | Documented refresh action, new flags, and new scripts |
