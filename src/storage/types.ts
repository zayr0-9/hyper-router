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
  runId?: string;
}

export interface StorageAdapter {
  loadMessages(sessionId: string): Promise<import("../core/types.js").Message[]>;
  saveMessages(sessionId: string, messages: import("../core/types.js").Message[]): Promise<void>;
  saveRun(record: RunRecord): Promise<void>;
  getSessionMetadata?(sessionId: string): Promise<SessionMetadata | null>;
  setSessionMetadata?(sessionId: string, metadata: SessionMetadata): Promise<void>;
}

export interface SessionState {
  revision: number;
  messageCount: number;
  metadata?: SessionMetadata | null;
}

export interface BeginRunRecord {
  runId: string;
  sessionId: string;
  baseRevision?: number | undefined;
  baseMessageCount?: number | undefined;
  metadata?: Record<string, unknown>;
}

export interface AppendMessagesRecord {
  runId?: string;
  expectedRevision?: number | undefined;
  expectedMessageCount?: number | undefined;
  messages: import("../core/types.js").Message[];
}

export interface AppendMessagesResult {
  sessionId: string;
  revision?: number;
  messageCount?: number;
  conflict?: boolean;
  conflictReason?: string;
}

export interface CommitRunRecord {
  runId: string;
  sessionId: string;
  status: import("../core/types.js").RunStatus;
  baseRevision?: number | undefined;
  baseMessageCount?: number | undefined;
  previousMessages?: import("../core/types.js").Message[];
  newMessages: import("../core/types.js").Message[];
  fullMessages: import("../core/types.js").Message[];
  metadata?: SessionMetadata | null;
}

export interface CommitRunResult {
  sessionId: string;
  revision?: number;
  messageCount?: number;
  conflict?: boolean;
  conflictReason?: string;
}

export interface StorageAdapterV2 extends StorageAdapter {
  getSessionState?(sessionId: string): Promise<SessionState>;
  beginRun?(record: BeginRunRecord): Promise<void>;
  appendMessages?(
    sessionId: string,
    record: AppendMessagesRecord,
  ): Promise<AppendMessagesResult>;
  commitRun?(record: CommitRunRecord): Promise<CommitRunResult>;
}
