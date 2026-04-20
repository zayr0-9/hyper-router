import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import initSqlJs from "sql.js";

import type { Message } from "../core/types.js";
import type { RunRecord, SessionMetadata, StorageAdapter } from "./types.js";

interface SqliteStorageOptions {
  filePath: string;
  locateFile?: (file: string) => string;
}

interface SerializedMessage {
  role: Message["role"];
  content: string;
  name?: string;
  date: string;
  toolCallId?: string;
  toolCalls?: Message["toolCalls"];
}

let sqlJsPromise: ReturnType<typeof initSqlJs> | undefined;

export class SqliteStorage implements StorageAdapter {
  private readonly filePath: string;
  private readonly locateFile?: (file: string) => string;

  constructor(options: SqliteStorageOptions) {
    this.filePath = options.filePath;
    if (options.locateFile) {
      this.locateFile = options.locateFile;
    }
  }

  async loadMessages(sessionId: string): Promise<Message[]> {
    return this.withDatabase(async (db) => {
      const row = this.getOptionalRow<{ messages_json: string | null }>(
        db,
        "SELECT messages_json FROM sessions WHERE session_id = ?",
        [sessionId],
      );

      if (!row?.messages_json) {
        return [];
      }

      return (JSON.parse(row.messages_json) as SerializedMessage[]).map((message) =>
        this.deserializeMessage(message),
      );
    });
  }

  async saveMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.withDatabase(async (db) => {
      const serialized = JSON.stringify(
        messages
          .filter((message) => message.role !== "system")
          .map((message) => this.serializeMessage(message)),
      );

      db.run(
        `INSERT INTO sessions (session_id, messages_json)
         VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET messages_json = excluded.messages_json`,
        [sessionId, serialized],
      );
    }, { persist: true });
  }

  async saveRun(record: RunRecord): Promise<void> {
    await this.withDatabase(async (db) => {
      db.run(
        `INSERT INTO sessions (session_id, run_status)
         VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET run_status = excluded.run_status`,
        [record.sessionId, record.status],
      );
    }, { persist: true });
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    return this.withDatabase(async (db) => {
      const row = this.getOptionalRow<{ metadata_json: string | null }>(
        db,
        "SELECT metadata_json FROM sessions WHERE session_id = ?",
        [sessionId],
      );

      if (!row?.metadata_json) {
        return null;
      }

      return JSON.parse(row.metadata_json) as SessionMetadata;
    });
  }

  async setSessionMetadata(sessionId: string, metadata: SessionMetadata): Promise<void> {
    await this.withDatabase(async (db) => {
      db.run(
        `INSERT INTO sessions (session_id, metadata_json)
         VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET metadata_json = excluded.metadata_json`,
        [sessionId, JSON.stringify(metadata)],
      );
    }, { persist: true });
  }

  private serializeMessage(message: Message): SerializedMessage {
    return {
      role: message.role,
      content: message.content,
      date: message.date.toISOString(),
      ...(message.name ? { name: message.name } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    };
  }

  private deserializeMessage(message: SerializedMessage): Message {
    return {
      role: message.role,
      content: message.content,
      date: new Date(message.date),
      ...(message.name ? { name: message.name } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    };
  }

  private async withDatabase<T>(
    action: (db: import("sql.js").SqlJsDatabase) => Promise<T> | T,
    options: { persist?: boolean } = {},
  ): Promise<T> {
    const SQL = await this.getSqlJs();
    const existingBytes = await this.readExistingDatabaseBytes();
    const db = existingBytes ? new SQL.Database(existingBytes) : new SQL.Database();

    this.ensureSchema(db);

    try {
      const result = await action(db);

      if (options.persist) {
        await this.persistDatabase(db);
      }

      return result;
    } finally {
      // sql.js Database does not expose close() in the minimal types we use here.
      // Exporting and dropping the reference is sufficient for this adapter's use.
    }
  }

  private async getSqlJs() {
    sqlJsPromise ??= initSqlJs(
      this.locateFile
        ? {
            locateFile: this.locateFile,
          }
        : undefined,
    );

    return sqlJsPromise;
  }

  private ensureSchema(db: import("sql.js").SqlJsDatabase): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        messages_json TEXT,
        run_status TEXT,
        metadata_json TEXT
      )
    `);
  }

  private getOptionalRow<TRow extends Record<string, unknown>>(
    db: import("sql.js").SqlJsDatabase,
    sql: string,
    params: unknown[],
  ): TRow | null {
    const statement = db.prepare(sql, params);

    try {
      if (!statement.step()) {
        return null;
      }

      return statement.getAsObject() as TRow;
    } finally {
      statement.free();
    }
  }

  private async readExistingDatabaseBytes(): Promise<Uint8Array | null> {
    try {
      const file = await readFile(this.filePath);
      return new Uint8Array(file);
    } catch (error) {
      if (this.isMissingFileError(error)) {
        return null;
      }

      throw error;
    }
  }

  private async persistDatabase(db: import("sql.js").SqlJsDatabase): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, Buffer.from(db.export()));
  }

  private isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
}
