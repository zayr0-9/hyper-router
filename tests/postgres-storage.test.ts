import { describe, expect, it, vi } from "vitest";

import type { Message } from "../src/core/types.js";
import { PostgresStorage } from "../src/storage/postgres.js";
import type { PostgresQueryable } from "../src/storage/postgres.js";

interface RecordedQuery {
  text: string;
  values?: unknown[] | undefined;
}

function createMessages(): Message[] {
  return [
    {
      role: "system",
      content: "You are helpful.",
      date: new Date("2025-01-01T00:00:00.000Z"),
    },
    {
      role: "user",
      content: "Hello",
      date: new Date("2025-01-01T00:00:01.000Z"),
    },
    {
      role: "assistant",
      content: "I will call a tool.",
      date: new Date("2025-01-01T00:00:02.000Z"),
      toolCalls: [
        {
          id: "call_echo",
          toolName: "echo",
          args: { text: "hello" },
        },
      ],
    },
    {
      role: "tool",
      name: "echo",
      content: JSON.stringify({ ok: true, output: { echoed: "hello" } }),
      toolCallId: "call_echo",
      date: new Date("2025-01-01T00:00:03.000Z"),
    },
  ];
}

function createMockPool(options: {
  selectMessages?: unknown[] | null;
  selectMetadata?: Record<string, unknown> | null;
}) {
  const queries: RecordedQuery[] = [];

  const queryImpl = vi.fn(async (text: string, values?: unknown[]) => {
    queries.push({ text, values });

    if (text.includes("SELECT messages_json")) {
      return {
        rows: options.selectMessages === undefined
          ? []
          : [{ messages_json: options.selectMessages }],
      };
    }

    if (text.includes("SELECT metadata_json")) {
      return {
        rows: options.selectMetadata === undefined
          ? []
          : [{ metadata_json: options.selectMetadata }],
      };
    }

    return { rows: [] };
  });

  const pool: PostgresQueryable = {
    query: queryImpl as PostgresQueryable["query"],
  };

  return { pool, queries };
}

describe("PostgresStorage", () => {
  it("throws when neither pool nor connectionString is provided", () => {
    expect(() => new PostgresStorage()).toThrowError(
      "PostgresStorage: provide { pool } or { connectionString }.",
    );
  });

  it("persists transcript messages without system messages as jsonb payloads", async () => {
    const { pool, queries } = createMockPool({});
    const storage = new PostgresStorage({ pool });

    await storage.saveMessages("session-1", createMessages());

    const upsert = queries.find((query) => query.text.includes("INSERT INTO") && query.text.includes("messages_json"));
    expect(upsert).toBeDefined();
    expect(upsert?.values?.[0]).toBe("session-1");

    const payload = JSON.parse(String(upsert?.values?.[1])) as Array<Record<string, unknown>>;
    expect(payload).toEqual([
      {
        role: "user",
        content: "Hello",
        date: "2025-01-01T00:00:01.000Z",
      },
      {
        role: "assistant",
        content: "I will call a tool.",
        date: "2025-01-01T00:00:02.000Z",
        toolCalls: [
          {
            id: "call_echo",
            toolName: "echo",
            args: { text: "hello" },
          },
        ],
      },
      {
        role: "tool",
        name: "echo",
        content: JSON.stringify({ ok: true, output: { echoed: "hello" } }),
        toolCallId: "call_echo",
        date: "2025-01-01T00:00:03.000Z",
      },
    ]);
  });

  it("restores Date values on load", async () => {
    const { pool } = createMockPool({
      selectMessages: [
        {
          role: "user",
          content: "Hello",
          date: "2025-01-01T00:00:01.000Z",
        },
        {
          role: "assistant",
          content: "Done",
          date: "2025-01-01T00:00:02.000Z",
          toolCalls: [
            {
              id: "call_echo",
              toolName: "echo",
              args: { text: "hello" },
            },
          ],
        },
      ],
    });
    const storage = new PostgresStorage({ pool });

    const loaded = await storage.loadMessages("session-2");

    expect(loaded).toEqual([
      {
        role: "user",
        content: "Hello",
        date: new Date("2025-01-01T00:00:01.000Z"),
      },
      {
        role: "assistant",
        content: "Done",
        date: new Date("2025-01-01T00:00:02.000Z"),
        toolCalls: [
          {
            id: "call_echo",
            toolName: "echo",
            args: { text: "hello" },
          },
        ],
      },
    ]);
    expect(loaded.every((message) => message.date instanceof Date)).toBe(true);
  });

  it("persists metadata and loads it back", async () => {
    const metadata = {
      agentName: "postgres-agent",
      model: "stub-model",
      promptHash: "prompt-hash",
      promptSnapshot: "Be helpful.",
      toolsetHash: "toolset-hash",
      updatedAt: "2025-01-01T00:00:02.000Z",
      custom: {
        tenantId: "tenant-123",
      },
    };

    const { pool, queries } = createMockPool({
      selectMetadata: metadata,
    });
    const storage = new PostgresStorage({ pool });

    await storage.setSessionMetadata("session-3", metadata);
    await expect(storage.getSessionMetadata("session-3")).resolves.toEqual(metadata);

    const upsert = queries.find((query) => query.text.includes("INSERT INTO") && query.text.includes("metadata_json"));
    expect(upsert?.values).toEqual(["session-3", JSON.stringify(metadata)]);
  });

  it("persists run status", async () => {
    const { pool, queries } = createMockPool({});
    const storage = new PostgresStorage({ pool, schema: "agents", tableName: "sessions" });

    await storage.saveRun({ sessionId: "session-4", status: "completed" });

    const upsert = queries.find(
      (query) => query.text.includes("INSERT INTO") && query.text.includes("run_status"),
    );
    expect(upsert?.text).toContain('INSERT INTO "agents"."sessions"');
    expect(upsert?.values).toEqual(["session-4", "completed"]);
  });

  it("creates schema objects only once per instance", async () => {
    const { pool, queries } = createMockPool({
      selectMessages: null,
      selectMetadata: null,
    });
    const storage = new PostgresStorage({ pool });

    await storage.loadMessages("session-a");
    await storage.getSessionMetadata("session-a");
    await storage.saveRun({ sessionId: "session-a", status: "completed" });

    expect(queries.filter((query) => query.text.includes("CREATE SCHEMA IF NOT EXISTS"))).toHaveLength(1);
    expect(queries.filter((query) => query.text.includes("CREATE TABLE IF NOT EXISTS"))).toHaveLength(1);
    expect(queries.filter((query) => query.text.includes("CREATE INDEX IF NOT EXISTS"))).toHaveLength(1);
  });
});
