# Agent Runtime Context

Use this when changing `AgentRuntime`, tools, permissions, lifecycle hooks, cancellation, or core runtime contracts.

## Key files

- `src/core/runtime.ts` — `AgentRuntime`, `createRuntime`, run loop, persistence, tool execution, hooks, cancellation.
- `src/core/types.ts` — `Message`, `ToolCall`, `ToolResult`, run status, stop reasons, hook payloads, `AgentRunInput`.
- `src/core/agent.ts` — `AgentDefinition`, `defineAgent(...)`.
- `src/core/tool.ts` — `ToolDefinition`, `defineTool(...)`, permission policy types.
- `src/core/providers.ts` — `ModelProvider` contract and `StubProvider`.
- `src/core/schema.ts` — Zod/JSON Schema detection and normalization.
- `src/core/storage.ts` — compatibility re-export for storage types/adapters.

## Runtime responsibilities

`AgentRuntime` is the SDK's provider-neutral execution loop. It:

1. receives `AgentRunInput`
2. builds the current message list
3. calls the configured `ModelProvider`
4. appends assistant messages and generated images
5. executes requested local tools
6. appends linked tool-result messages
7. persists transcript/run/session metadata through storage
8. returns a normalized `RuntimeResult`

The runtime should not contain provider-specific branches or UI/harness-specific behavior.

## Run data flow

`AgentRuntime.run(...)` roughly does this:

1. Choose a `runId` from input or generate one with `randomUUID()`.
2. Reject duplicate active `runId`s.
3. Create an internal `AbortController` and merge it with caller `signal` via `AbortSignal.any(...)` when provided.
4. Register the active run for `cancel(...)`, `cancelAll(...)`, and `getActiveRuns()`.
5. If not `ephemeral`, load prior transcript messages from storage and filter out any stored `system` messages.
6. If storage implements V2 state hooks, read base revision/message count and call `beginRun(...)` when available.
7. Load previous session metadata when supported.
8. Build current session metadata: `agentName`, `model`, `promptHash`, `promptSnapshot`, `toolsetHash`, `updatedAt`.
9. Build new input messages via `agent.buildMessages(input)` or default to one `role: "user"` message.
10. Construct current run messages as:
    - current `system` instructions
    - previous non-system transcript
    - new base input messages
11. Loop up to `maxSteps` (default `5`):
    - call `provider.generate(...)`
    - canonicalize tool call IDs
    - append assistant message when present
    - collect `generatedImages`
    - stop as `completed` if there are no tool calls
    - execute tool calls and append `role: "tool"` messages
    - stop as `max_steps_reached` if the last step still needs tools
12. Persist non-ephemeral runs.
13. Remove the active run in `finally`.

## Ephemeral mode

`ephemeral: true` means:

- do not load prior transcript
- do not load previous session metadata
- pass `previousSessionMetadata: null` to providers
- pass `ephemeral: true` to providers
- do not persist transcript, run state, or metadata

OpenRouter also has provider-level `continuation.strategy: "ephemeral"`; see `agent_providers.md`.

## Persistence behavior

Runtime persistence is transcript-first:

- System messages are stripped before persistence.
- Legacy storage path calls:
  - `saveMessages(sessionId, transcriptMessages)`
  - `saveRun({ sessionId, status })`
  - optional `setSessionMetadata(sessionId, metadata)`
- V2 storage path prefers `commitRun(...)` when available and passes:
  - `previousMessages`
  - `newMessages`
  - `fullMessages`
  - base revision/message count
  - run status and metadata

If `commitRun(...)` returns `conflict: true`, runtime throws a storage commit conflict error.

## Tool call rules

Provider responses may include `toolCalls`. Runtime owns local tool execution.

Important rules:

- Missing tool call IDs are canonicalized as:

  ```txt
  ${toolName}-${step}-${index}
  ```

- Assistant messages are rewritten to contain canonical tool call IDs.
- Tool results are appended as SDK messages:

  ```ts
  {
    role: "tool",
    name: toolCall.toolName,
    content: JSON.stringify(result),
    date: new Date(),
    toolCallId,
  }
  ```

- Unknown tools produce `{ ok: false, error: "Unknown tool: ..." }` and emit `unknown_tool` lifecycle finish events.
- Tool `execute(...)` exceptions are caught and converted to `{ ok: false, error }` tool results.
- Tool execution receives `{ sessionId, step, runId, signal }` in `AgentContext`.

## Tool permissions

Tool permission modes are defined in `src/core/tool.ts`:

```ts
type ToolPermissionMode = "always" | "ask" | "never";
```

Resolution order:

1. tool-specific `permission.mode`
2. runtime `toolPermission.defaultMode`
3. implicit `always`

Semantics:

- `always` — execute without asking.
- `ask` — call `hooks.requestToolPermission(request)`.
- `never` — deny without asking or executing.
- `ask` with no permission hook denies safely.

Denied permissions are normal failed tool results, not thrown runtime errors. This preserves transcript replay and lets the model recover in later steps.

## Runtime hooks

Runtime hooks are UI-neutral; external harnesses bridge them into their own event/protocol/UI layers.

Permission hooks:

- `onToolPermissionRequested(request)`
- `requestToolPermission(request)`
- `onToolPermissionResolved(request, decision)`

Tool lifecycle hooks:

- `onToolCallStart(event)` fires only for allowed known tools immediately before `execute(...)`.
- `onToolCallFinish(event)` fires for completed, failed, denied, and unknown tool calls.

Lifecycle finish statuses:

- `completed`
- `failed`
- `denied`
- `unknown_tool`

Hooks are awaited. If a hook is best-effort telemetry, catch transport errors inside the hook implementation.

## Cancellation

Cancellation is cooperative.

- Pass a stable `runId` and call `runtime.cancel(runId, reason)` to stop one active run.
- Call `runtime.cancelAll(reason)` to stop all active runs in this runtime instance.
- Pass a caller-owned `AbortSignal` in `AgentRunInput.signal` for external cancellation.
- Providers receive `signal` in `ModelProvider.generate(...)` input.
- Tools receive `signal` in `AgentContext` and should stop promptly when aborted.

Cancelled runs return `status: "cancelled"` and `stopReason: "cancelled"`. Non-ephemeral cancelled runs persist current partial state.

## Runtime tests

Use these tests when changing runtime behavior:

```bash
npx vitest run tests/runtime-storage.test.ts
npx vitest run tests/runtime-permissions.test.ts
npx vitest run tests/runtime-cancellation.test.ts
npx vitest run tests/runtime-tool-lifecycle.test.ts
```

Important coverage includes transcript persistence, resume behavior, canonical tool call IDs, failure handling, ephemeral mode, permission denials, lifecycle hook payloads, and cancellation propagation.
