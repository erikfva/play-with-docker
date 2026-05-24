# LAB-007 Specification: Robust Keep-Alive Service & PostgreSQL Fixes

## Main Specification: Robust Session Keep-Alive Engine
The VM orchestrator requires a robust, provider-agnostic, and database-compatible keep-alive engine. The system must support case-insensitive database lookups (for PostgreSQL compatibility), safe timer and statistics deallocation to prevent memory leaks under load, idempotent startup recovery checks, recursive timeout scheduling to avoid overlapping executions, and automatic timer shutdown when remote environments fail consecutively.

---

## Requirements & Subtasks

### Requirement 1: PostgreSQL Cross-Database Case Compatibility
* The GCS provider must dynamically resolve session database properties using case-insensitive lookups to operate successfully on PostgreSQL.
* **Subtasks:**
  * Implement `getRowValue` lookups in `gcs-provider.js` for `privateKey` and `publicKey` during keep-alive executions, commands, and termination.
  * Implement `getRowValue` for `credentialRef` in the credential initialization path.
  * Ensure the GCS provider correctly reuses existing database SSH keypairs rather than repeatedly generating new ones on PostgreSQL.

### Requirement 2: Keep-Alive Statistics Memory Leak Prevention
* Keep-alive service statistics stored in the internal memory registry must be fully released when sessions are terminated individually or in bulk.
* **Subtasks:**
  * Expose `clearKeepAliveStats(sessionId)` in `keep-alive-service.js` to delete a session's stats from the memory Map.
  * Call `clearKeepAliveStats(row.id)` in the DELETE session route after the statistics are fetched and compiled into the client response.
  * Ensure `stopAllKeepAlives()` clears all entries in the `keepAliveStats` registry to avoid memory leaks during bulk terminations.

### Requirement 3: Dynamic & Provider-Agnostic Recovery Check
* Startup keep-alive recovery must dynamically inspect and verify remote session status without provider-specific hardcoding.
* **Subtasks:**
  * Remove the hardcoded `provider.name === 'gcs'` check from the startup recovery loop.
  * Programmatically inspect if a provider defines `isSessionActive(sessionRow)` as a function, and execute it generically for any eligible provider.
  * Maintain strict startup recovery idempotency by checking `activeKeepAliveTimers` to prevent scheduling duplicate timers.

### Requirement 4: Failure Threshold & Deactivation
* Scheduled keep-alive tasks must automatically deactivate and update their database state when remote environments have permanently failed, are deleted, or credentials expire.
* **Subtasks:**
  * Implement a counter to track consecutive keep-alive failures per session, resetting to `0` upon any successful run.
  * Enforce a threshold limit of `MAX_CONSECUTIVE_FAILURES = 3`.
  * If the threshold is breached, immediately cancel the scheduled keep-alive timer.
  * Automatically update the database session status to `FAILED` to flag the environment's death to operators.

### Requirement 5: Recursive Timeout Scheduling (Overlapping Prevention)
* Scheduled keep-alive tasks must run sequentially without overlaps, even when remote network calls or SSH command runs are slow.
* **Subtasks:**
  * Transition from the fixed-interval `setInterval` scheduler to recursive `setTimeout` scheduling.
  * Ensure the next execution is only queued after the current async task resolves (regardless of success or failure).
  * Update `stopKeepAlive` and `stopAllKeepAlives` to use `clearTimeout` to cleanly cancel pending scheduled tasks.
