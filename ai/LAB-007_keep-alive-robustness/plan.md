# LAB-007 Implementation Plan: Robust Keep-Alive Service & PostgreSQL Fixes

## 1. Goal Description
Implement an updated keep-alive service and GCS provider adapter to ensure complete compatibility with PostgreSQL database fields, prevent stats memory leaks, support generic startup checks, avoid scheduled task overlapping, and automatically stop dead timers.

---

## 2. Proposed Changes

### Component: GCS Provider
#### [gcs-provider.js](file:///config/workspace/play-with-docker/src/services/providers/gcs-provider.js)
* Import case-insensitive helper `getRowValue`.
* Retrieve `privateKey`, `publicKey`, and `credentialRef` using `getRowValue` to resolve lowercase PostgreSQL fields.

### Component: Keep-Alive Service
#### [keep-alive-service.js](file:///config/workspace/play-with-docker/src/services/keep-alive-service.js)
* Switch scheduler from `setInterval` to recursive `setTimeout`.
* Maintain a consecutive failure counter (threshold: 3 consecutive fails). On breach, terminate timer and mark database session row `status = 'FAILED'`.
* Standardize GCS-hardcoded checks in startup recovery using a generic `isSessionActive` check.
* Implement `clearKeepAliveStats(sessionId)` memory cleanup.

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
* Run custom integration tests in `tests/keep-alive-robustness-LAB007.test.js` verifying deallocation, deactivation on failures, and recursive scheduling.
