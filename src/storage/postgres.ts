import { Pool } from "pg";

import type { Message } from "../core/types.js";
import type { RunRecord, SessionMetadata, StorageAdapter } from "./types.js";

interface PostgresStorageOptions {
  connectionString?: string;
  pool?: PostgresQueryable;
  schema?: string;
  tableName?: string;
}

interface PostgresQueryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: QueryResultRow[] }>;
}

interface QueryResultRow {
  [column: string]: unknown;
}

interface SerializedMessage {
  role: Message["role"];
  content: string;
  name?: string;
  date: string;
  toolCallId?: string;
  toolCalls?: Message["toolCalls"];
}

interface SessionRow extends QueryResultRow {
  messages_json: SerializedMessage[] | null;
  metadata_json: SessionMetadata | null;
}

export class PostgresStorage implements StorageAdapter {
  private readonly db: PostgresQueryable;
  private readonly schema: string;
  private readonly tableName: string;
  private readonly ownsPool: boolean;
  private schemaReady?: Promise<void>;
  private readonly poolToClose?: Pool;

  constructor(options: PostgresStorageOptions = {}) {
    this.schema = options.schema ?? "public";
    this.tableName = options.tableName ?? "agent_sessions";

    if (options.pool) {
      this.db = options.pool;
      this.ownsPool = false;
      return;
    }

    if (!options.connectionString) {
      throw new Error(
        "PostgresStorage: provide { pool } or { connectionString }.",
      );
    }

    const pool = new Pool({
      connectionString: options.connectionString,
    });

    this.db = pool;
    this.poolToClose = pool;
    this.ownsPool = true;
  }

  async loadMessages(sessionId: string): Promise<Message[]> {
    await this.ensureSchema();

    const result = await this.db.query(
      `SELECT messages_json FROM ${this.qualifiedTableName()} WHERE session_id = $1`,
      [sessionId],
    );

    const row = result.rows[0] as SessionRow | undefined;
    if (!row?.messages_json) {
      return [];
    }

    return row.messages_json.map((message) => this.deserializeMessage(message));
  }

  async saveMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.ensureSchema();

    const serialized = messages
      .filter((message) => message.role !== "system")
      .map((message) => this.serializeMessage(message));

    await this.db.query(
      `INSERT INTO ${this.qualifiedTableName()} (session_id, messages_json)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (session_id)
       DO UPDATE SET messages_json = EXCLUDED.messages_json`,
      [sessionId, JSON.stringify(serialized)],
    );
  }

  async saveRun(record: RunRecord): Promise<void> {
    await this.ensureSchema();

    await this.db.query(
      `INSERT INTO ${this.qualifiedTableName()} (session_id, run_status)
       VALUES ($1, $2)
       ON CONFLICT (session_id)
       DO UPDATE SET run_status = EXCLUDED.run_status`,
      [record.sessionId, record.status],
    );
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    await this.ensureSchema();

    const result = await this.db.query(
      `SELECT metadata_json FROM ${this.qualifiedTableName()} WHERE session_id = $1`,
      [sessionId],
    );

    return (result.rows[0] as SessionRow | undefined)?.metadata_json ?? null;
  }

  async setSessionMetadata(sessionId: string, metadata: SessionMetadata): Promise<void> {
    await this.ensureSchema();

    await this.db.query(
      `INSERT INTO ${this.qualifiedTableName()} (session_id, metadata_json)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (session_id)
       DO UPDATE SET metadata_json = EXCLUDED.metadata_json`,
      [sessionId, JSON.stringify(metadata)],
    );
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.poolToClose?.end();
    }
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

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.initializeSchema();
    }

    await this.schemaReady;
  }

  private async initializeSchema(): Promise<void> {
    await this.db.query(`CREATE SCHEMA IF NOT EXISTS ${this.escapeIdentifier(this.schema)}`);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.qualifiedTableName()} (
        session_id TEXT PRIMARY KEY,
        messages_json JSONB,
        run_status TEXT,
        metadata_json JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS ${this.escapeIdentifier(`${this.tableName}_updated_at_idx`)}
      ON ${this.qualifiedTableName()} (updated_at DESC)
    `);
  }

  private qualifiedTableName(): string {
    return `${this.escapeIdentifier(this.schema)}.${this.escapeIdentifier(this.tableName)}`;
  }

  private escapeIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
  }
}

export type { PostgresQueryable, PostgresStorageOptions, SerializedMessage as PostgresSerializedMessage };
