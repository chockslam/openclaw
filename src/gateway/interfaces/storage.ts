/**
 * StorageAdapter - Interface for persistent data storage.
 *
 * This interface abstracts how the Gateway stores persistent data
 * (e.g., sessions, audit logs). The default implementation uses
 * JSON files on disk. Enterprise implementations can use PostgreSQL
 * for ACID compliance and advanced querying.
 */

export interface SessionEntry {
  id: string;
  userId?: string;
  channelId?: string;
  createdAt: number;
  updatedAt: number;
  displayName?: string;
  label?: string;
  spawnedBy?: string;
  metadata?: Record<string, unknown>;
  messages?: unknown[];
}

export interface SessionFilter {
  userId?: string;
  channelId?: string;
  search?: string;
  label?: string;
  spawnedBy?: string;
  activeSince?: number;
  agentId?: string;
  limit?: number;
  offset?: number;
}

export interface AuditEvent {
  timestamp: number;
  actorId: string;
  action: string;
  resource?: string;
  details?: Record<string, unknown>;
}

export type TranscriptSortOrder = "asc" | "desc";

export type TranscriptPreviewItem = {
  role: "user" | "assistant" | "tool" | "system" | "other";
  text: string;
};

export interface TranscriptLocation {
  sessionId: string;
  /**
   * Legacy compatibility field. Runtime code should prefer sessionId/agentId.
   */
  sessionFile?: string;
  /**
   * Legacy compatibility field. Runtime code should prefer adapter-native scoping.
   */
  storePath?: string;
  agentId?: string;
}

export interface TranscriptAppendInput extends TranscriptLocation {
  event: Record<string, unknown>;
  createIfMissing?: boolean;
}

export interface TranscriptAppendManyInput extends TranscriptLocation {
  events: Record<string, unknown>[];
  createIfMissing?: boolean;
}

export interface TranscriptReadInput extends TranscriptLocation {
  limit?: number;
  order?: TranscriptSortOrder;
}

export interface TranscriptReadEventsInput extends TranscriptLocation {
  limit?: number;
  order?: TranscriptSortOrder;
  fromSeq?: number;
  toSeq?: number;
}

export interface TranscriptPreviewInput extends TranscriptLocation {
  maxItems: number;
  maxChars: number;
}

export interface TranscriptCompactInput extends TranscriptLocation {
  maxMessages: number;
}

export interface TranscriptReplaceInput extends TranscriptLocation {
  events: Record<string, unknown>[];
  createIfMissing?: boolean;
}

export interface TranscriptCloneInput extends TranscriptLocation {
  sourceSessionId: string;
  targetSessionId: string;
  upToSeq?: number;
  overwriteTarget?: boolean;
}

export type TranscriptCompactResult = {
  compacted: boolean;
  kept: number;
  archived?: string;
  reason?: "no-transcript" | "within-limit";
};

export type TranscriptDeleteResult = {
  deleted: boolean;
  archived: string[];
};

export type TranscriptEventRecord = {
  seq: number;
  eventId?: string;
  eventType: string;
  role?: string;
  createdAt: number;
  raw: Record<string, unknown>;
};

export type TranscriptAppendManyResult = {
  count: number;
  firstSeq: number;
  lastSeq: number;
};

export type TranscriptReplaceResult = {
  replaced: boolean;
  inserted: number;
  deleted: number;
  lastSeq: number;
};

export type TranscriptCloneResult = {
  cloned: number;
  firstSeq: number;
  lastSeq: number;
};

export interface SessionLockInput {
  sessionId: string;
  agentId?: string;
  timeoutMs?: number;
}

export interface StorageAdapter {
  /**
   * Save a session entry.
   */
  saveSession(key: string, entry: SessionEntry): Promise<void>;

  /**
   * Load a session entry by key.
   */
  loadSession(key: string): Promise<SessionEntry | null>;

  /**
   * List sessions matching the filter criteria.
   * Returns session entries along with their store keys.
   */
  listSessions(filter: SessionFilter): Promise<{ key: string; entry: SessionEntry }[]>;

  /**
   * Delete a session by key.
   */
  deleteSession(key: string): Promise<void>;

  /**
   * Append a transcript event (JSONL-style record).
   */
  appendTranscriptEvent(params: TranscriptAppendInput): Promise<{ sessionFile?: string }>;

  /**
   * Append multiple transcript events atomically for a session.
   */
  appendTranscriptEvents(params: TranscriptAppendManyInput): Promise<TranscriptAppendManyResult>;

  /**
   * Read raw transcript events with sequence metadata.
   */
  readTranscriptEvents(params: TranscriptReadEventsInput): Promise<TranscriptEventRecord[]>;

  /**
   * Read transcript messages (message payloads only, header/events excluded).
   */
  readTranscriptMessages(params: TranscriptReadInput): Promise<unknown[]>;

  /**
   * Read compact transcript preview items for UI.
   */
  readTranscriptPreview(params: TranscriptPreviewInput): Promise<TranscriptPreviewItem[]>;

  /**
   * Compact transcript by keeping only the newest N messages.
   */
  compactTranscript(params: TranscriptCompactInput): Promise<TranscriptCompactResult>;

  /**
   * Delete/archive transcript data for a session.
   */
  deleteTranscript(params: TranscriptLocation): Promise<TranscriptDeleteResult>;

  /**
   * Replace a transcript stream atomically with a new ordered set of events.
   */
  replaceTranscript(params: TranscriptReplaceInput): Promise<TranscriptReplaceResult>;

  /**
   * Clone transcript events from one session into another.
   */
  cloneTranscript(params: TranscriptCloneInput): Promise<TranscriptCloneResult>;

  /**
   * Acquire a transaction-scoped lock for session operations.
   */
  withSessionLock<T>(params: SessionLockInput, fn: () => Promise<T>): Promise<T>;

  /**
   * Log an audit event.
   */
  logAuditEvent(event: AuditEvent): Promise<void>;

  /**
   * List users (from sessions).
   */
  listUsers(filter: { limit?: number; offset?: number }): Promise<string[]>;

  /**
   * List audit events.
   * (Admin API)
   */
  listAuditEvents(filter: {
    userId?: string;
    action?: string;
    limit?: number;
    offset?: number;
  }): Promise<AuditEvent[]>;

  /**
   * Save a new configuration version.
   * @enterprise
   */
  saveConfig?(yaml: string): Promise<number>;

  /**
   * Get the active or latest configuration.
   * @enterprise
   */
  getConfig?(activeOnly?: boolean): Promise<{
    id: number;
    yaml: string;
    isActive: boolean;
    createdAt: Date;
  } | null>;

  /**
   * Activate a specific configuration version.
   * @enterprise
   */
  activateConfig?(id: number): Promise<void>;

  /**
   * Link a provider identity to a user.
   * @enterprise
   */
  linkUser?(userId: string, provider: string, providerId: string): Promise<void>;

  /**
   * Get user ID by provider identity.
   * @enterprise
   */
  getUserIdByChannel?(provider: string, providerId: string): Promise<string | null>;

  /**
   * Prune sessions older than timestamp.
   * Returns number of deleted sessions.
   * @enterprise
   */
  pruneSessions?(olderThan: number): Promise<number>;

  /**
   * Prune audit events older than timestamp.
   * Returns number of deleted events.
   * @enterprise
   */
  pruneAuditEvents?(olderThan: number): Promise<number>;
}
