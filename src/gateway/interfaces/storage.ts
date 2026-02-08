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
}
