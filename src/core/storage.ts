import type { Message, RunStatus } from "./types.js";

export interface StandardSessionMetadata {
  agentName?: string;
  model?: string;
  promptHash?: string;
  promptSnapshot?: string;
  toolsetHash?: string;
  updatedAt?: string;
}

export interface SessionMetadata extends StandardSessionMetadata {
  custom?: Record<string, unknown>;
}

export interface RunRecord {
  sessionId: string;
  status: RunStatus;
}

export interface StorageAdapter {
  loadMessages(sessionId: string): Promise<Message[]>;
  saveMessages(sessionId: string, messages: Message[]): Promise<void>;
  saveRun(record: RunRecord): Promise<void>;
  getSessionMetadata?(sessionId: string): Promise<SessionMetadata | null>;
  setSessionMetadata?(sessionId: string, metadata: SessionMetadata): Promise<void>;
}

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
