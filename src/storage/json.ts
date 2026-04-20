import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Message, RunStatus } from "../core/types.js";
import type { RunRecord, SessionMetadata, StorageAdapter } from "./types.js";

interface JsonStorageOptions {
  filePath: string;
}

interface SerializedMessage {
  role: Message["role"];
  content: string;
  name?: string;
  date: string;
  toolCallId?: string;
  toolCalls?: Message["toolCalls"];
}

interface JsonStorageSessionRecord {
  messages?: SerializedMessage[];
  run?: {
    sessionId: string;
    status: RunStatus;
  };
  metadata?: SessionMetadata;
}

interface JsonStorageFileData {
  version: 1;
  sessions: Record<string, JsonStorageSessionRecord>;
}

const EMPTY_STORAGE: JsonStorageFileData = {
  version: 1,
  sessions: {},
};

export class JsonStorage implements StorageAdapter {
  private readonly filePath: string;

  constructor(options: JsonStorageOptions) {
    this.filePath = options.filePath;
  }

  async loadMessages(sessionId: string): Promise<Message[]> {
    const data = await this.readData();
    return (data.sessions[sessionId]?.messages ?? []).map((message) => this.deserializeMessage(message));
  }

  async saveMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.updateData((data) => {
      const session = this.getOrCreateSession(data, sessionId);
      session.messages = messages
        .filter((message) => message.role !== "system")
        .map((message) => this.serializeMessage(message));
    });
  }

  async saveRun(record: RunRecord): Promise<void> {
    await this.updateData((data) => {
      const session = this.getOrCreateSession(data, record.sessionId);
      session.run = {
        sessionId: record.sessionId,
        status: record.status,
      };
    });
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    const data = await this.readData();
    return data.sessions[sessionId]?.metadata ?? null;
  }

  async setSessionMetadata(sessionId: string, metadata: SessionMetadata): Promise<void> {
    await this.updateData((data) => {
      const session = this.getOrCreateSession(data, sessionId);
      session.metadata = metadata;
    });
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

  private async readData(): Promise<JsonStorageFileData> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<JsonStorageFileData>;

      return {
        version: 1,
        sessions: parsed.sessions ?? {},
      };
    } catch (error) {
      if (this.isMissingFileError(error)) {
        return {
          version: 1,
          sessions: {},
        };
      }

      throw error;
    }
  }

  private async updateData(mutator: (data: JsonStorageFileData) => void): Promise<void> {
    const data = await this.readData();
    mutator(data);
    await this.writeData(data);
  }

  private async writeData(data: JsonStorageFileData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const tempFilePath = `${this.filePath}.tmp`;
    await writeFile(tempFilePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tempFilePath, this.filePath);
  }

  private getOrCreateSession(
    data: JsonStorageFileData,
    sessionId: string,
  ): JsonStorageSessionRecord {
    const existing = data.sessions[sessionId];
    if (existing) {
      return existing;
    }

    const session: JsonStorageSessionRecord = {};
    data.sessions[sessionId] = session;
    return session;
  }

  private isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
}

export { EMPTY_STORAGE as EMPTY_JSON_STORAGE };
