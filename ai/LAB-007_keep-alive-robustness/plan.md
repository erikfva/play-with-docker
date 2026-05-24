# LAB-007 Implementation Plan: Robust Keep-Alive Service & PostgreSQL Fixes

## 1. Goal Description
Implement an updated keep-alive service and GCS provider adapter to ensure complete compatibility with PostgreSQL database fields, prevent stats memory leaks under load (individual and bulk), support generic and idempotent startup checks, avoid scheduled task overlapping, automatically stop dead timers, and prevent hourly Google Cloud Shell suspensions via API control-plane keep-alive pings.

---

## 2. Proposed Changes

### Component: GCS Provider
#### [gcs-provider.js](file:///config/workspace/play-with-docker/src/services/providers/gcs-provider.js)
* Import case-insensitive helper `getRowValue` to resolve lowercase PostgreSQL fields.
* Retrieve `privateKey`, `publicKey`, and `credentialRef` using `getRowValue` during keep-alive, commands, and termination.
* Prevent GCS from generating duplicate SSH keypairs when key material already exists in the database.
* Implement a **Control-Plane API Keep-Alive (Hybrid Strategy)**: call `gcsService.startCloudShellSession` inside `executeKeepAlive` for active `RUNNING` sessions to reset Google's 1-hour idle/inactivity suspension timeout at the API control-plane level.

### Component: Keep-Alive Service
#### [keep-alive-service.js](file:///config/workspace/play-with-docker/src/services/keep-alive-service.js)
* Switch scheduler from `setInterval` to recursive `setTimeout` to prevent overlapping runs.
* Maintain a consecutive failure counter (threshold: 3 consecutive fails). On breach, terminate timer and mark database session row `status = 'FAILED'`.
* Standardize startup recovery using a generic `isSessionActive` verification if supported by the provider, removing hardcoded `gcs` checks.
* Implement `clearKeepAliveStats(sessionId)` and ensure `stopAllKeepAlives()` clears all internal stats from `keepAliveStats`.
* Guarantee recovery idempotency by checking `activeKeepAliveTimers`.

### Component: API Route Integration
#### [sessions.js](file:///config/workspace/play-with-docker/src/routes/sessions.js)
* Call `clearKeepAliveStats(row.id)` in the DELETE session route after compiling response metadata.

---

## 3. Verification Plan

### Automated Tests
* Execute the active testing suite:
  ```bash
  npm test
  ```
* Run custom integration tests in `tests/keep-alive-robustness-LAB007.test.js` verifying memory stats deallocation, deactivation on failures, and recursive scheduling.
* Add an integration test in `tests/gcs-keep-alive-robustness.test.js` (or similar) to assert that `startCloudShellSession` is invoked inside `executeKeepAlive` for active running sessions to verify control-plane ping functionality.
