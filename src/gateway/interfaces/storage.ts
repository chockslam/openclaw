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
  metadata?: Record<string, unknown>;
  messages?: unknown[];
}

export interface SessionFilter {
  userId?: string;
  channelId?: string;
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
   */
  listSessions(filter: SessionFilter): Promise<SessionEntry[]>;

  /**
   * Delete a session by key.
   */
  deleteSession(key: string): Promise<void>;

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
}
