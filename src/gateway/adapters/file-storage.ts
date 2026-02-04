/**
 * FileStorageAdapter - Default file-based implementation of StorageAdapter.
 *
 * This adapter stores sessions as JSON files on disk. It is suitable for
 * single-node deployments. For multi-node HA deployments, use the
 * PostgreSQL adapter from openclaw-enterprise.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AuditEvent,
  SessionEntry,
  SessionFilter,
  StorageAdapter,
} from "../interfaces/storage.js";

export class FileStorageAdapter implements StorageAdapter {
  private sessionsDir: string;

  constructor(baseDir?: string) {
    this.sessionsDir = baseDir ?? join(homedir(), ".openclaw", "sessions");
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  private getFilePath(key: string): string {
    // Sanitize key to prevent path traversal
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.sessionsDir, `${safeKey}.json`);
  }

  async saveSession(key: string, entry: SessionEntry): Promise<void> {
    const filePath = this.getFilePath(key);
    writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf-8");
  }

  async loadSession(key: string): Promise<SessionEntry | null> {
    const filePath = this.getFilePath(key);
    if (!existsSync(filePath)) {
      return null;
    }
    try {
      const content = readFileSync(filePath, "utf-8");
      return JSON.parse(content) as SessionEntry;
    } catch {
      return null;
    }
  }

  async listSessions(filter: SessionFilter): Promise<SessionEntry[]> {
    const files = readdirSync(this.sessionsDir).filter((f) => f.endsWith(".json"));
    const sessions: SessionEntry[] = [];

    for (const file of files) {
      try {
        const content = readFileSync(join(this.sessionsDir, file), "utf-8");
        const session = JSON.parse(content) as SessionEntry;

        // Apply filters
        if (filter.userId && session.userId !== filter.userId) continue;
        if (filter.channelId && session.channelId !== filter.channelId) continue;

        sessions.push(session);
      } catch {
        // Skip invalid files
      }
    }

    // Apply pagination
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? sessions.length;
    return sessions.slice(offset, offset + limit);
  }

  async deleteSession(key: string): Promise<void> {
    const filePath = this.getFilePath(key);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  async logAuditEvent(event: AuditEvent): Promise<void> {
    // No-op for file storage adapter in OSS
  }

  async listUsers(filter: { limit?: number; offset?: number }): Promise<string[]> {
    // File storage doesn't index users efficiently, return empty
    return [];
  }

  async listAuditEvents(filter: {
    userId?: string;
    action?: string;
    limit?: number;
    offset?: number;
  }): Promise<AuditEvent[]> {
    // File storage doesn't store audit logs
    return [];
  }
}
