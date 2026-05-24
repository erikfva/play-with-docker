# LAB-007 Specification: Robust Keep-Alive Service & PostgreSQL Fixes

## Main Specification: Robust Session Keep-Alive Engine
The VM orchestrator requires a robust, provider-agnostic, and database-compatible keep-alive engine. The system must support case-insensitive database lookups (for PostgreSQL compatibility), safe timer deallocation to avoid memory leaks, generic startup recovery checks, recursive timeout scheduling to prevent execution overlaps, and automatic deactivation when remote sessions fail repeatedly.

---

## Requirements & Subtasks

### Requirement 1: PostgreSQL Cross-Database Case Compatibility
* The GCS provider must dynamically resolve session database properties using case-insensitive lookups.
* **Subtask:** Implement `getRowValue` for all dynamic lookups in `gcs-provider.js` (including `privateKey`, `publicKey`, and `credentialRef`) to ensure compatibility with lowercase column fields returned by PostgreSQL.

### Requirement 2: Keep-Alive Statistics Memory Leak Prevention
* Keep-alive service statistics stored in memory must be explicitly released upon session deallocation.
* **Subtask:** Expose a stats pruning method in the keep-alive service and call it in the session DELETE route once stats are fetched and returned to the client.

### Requirement 3: Dynamic & Provider-Agnostic Recovery Check
* Startup keep-alive recovery must dynamically inspect and verify remote session status without provider hardcoding.
* **Subtask:** Replace the hardcoded GCS name check with a generic verification using the provider's `isSessionActive(sessionRow)` method if defined.

### Requirement 4: Failure Threshold & Deactivation
* A keep-alive task must automatically deactivate when its remote environment has permanently failed or terminated.
* **Subtask:** Implement a threshold of max 3 consecutive failures. If keep-alive fails consecutively 3 times, cancel the timer and set the session status to `FAILED` in the database.

### Requirement 5: Recursive Timeout Scheduling (Overlapping Prevention)
* Scheduled keep-alive tasks must execute sequentially without overlapping, even when remote commands or API calls are slow.
* **Subtask:** Transition the timer scheduler in `keep-alive-service.js` from `setInterval` to recursive `setTimeout` scheduling.
