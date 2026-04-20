import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { Message } from "../src/core/types.js";
import { SqliteStorage } from "../src/storage/sqlite.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createStorage() {
  const dir = await mkdtemp(join(tmpdir(), "hyper-router-sqlite-storage-"));
  tempDirs.push(dir);

  const filePath = join(dir, "storage.sqlite");
  return {
    filePath,
    storage: new SqliteStorage({ filePath }),
  };
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

describe("SqliteStorage", () => {
  it("returns empty state when the database file does not exist", async () => {
    const { storage } = await createStorage();

    await expect(storage.loadMessages("missing-session")).resolves.toEqual([]);
    await expect(storage.getSessionMetadata("missing-session")).resolves.toBeNull();
  });

  it("persists transcript messages without system messages and restores Date values", async () => {
    const { storage } = await createStorage();

    await storage.saveMessages("session-1", createMessages());

    const loaded = await storage.loadMessages("session-1");
    expect(loaded).toEqual([
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
    ]);

    expect(loaded.every((message) => message.date instanceof Date)).toBe(true);
  });

  it("persists run records and metadata alongside transcript data", async () => {
    const { storage } = await createStorage();

    await storage.saveMessages("session-2", [
      {
        role: "user",
        content: "Hi",
        date: new Date("2025-01-01T00:00:01.000Z"),
      },
    ]);
    await storage.saveRun({
      sessionId: "session-2",
      status: "completed",
    });
    await storage.setSessionMetadata("session-2", {
      agentName: "sqlite-agent",
      model: "stub-model",
      promptHash: "prompt-hash",
      promptSnapshot: "Be helpful.",
      toolsetHash: "toolset-hash",
      updatedAt: "2025-01-01T00:00:02.000Z",
      custom: {
        tenantId: "tenant-123",
      },
    });

    const metadata = await storage.getSessionMetadata("session-2");
    expect(metadata).toEqual({
      agentName: "sqlite-agent",
      model: "stub-model",
      promptHash: "prompt-hash",
      promptSnapshot: "Be helpful.",
      toolsetHash: "toolset-hash",
      updatedAt: "2025-01-01T00:00:02.000Z",
      custom: {
        tenantId: "tenant-123",
      },
    });

    await expect(storage.loadMessages("session-2")).resolves.toEqual([
      {
        role: "user",
        content: "Hi",
        date: new Date("2025-01-01T00:00:01.000Z"),
      },
    ]);
  });

  it("can be reused across instances by pointing at the same file", async () => {
    const { filePath, storage } = await createStorage();

    await storage.saveMessages("session-3", [
      {
        role: "user",
        content: "Persist me",
        date: new Date("2025-01-01T00:00:01.000Z"),
      },
    ]);
    await storage.setSessionMetadata("session-3", {
      custom: {
        source: "instance-a",
      },
    });

    const secondStorage = new SqliteStorage({ filePath });

    await expect(secondStorage.loadMessages("session-3")).resolves.toEqual([
      {
        role: "user",
        content: "Persist me",
        date: new Date("2025-01-01T00:00:01.000Z"),
      },
    ]);
    await expect(secondStorage.getSessionMetadata("session-3")).resolves.toEqual({
      custom: {
        source: "instance-a",
      },
    });
  });
});
