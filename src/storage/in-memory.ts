import type { Message } from "../core/types.js";
import type { RunRecord, SessionMetadata, StorageAdapter } from "./types.js";

export class InMemoryStorage implements StorageAdapter {
  private readonly messages = new Map<string, Message[]>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly sessionMetadata = new Map<string, SessionMetadata>();

  async loadMessages(sessionId: string): Promise<Message[]> {
    return this.messages.get(sessionId) ?? [];
  }

  async saveMessages(sessionId: string, messages: Message[]): Promise<void> {
    this.messages.set(
      sessionId,
      messages.filter((message) => message.role !== "system"),
    );
  }

  async saveRun(record: RunRecord): Promise<void> {
    this.runs.set(record.sessionId, record);
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    return this.sessionMetadata.get(sessionId) ?? null;
  }

  async setSessionMetadata(sessionId: string, metadata: SessionMetadata): Promise<void> {
    this.sessionMetadata.set(sessionId, metadata);
  }
}
