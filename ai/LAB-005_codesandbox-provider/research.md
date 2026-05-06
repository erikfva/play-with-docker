# Research: LAB-005 - CodeSandbox Provider API Requirements

## 1. Research Date

2026-05-05

## 2. Sources

- CodeSandbox SDK introduction: https://codesandbox.io/docs/sdk
- Creating sandboxes: https://codesandbox.io/docs/sdk/create
- Commands API: https://codesandbox.io/docs/sdk/commands
- Resuming sandboxes: https://codesandbox.io/docs/sdk/resume
- Deleting sandboxes: https://codesandbox.io/docs/sdk/delete
- Lifecycle management: https://codesandbox.io/docs/sdk/manage-sandboxes
- Clients: https://codesandbox.io/docs/sdk/clients
- VM specs: https://codesandbox.io/docs/sdk/specs
- SDK pricing: https://codesandbox.io/docs/sdk/pricing

## 3. Findings

### 3.1 SDK and Authentication

CodeSandbox documents `@codesandbox/sdk` as the supported SDK package for programmatically creating and running sandboxed development environments.

The documented API key setup is:
- Create an API key at `https://codesandbox.io/t/api`.
- Enable the required scopes.
- Expose the key as `CSB_API_KEY`.
- Instantiate the SDK with `new CodeSandbox()`.

Plan impact:
- `CSB_API_KEY` should be the primary env var.
- `CODESANDBOX_API_KEY` can remain a project-specific alias, but it is not the documented CodeSandbox default.

### 3.2 Sandbox Creation

The docs show two valid creation paths:
- Create a default sandbox with `sdk.sandboxes.create()`.
- Create from a template or existing sandbox with `sdk.sandboxes.create({ id: "template-or-sandbox-id" })`.
- The current project requirement restricts provider creation to Docker sandboxes, so the implementation should use the CodeSandbox Docker template id.

Supported create options documented by CodeSandbox include:
- `id`
- `title`
- `description`
- `tags`
- `privacy`
- `path`
- `vmTier`
- `hibernationTimeoutSeconds`
- `automaticWakeupConfig`

Privacy options are:
- `public`
- `private`
- `public-hosts`

Sandbox objects expose at least:
- `id`
- `isUpToDate`
- `cluster`
- `bootupType`

Plan impact:
- The provider should map the Docker sandbox policy to SDK `id: "docker"`.
- The provider should not expose arbitrary template selection.
- The plan should add optional `path` and `automaticWakeupConfig` support if operator control is needed.

### 3.3 VM Tier Requirements

The VM specs docs show VM tier configuration using the SDK `VMTier` export:

```js
import { CodeSandbox, VMTier } from "@codesandbox/sdk";

const sandbox = await sdk.sandboxes.create({
  vmTier: VMTier.Small
});
```

The docs also show `VMTier.fromSpecs({ cpu, memGiB })`.

Plan impact:
- Request strings such as `Nano`, `Micro`, or `Small` need to be mapped to the SDK `VMTier` enum.
- The provider should validate tier names before calling the SDK.
- Higher-tier behavior may depend on templates and account limits.

### 3.4 Command Execution

The commands docs describe command execution through a connected client:

```js
const client = await sandbox.connect();
const output = await client.commands.run("npm install");
```

The docs also support:
- `client.commands.run([...])` for arrays of commands.
- `client.commands.runBackground(...)` for long-running commands.
- `client.ports.waitForPort(...)` for server processes.

Plan impact:
- The provider should use `sandbox.connect()` followed by `client.commands.run(command)`.
- The API request can keep the current `{ "command": "..." }` shape.
- For this story, command execution should focus on completion-based commands. Long-running task/port management should be a future story.
- The docs show output from `commands.run`, but they do not document a stable exit-code field. The API should not require `exitCode` unless verified during implementation.

### 3.5 Resume and Clean Boot

The resume docs show:

```js
const sandbox = await sdk.sandboxes.resume("sandbox-id");
```

Resume can restore a memory snapshot, but if that is unavailable the sandbox may perform a clean boot. The docs recommend tracking `bootupType`; when it is `CLEAN`, setup steps may need to be waited on before use.

Plan impact:
- Command execution should resume by sandbox ID before connecting.
- If `sandbox.bootupType === "CLEAN"`, the provider should evaluate whether to wait for setup steps before running commands.
- Metadata should persist `bootupType` for diagnostics.

### 3.6 Client Disposal

The lifecycle examples call `client.dispose()` after command work.

Plan impact:
- The provider should dispose the connected client in a `finally` block when the SDK client exposes `dispose()`.

### 3.7 Delete, Hibernate, and Lifecycle Strategy

The delete docs state that deleting a sandbox removes it from persistence and performs a soft delete. It is intended for ephemeral sandboxes that will not be resumed later.

Lifecycle docs recommend active lifecycle management for cost and predictable UX. They recommend:
- Set `hibernationTimeoutSeconds` to `86400` for active lifecycle management.
- Set `automaticWakeupConfig` to `false`.
- Resume when a session starts.
- Hibernate or delete when a session ends.

Plan impact:
- The plan's initial decision to make API termination delete the sandbox is valid for ephemeral sessions.
- The user-facing docs should clearly state termination deletes the CodeSandbox environment.
- If persistence matters, a future hibernate/resume API should be added.
- Consider changing the default hibernation timeout from `300` to `86400` only if this API takes responsibility for explicit hibernate/delete lifecycle management.

### 3.8 Pricing and "Free VPS" Assumption

The pricing docs say the SDK has two cost dimensions:
- VM credits for runtime.
- VM concurrency limits by plan.

The docs list the Build/free plan as having 10 concurrent VMs, but VM runtime is still credit-based.

Plan impact:
- Do not describe CodeSandbox as unlimited free VPS infrastructure.
- Document that CodeSandbox usage depends on the operator's CodeSandbox account, plan, credits, and concurrency limits.

## 4. Verified API Requirements for This Project

The current project can validate CodeSandbox through the existing session API shape:

- `GET /api/v1/sessions/providers/supported`
- `POST /api/v1/sessions`
- `GET /api/v1/sessions/:id`
- `POST /api/v1/sessions/:id/command`
- `DELETE /api/v1/sessions/:id`

The HTTP request collection should include:
- Provider discovery check.
- CodeSandbox session creation.
- CodeSandbox session details.
- CodeSandbox command execution.
- CodeSandbox termination.
- Missing provider configuration scenario, validated by running the create request without CodeSandbox API key configured.

## 5. Plan Corrections Recommended

1. Prefer `CSB_API_KEY` as the documented env var and keep `CODESANDBOX_API_KEY` as an alias.
2. Map the Docker-only creation policy to SDK create option `id: "docker"`.
3. Add optional support for SDK create options `path` and `automaticWakeupConfig`.
4. Map string VM tier names to `VMTier` constants before calling the SDK.
5. Do not guarantee `exitCode` in command responses unless implementation verifies it from the SDK return value.
6. Dispose SDK clients after command execution when supported.
7. Track `bootupType` and handle `CLEAN` boot setup before running commands when applicable.
8. Keep initial terminate-as-delete behavior only for ephemeral sessions and document that it removes sandbox persistence.
9. Keep CodeSandbox keep-alive disabled; use resume-on-demand and provider lifecycle management instead.

## 6. Conclusion

The LAB-005 plan is feasible against the current CodeSandbox SDK documentation. The main required adjustment is precision: CodeSandbox is SDK-based, uses `CSB_API_KEY` by default, command execution requires a connected sandbox client, and lifecycle management should explicitly choose delete or hibernate based on whether the project treats sessions as ephemeral.
