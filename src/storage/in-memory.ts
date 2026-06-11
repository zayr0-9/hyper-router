import type { Message } from "../core/types.js";
import type { RunRecord, SessionMetadata, StorageAdapter } from "./types.js";

function cloneValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item, seen)) as T;
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const existing = seen.get(value);
  if (existing) {
    return existing as T;
  }

  const cloned = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
  seen.set(value, cloned);

  for (const key of Reflect.ownKeys(value)) {
    cloned[key] = cloneValue((value as Record<PropertyKey, unknown>)[key], seen);
  }

  return cloned as T;
}

function cloneMessage(message: Message): Message {
  return cloneValue(message);
}

function cloneMetadata(metadata: SessionMetadata): SessionMetadata {
  return cloneValue(metadata);
}

export class InMemoryStorage implements StorageAdapter {
  private readonly messages = new Map<string, Message[]>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly sessionMetadata = new Map<string, SessionMetadata>();

  async loadMessages(sessionId: string): Promise<Message[]> {
    return (this.messages.get(sessionId) ?? []).map(cloneMessage);
  }

  async saveMessages(sessionId: string, messages: Message[]): Promise<void> {
    this.messages.set(
      sessionId,
      messages.filter((message) => message.role !== "system").map(cloneMessage),
    );
  }

  async saveRun(record: RunRecord): Promise<void> {
    this.runs.set(record.sessionId, cloneValue(record));
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    const metadata = this.sessionMetadata.get(sessionId);
    return metadata ? cloneMetadata(metadata) : null;
  }

  async setSessionMetadata(sessionId: string, metadata: SessionMetadata): Promise<void> {
    this.sessionMetadata.set(sessionId, cloneMetadata(metadata));
  }
}
