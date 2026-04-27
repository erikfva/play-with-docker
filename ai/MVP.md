# MVP: Multi-Provider VPS Orchestrator

This document defines the MVP for a provider-agnostic Virtual Development Environment Orchestrator.
The API must support multiple providers behind one common contract, with a clean extension path for future providers (for example AWS).

## 1. Goal

Expose one stable API to create and manage temporary VPS-like development sessions across different backends.

Initial provider scope:
- `gcs` (Google Cloud Shell) - implemented
- `pwd` (Play with Docker) - demo stub only; service deprecated as of March 2026, will not be implemented

Post-MVP target:
- `aws` (adapter to be added later)

## 2. Core Architecture

Use a **Provider Adapter + Factory** pattern.

### 2.1 Provider Contract

Each provider implements the same interface:
- `createSession(input) -> ProviderSession`
- `refreshSession(sessionRow) -> ProviderSessionUpdate`
- `executeCommand(sessionRow, command) -> CommandResult`
- `terminateSession(sessionRow) -> void`

### 2.2 Service Layout

- `src/services/providers/base-provider.js` - provider interface
- `src/services/providers/gcs-provider.js` - GCS adapter implementation
- `src/services/providers/pwd-provider.js` - PWD demo stub (Play with Docker deprecated March 2026, not implemented)
- `src/services/provider-factory.js` - provider resolution and registry
- `src/services/errors/provider-errors.js` - normalized provider error classes

### 2.3 Normalized Session Model

Persist provider-neutral fields in `sessions`:
- `id` (internal UUID)
- `provider` (`gcs`, `pwd` [demo stub], future `aws`)
- `providerSessionId` (provider-native session/environment ID)
- `status`
- `sshCommand`
- `webHost`
- `privateKey` / `publicKey` (when needed for command execution)
- `metadata` (JSON text for provider-specific details)
- `createdAt`

Compatibility note:
- Legacy `envName` is still stored/backfilled for older rows; new flows use `providerSessionId`.

## 3. API Design (Provider-Aware)

Use one API surface with explicit provider selection.

- `POST /api/v1/sessions`
  - Body may include `provider` (defaults to `gcs`)
  - Uses provider factory to resolve adapter
- `GET /api/v1/sessions/:id`
  - Returns DB-backed session plus best-effort provider refresh
- `POST /api/v1/sessions/:id/command`
  - Runs command through resolved provider adapter
- `DELETE /api/v1/sessions/:id`
  - Calls provider termination hook, then deletes local row
- `GET /api/v1/sessions/providers/supported`
  - Lists registered providers

Rules:
- Public API uses internal `id`.
- Provider-native IDs stay in `providerSessionId`.
- Provider errors are mapped to consistent HTTP responses.

## 4. Database Changes

`src/db/db.js` must ensure schema supports provider-aware sessions:
- Add missing columns if needed (`provider`, `providerSessionId`, `metadata`, etc.)
- Backfill `provider = 'gcs'` when missing
- Backfill `providerSessionId = envName` for legacy rows

## 5. MVP Implementation Phases

### Phase 1: Provider Abstraction (Complete)
1. Define provider base contract.
2. Add provider factory.
3. Route session operations through provider adapters.

### Phase 2: Google Cloud Shell Adapter (Complete)
1. Implement session create/refresh/command/terminate behavior.
2. Map GCS response fields to normalized model.
3. Handle SSH key lifecycle for command execution.

### Phase 3: Schema/Route Refactor (Complete)
1. Persist `providerSessionId` and provider metadata.
2. Keep compatibility with legacy `envName`.
3. Standardize provider errors in routes.

### Phase 4: Second Provider and Hardening (In Progress)
1. Implement real `pwd-provider` behavior (currently stubbed with 501).
2. Add integration tests for provider contract behavior.
3. Improve timeout/retry/error mapping per provider.

## 6. MVP Feature Status

- [x] Create session with provider selection (`gcs` default)
- [x] Retrieve session with normalized provider flow
- [x] Execute command through provider adapter (`gcs`)
- [x] Terminate session with provider hook + DB cleanup
- [x] Persist provider/session mapping in SQLite
- [ ] Implement full `pwd` provider behavior (skipped — Play with Docker deprecated as of March 2026, `pwd` is a demo stub only)
- [ ] Add provider-level integration test coverage

## 7. Risks and Constraints

- **Provider capability mismatch**: Different providers expose different lifecycle operations (for example, no explicit "stop" API in Cloud Shell). Adapter must implement best-effort semantics.
- **Credential model differences**: Auth flows vary by provider and may require per-provider setup.
- **Operational consistency**: Status models and errors differ by provider; normalization layer must remain strict and well-tested.
