# Story: LAB-005 - Add CodeSandbox Provider

## 1. Jira Story

- Story Key: `LAB-005`
- Type: `Story`
- Priority: `Medium`
- Component: `API / Provider Abstraction`
- Labels: `codesandbox`, `provider`, `vps`

## 2. User Story

As a client application, I want to create temporary development sessions through CodeSandbox in addition to Google Cloud Shell, so users have another provider option for VPS-like development environments.

## 3. Goal

Add CodeSandbox as a supported provider in the current session orchestrator while preserving the existing API experience used for Google Cloud Shell sessions.

The provider should let clients:
- Discover CodeSandbox as an available provider.
- Create a Docker-based CodeSandbox session.
- Inspect the session state.
- Run shell commands in the session.
- Terminate the session when it is no longer needed.
- Select a CodeSandbox credential file using the same general authorization pattern used for Google Cloud credentials.

## 4. Background

The project currently supports Google Cloud Shell as the implemented provider. Play with Docker remains listed only as a deprecated demo stub.

CodeSandbox offers managed cloud development environments and can be used as another provider option. This story should treat CodeSandbox as a provider-backed environment, not as unlimited free infrastructure. Account, quota, plan, and usage limits are external CodeSandbox concerns and must be documented for operators.

CodeSandbox credentials must be stored as JSON files in an operator-controlled S3 bucket or server directory. The initial credential file format is:

```json
{
  "token": "xxxxx"
}
```

To avoid overloading free or low-capacity CodeSandbox accounts, the orchestrator must allow only one CodeSandbox sandbox/session per token. If a client asks to create another session with a token that already has a sandbox/session, the API must return the existing session instead of creating another sandbox.

CodeSandbox session creation is limited to Docker sandboxes. Clients must not be able to create other CodeSandbox template types through this provider.

## 5. Problem Statement

Current behavior:
- Users can request Google Cloud Shell sessions.
- Users cannot request CodeSandbox-backed sessions.
- The deprecated Play with Docker provider is not usable for real session creation.

Required behavior:
- Users can choose CodeSandbox when creating a session.
- CodeSandbox sessions are Docker-based and behave consistently with the existing session lifecycle.
- Users or operators can select which CodeSandbox token file is used for a session.
- The API prevents creating more than one CodeSandbox sandbox/session for the same token and reuses the existing session when a duplicate create is requested.
- Existing Google Cloud Shell behavior remains unchanged.

## 6. Scope

In scope:
- Add CodeSandbox to provider discovery.
- Create CodeSandbox-backed sessions.
- Return normalized session details for CodeSandbox sessions.
- Execute commands in CodeSandbox sessions.
- Terminate CodeSandbox sessions.
- Load CodeSandbox token files from S3 or a server directory.
- Enforce one CodeSandbox sandbox/session per token and return the existing session for duplicate create requests.
- Restrict CodeSandbox creation to Docker sandboxes.
- Document operator requirements and user-visible behavior.

Out of scope:
- Browser IDE embedding.
- CodeSandbox UI customization.
- File upload or download management.
- Custom domains or preview proxying.
- Billing, quota, or workspace administration.
- Making CodeSandbox the default provider.
- Removing or changing the existing Google Cloud Shell provider.

## 7. Functional Requirements

1. Provider discovery must include CodeSandbox as a supported provider.
2. Clients must be able to request a new session using the CodeSandbox provider.
3. Session creation must use a CodeSandbox credential JSON file selected by server default or request header.
4. Created sessions must be persisted and returned through the existing session list and detail endpoints.
5. Session details must identify the provider as CodeSandbox.
6. Clients must be able to run shell commands in an active CodeSandbox session.
7. If a CodeSandbox session can be resumed by the provider, command execution should recover the session before running the command.
8. Clients must be able to terminate CodeSandbox sessions through the existing session termination endpoint.
9. Provider errors must be returned as clear API errors without exposing secrets.
10. The API must not create a second CodeSandbox sandbox/session that would use the same token; it must return the existing session instead.
11. Session creation must fail clearly when the server cannot find, read, or validate the selected CodeSandbox token file.
12. CodeSandbox session creation must only create Docker sandboxes.
13. Existing Google Cloud Shell and Play with Docker discovery behavior must not regress.

## 8. User-Visible Behavior

Create session example:

```json
{
  "provider": "codesandbox"
}
```

Optional credential selection should follow the same general pattern as Google credential selection, using a provider-specific request header:

```http
X-CodeSandbox-Credentials: codesandbox/account-a.json
```

The API response should follow the same general shape as other session providers and include enough information for clients to identify and reuse the session.

If the selected CodeSandbox token already has a session, the create endpoint should return the existing session information and indicate that the existing sandbox/session was reused. No additional CodeSandbox sandbox should be created.

Command execution example:

```json
{
  "command": "echo hello"
}
```

The API response should include the command result or a clear error if the command cannot be executed.

## 9. Acceptance Criteria

1. Given the server is configured for CodeSandbox, when a client lists supported providers, then `codesandbox` is included.
2. Given the server is configured for CodeSandbox, when a client creates a session with provider `codesandbox`, then a CodeSandbox-backed session is created and persisted.
3. Given the server is configured for CodeSandbox, when a client creates a session with provider `codesandbox`, then the created session is Docker-based.
4. Given a valid CodeSandbox credential JSON file exists, when a client creates a session with provider `codesandbox`, then the token from that file is used to create the session.
5. Given a CodeSandbox session exists, when a client retrieves the session, then the response identifies it as a CodeSandbox session and includes current state.
6. Given a CodeSandbox session exists, when a client runs a shell command, then the API returns the command result.
7. Given a CodeSandbox session is inactive but recoverable, when a client runs a command, then the provider attempts to recover the session before executing the command.
8. Given a CodeSandbox session exists, when a client terminates it, then the API attempts provider cleanup and removes the local session according to the existing termination behavior.
9. Given CodeSandbox returns an error, then the API returns a sanitized provider error without leaking credentials.
10. Given a CodeSandbox token already has a session, when a client tries to create another CodeSandbox session with the same token, then the API returns the existing session and does not create a new sandbox.
11. Given the selected CodeSandbox credential file is missing, malformed, or lacks `token`, then the API returns a clear credential error and no session is persisted.
12. Given existing Google Cloud Shell flows, then create, list, refresh, command, keep-alive, and terminate behavior remain unchanged.
13. Given the deprecated Play with Docker provider, then it remains a registered stub and is not reimplemented by this story.

## 10. Non-Functional Requirements

- Provider-specific failures must not crash the API process.
- Error messages must be actionable for operators and safe for clients.
- Tokens must not be returned in API responses or logs.
- The implementation must keep provider behavior isolated so future providers can follow the same pattern.
- Documentation must clearly state that CodeSandbox usage depends on the operator's CodeSandbox account and limits.

## 11. Risks

- CodeSandbox account limits, pricing, or free-tier behavior may change.
- CodeSandbox session lifecycle may not exactly match Google Cloud Shell lifecycle.
- Termination semantics may be destructive if users expect sandbox state to persist.
- Incorrect token/session locking could allow more than one sandbox/session per token.

## 12. Definition of Done

- CodeSandbox appears in supported provider discovery.
- CodeSandbox sessions can be created, inspected, used for commands, and terminated.
- CodeSandbox session creation is limited to Docker sandboxes.
- CodeSandbox token JSON files can be loaded from S3 or server directory.
- One CodeSandbox sandbox/session per token is enforced.
- Missing, malformed, or invalid credential files return clear API errors.
- Existing provider behavior is not regressed.
- Operator documentation is updated.
