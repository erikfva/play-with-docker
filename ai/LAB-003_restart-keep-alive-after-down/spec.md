# Story: LAB-003 - Restart Keep-Alive After Server Downtime

## 1. Jira Story

- Story Key: `LAB-003`
- Type: `Story`
- Priority: `High`
- Component: `API / Session Lifecycle / Keep-Alive`
- Labels: `gcs`, `keep-alive`, `resilience`, `restart-recovery`

## 2. Summary

As a platform operator, I want keep-alive jobs for active Google Cloud Shell sessions to be automatically restored when the API server restarts, so existing sessions do not expire only because the orchestrator process was down.

## 3. Problem Statement

Current behavior:
- Keep-alive timers run in-memory.
- When the API server stops, timers are lost.
- Session rows remain in PostgreSQL, but no keep-alive resumes automatically.
- GCS sessions can transition to inactive/suspended state due to inactivity timeout during or after downtime.

Required behavior:
- On server startup, the system must load recoverable sessions from DB and restart provider-aware keep-alive for eligible sessions.
- If a recovered GCS session is verified as stopped/inactive, the stale session row must be removed from DB.

## 4. Scope

In scope:
- Startup recovery flow that rehydrates keep-alive timers from persisted sessions.
- Eligibility filtering by provider and session status.
- Safe idempotent behavior to avoid duplicate timers.
- Startup and recovery logging for observability.

Out of scope:
- Backfilling missed keep-alive executions during downtime.
- New scheduler infrastructure outside current process model.
- Full PWD provider lifecycle implementation.

## 5. Functional Requirements

1. On API startup (after DB readiness), execute a keep-alive recovery routine.
2. Query `sessions` table and evaluate each row for keep-alive eligibility.
3. Only providers with `getKeepAliveConfig().enabled === true` are recoverable.
4. For each eligible session, restart keep-alive via existing `keepAliveService.startKeepAlive(sessionRow, provider)`.
5. Recovery routine must be idempotent in-process (no duplicate timers for same session ID).
6. Sessions with terminal states must not be scheduled.
7. Recovery routine must continue processing remaining sessions even if one session/provider fails.
8. Emit structured logs with totals: scanned, eligible, started, skipped, failed.
9. During recovery, if a GCS session is verified as stopped/inactive, delete that session entry from `sessions` table and log the cleanup action.

## 6. Eligibility Rules (Initial Version)

A session is eligible for keep-alive recovery when all are true:
1. `provider` resolves to a known provider in provider factory.
2. Provider keep-alive is enabled.
3. `status` is not terminal.

Initial terminal statuses:
- `TERMINATED`
- `DELETED`
- `FAILED`

Notes:
- If `status` is null/unknown, treat as potentially recoverable and attempt scheduling.
- If provider resolution fails, skip and log warning.
- Before scheduling keep-alive, recovery may verify whether the provider session is still active.
- If verification confirms the GCS session is stopped/inactive, do not schedule keep-alive and delete the DB row.

## 7. Technical Design

### 7.1 New Service Method

Add a recovery method in keep-alive service (or dedicated bootstrap service), for example:
- `recoverKeepAlivesOnStartup()`

Responsibilities:
- Load session rows from DB.
- Resolve provider via provider factory.
- Apply eligibility rules.
- Optionally verify remote provider session activity for recoverable rows.
- If provider is `gcs` and verification confirms stopped/inactive, delete stale DB row.
- Call `startKeepAlive` for eligible sessions.
- Aggregate and return recovery summary.

### 7.2 Server Bootstrap Integration

Update startup flow in `src/server.js`:
1. Load credentials init.
2. Wait for DB ready.
3. Run keep-alive recovery routine.
4. Start HTTP listener.

Alternative acceptable order:
- Start listener, then run recovery in background, as long as recovery is guaranteed to execute once on startup and is logged.

### 7.3 Observability

Required log events:
- Recovery start.
- Per-session warning/error logs (provider missing, start failure, etc.).
- Per-session cleanup logs when stale stopped sessions are deleted.
- Recovery summary with counts.

Example summary log:
`[KeepAlive][Recovery] scanned=12 eligible=8 started=7 cleaned=2 skipped=3 failed=1`

## 8. Acceptance Criteria (Jira)

1. Given existing GCS sessions in DB and API restart, keep-alive timers are recreated automatically without manual API calls.
2. Given mixed provider rows (`gcs`, `pwd`), only eligible provider sessions are started for keep-alive.
3. Given startup with no sessions, recovery completes successfully and logs zero counts.
4. Given one broken session row/provider error, remaining eligible sessions still recover.
5. Given restart executed multiple times, each process instance has at most one timer per recovered session ID.
6. Recovery outcome is visible in logs with scanned/eligible/started/skipped/failed counts.
7. Given a persisted GCS session that is verified stopped/inactive during startup recovery, the session row is deleted from DB and reported in recovery logs/summary.

## 9. Non-Functional Requirements

- Startup recovery should complete within a reasonable time for expected session volume (target: < 5s for 100 sessions, excluding external provider calls).
- Recovery must not crash server startup due to per-session failures.
- Memory impact should remain bounded by one timer per recovered session.
- Cleanup deletes should be best-effort per row and must not stop recovery of remaining sessions.

## 10. Test Plan

### 10.1 Unit Tests

1. Recovery selects eligible rows only.
2. Recovery skips terminal states.
3. Recovery skips providers with keep-alive disabled.
4. Recovery handles unknown provider gracefully.
5. Recovery aggregates counts correctly.
6. Recovery deletes DB rows for sessions verified as stopped/inactive (GCS case).

### 10.2 Integration Tests

1. Create GCS session, restart API process, verify keep-alive resumes (via logs/stats).
2. Verify no duplicate timer after repeated recovery invocation in same process.
3. Verify partial failure does not block other session recoveries.
4. Verify stopped/inactive GCS session is cleaned from DB during startup recovery.

## 11. Implementation Tasks

1. Add recovery routine in keep-alive service (or bootstrap service).
2. Add provider/status eligibility helper.
3. Integrate recovery call in server startup path.
4. Add structured recovery logs and summary.
5. Add/extend tests for recovery flow.
6. Update project docs to mention restart recovery behavior.
7. Add stale-session cleanup metrics/count (`cleaned`) to recovery summary output.

## 12. Risks and Mitigations

- Risk: Wrong status mapping may skip valid sessions.
- Mitigation: Keep terminal list explicit and minimal, log all skips with reason.

- Risk: Startup delay if recovery does provider network checks.
- Mitigation: Recovery should only schedule timers; avoid heavy remote calls during bootstrap.

- Risk: Duplicate timers from accidental double invocation.
- Mitigation: Reuse existing `activeKeepAliveTimers` guard and keep recovery single-run per process start.

## 13. Definition of Done

- Code merged with recovery-on-startup behavior.
- Acceptance criteria validated in local/dev environment.
- Logs demonstrate successful recovery summary after restart.
- Documentation updated with operational expectations.
