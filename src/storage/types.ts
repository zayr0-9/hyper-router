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
  status: import("../core/types.js").RunStatus;
}

export interface StorageAdapter {
  loadMessages(sessionId: string): Promise<import("../core/types.js").Message[]>;
  saveMessages(sessionId: string, messages: import("../core/types.js").Message[]): Promise<void>;
  saveRun(record: RunRecord): Promise<void>;
  getSessionMetadata?(sessionId: string): Promise<SessionMetadata | null>;
  setSessionMetadata?(sessionId: string, metadata: SessionMetadata): Promise<void>;
}
