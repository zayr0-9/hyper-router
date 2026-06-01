import { describe, expect, it, vi } from "vitest";

import { defineAgent } from "../src/core/agent.js";
import type { ModelProvider } from "../src/core/providers.js";
import { createRuntime } from "../src/core/runtime.js";
import { InMemoryStorage } from "../src/core/storage.js";
import { defineTool } from "../src/core/tool.js";
import type { ModelResponse, ToolCall } from "../src/core/types.js";

function createPendingProvider() {
  const calls: Array<{ runId?: string; signal?: AbortSignal }> = [];
  const provider: ModelProvider = {
    generate: vi.fn(
      async (input): Promise<ModelResponse> =>
        new Promise((resolve, reject) => {
          calls.push({ runId: input.runId, signal: input.signal });
          input.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    ),
  };

  return { provider, calls };
}

describe("AgentRuntime cancellation", () => {
  it("passes run identifiers and AbortSignal to the provider and returns cancelled on abort", async () => {
    const { provider, calls } = createPendingProvider();
    const storage = new InMemoryStorage();
    const savedRuns: Array<{ sessionId: string; status: string }> = [];
    const originalSaveRun = storage.saveRun.bind(storage);
    storage.saveRun = vi.fn(async (record) => {
      savedRuns.push(record);
      await originalSaveRun(record);
    });

    const runtime = createRuntime({
      agent: defineAgent({
        name: "cancel-provider-agent",
        instructions: "Be cancellable.",
        model: "stub-model",
      }),
      provider,
      storage,
    });

    const runPromise = runtime.run({
      sessionId: "cancel-provider-session",
      runId: "stream-a",
      input: "Wait forever.",
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ runId: "stream-a" });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(runtime.getActiveRuns()).toEqual([
      {
        runId: "stream-a",
        sessionId: "cancel-provider-session",
        startedAt: expect.any(String),
      },
    ]);

    expect(runtime.cancel("stream-a", "user stopped stream")).toBe(true);

    const result = await runPromise;
    expect(result.status).toBe("cancelled");
    expect(result.stopReason).toBe("cancelled");
    expect(runtime.getActiveRuns()).toEqual([]);
    expect(savedRuns).toEqual([
      {
        sessionId: "cancel-provider-session",
        status: "cancelled",
      },
    ]);
    expect((await storage.loadMessages("cancel-provider-session")).map((message) => message.role)).toEqual([
      "user",
    ]);
  });

  it("cancels one parallel run without cancelling another", async () => {
    const pending = new Map<
      string,
      { resolve: (response: ModelResponse) => void; reject: (error: unknown) => void }
    >();
    const provider: ModelProvider = {
      generate: vi.fn(
        async (input): Promise<ModelResponse> =>
          new Promise((resolve, reject) => {
            pending.set(input.runId ?? "missing", { resolve, reject });
            input.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    };

    const runtime = createRuntime({
      agent: defineAgent({
        name: "parallel-cancel-agent",
        instructions: "Be cancellable.",
        model: "stub-model",
      }),
      provider,
      storage: new InMemoryStorage(),
    });

    const runA = runtime.run({ sessionId: "session-a", runId: "stream-a", input: "A" });
    const runB = runtime.run({ sessionId: "session-b", runId: "stream-b", input: "B" });

    await vi.waitFor(() => expect(pending.size).toBe(2));
    expect(runtime.cancel("stream-a")).toBe(true);

    pending.get("stream-b")?.resolve({
      message: {
        role: "assistant",
        content: "B done",
        date: new Date("2026-01-01T00:00:00.000Z"),
      },
      stopReason: "stop",
    });

    await expect(runA).resolves.toMatchObject({ status: "cancelled" });
    await expect(runB).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects duplicate active run identifiers", async () => {
    const { provider } = createPendingProvider();
    const runtime = createRuntime({
      agent: defineAgent({
        name: "duplicate-run-agent",
        instructions: "Be cancellable.",
        model: "stub-model",
      }),
      provider,
      storage: new InMemoryStorage(),
    });

    const firstRun = runtime.run({ sessionId: "session-a", runId: "same-stream", input: "A" });
    await vi.waitFor(() => expect(runtime.getActiveRuns()).toHaveLength(1));

    await expect(
      runtime.run({ sessionId: "session-b", runId: "same-stream", input: "B" }),
    ).rejects.toThrow("AgentRuntime run is already active: same-stream");

    runtime.cancel("same-stream");
    await firstRun;
  });

  it("passes run identifiers and signals to tools", async () => {
    const toolCalls: ToolCall[] = [{ id: "call_wait", toolName: "wait", args: {} }];
    const provider: ModelProvider = {
      generate: vi.fn(async (): Promise<ModelResponse> => ({
        message: {
          role: "assistant",
          content: "Calling a tool.",
          date: new Date("2026-01-01T00:00:00.000Z"),
          toolCalls,
        },
        toolCalls,
        stopReason: "tool_calls",
      })),
    };
    let toolSignal: AbortSignal | undefined;
    let toolRunId: string | undefined;
    const tool = defineTool({
      name: "wait",
      description: "Wait until cancelled.",
      async execute(_args, context) {
        toolSignal = context.signal;
        toolRunId = context.runId;
        return await new Promise<never>((_resolve, reject) => {
          context.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });

    const runtime = createRuntime({
      agent: defineAgent({
        name: "cancel-tool-agent",
        instructions: "Use tools.",
        model: "stub-model",
        tools: [tool],
      }),
      provider,
      storage: new InMemoryStorage(),
    });

    const runPromise = runtime.run({
      sessionId: "cancel-tool-session",
      runId: "tool-stream",
      input: "Call wait.",
      maxSteps: 2,
    });

    await vi.waitFor(() => expect(toolSignal).toBeInstanceOf(AbortSignal));
    expect(toolRunId).toBe("tool-stream");
    runtime.cancel("tool-stream");

    await expect(runPromise).resolves.toMatchObject({ status: "cancelled" });
  });
});
