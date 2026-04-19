import type { Message, RunStatus } from "./types.js";

export interface RunRecord {
  sessionId: string;
  status: RunStatus;
  messages: Message[];
}

export interface StorageAdapter {
  loadMessages(sessionId: string): Promise<Message[]>;
  saveMessages(sessionId: string, messages: Message[]): Promise<void>;
  saveRun(record: RunRecord): Promise<void>;
}

export class InMemoryStorage implements StorageAdapter {
  private readonly messages = new Map<string, Message[]>();
  private readonly runs = new Map<string, RunRecord>();

  async loadMessages(sessionId: string): Promise<Message[]> {
    return this.messages.get(sessionId) ?? [];
  }

  async saveMessages(sessionId: string, messages: Message[]): Promise<void> {
    this.messages.set(sessionId, messages);
  }

  async saveRun(record: RunRecord): Promise<void> {
    this.runs.set(record.sessionId, record);
  }
}
