import type {
  AuditEvent,
  SessionEntry,
  SessionFilter,
  SessionLockInput,
  StorageAdapter,
  TranscriptAppendInput,
  TranscriptAppendManyInput,
  TranscriptAppendManyResult,
  TranscriptCloneInput,
  TranscriptCloneResult,
  TranscriptCompactInput,
  TranscriptCompactResult,
  TranscriptDeleteResult,
  TranscriptEventRecord,
  TranscriptLocation,
  TranscriptPreviewInput,
  TranscriptPreviewItem,
  TranscriptReadEventsInput,
  TranscriptReadInput,
  TranscriptReplaceInput,
  TranscriptReplaceResult,
  TranscriptSortOrder,
} from "./interfaces/storage.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function roleFromEvent(event: Record<string, unknown>): TranscriptEventRecord["role"] {
  const message = event.message;
  if (!message || typeof message !== "object") {
    return "other";
  }
  const role = (message as { role?: unknown }).role;
  if (role === "user" || role === "assistant" || role === "tool" || role === "system") {
    return role;
  }
  return "other";
}

function eventTypeFromEvent(event: Record<string, unknown>): string {
  const eventType = event.type;
  return typeof eventType === "string" && eventType.trim() ? eventType : "message";
}

function extractPreviewText(raw: Record<string, unknown>, maxChars: number): TranscriptPreviewItem {
  const message = raw.message;
  if (message && typeof message === "object") {
    const roleRaw = (message as { role?: unknown }).role;
    const role =
      roleRaw === "user" || roleRaw === "assistant" || roleRaw === "tool" || roleRaw === "system"
        ? roleRaw
        : "other";
    const contentRaw = (message as { content?: unknown }).content;
    const text =
      typeof contentRaw === "string"
        ? contentRaw
        : typeof (message as { text?: unknown }).text === "string"
          ? ((message as { text?: unknown }).text as string)
          : JSON.stringify(message);
    return { role, text: text.slice(0, maxChars) };
  }
  return { role: "other", text: JSON.stringify(raw).slice(0, maxChars) };
}

function sortEvents(
  events: TranscriptEventRecord[],
  order: TranscriptSortOrder,
): TranscriptEventRecord[] {
  const next = [...events].sort((a, b) => a.seq - b.seq);
  return order === "desc" ? next.reverse() : next;
}

export class MockStorageAdapter implements StorageAdapter {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly transcripts = new Map<string, TranscriptEventRecord[]>();
  private readonly auditEvents: AuditEvent[] = [];
  private readonly sessionLocks = new Map<string, Promise<void>>();

  async saveSession(key: string, entry: SessionEntry): Promise<void> {
    this.sessions.set(key, clone(entry));
  }

  async loadSession(key: string): Promise<SessionEntry | null> {
    const entry = this.sessions.get(key);
    return entry ? clone(entry) : null;
  }

  async listSessions(filter: SessionFilter): Promise<{ key: string; entry: SessionEntry }[]> {
    const all = Array.from(this.sessions.entries()).map(([key, entry]) => ({
      key,
      entry: clone(entry),
    }));
    const filtered = all.filter(({ key, entry }) => {
      if (filter.userId && entry.userId !== filter.userId) {
        return false;
      }
      if (filter.channelId && entry.channelId !== filter.channelId) {
        return false;
      }
      if (filter.activeSince && entry.updatedAt < filter.activeSince) {
        return false;
      }
      if (filter.search) {
        const haystack = `${key} ${entry.displayName ?? ""} ${entry.label ?? ""}`.toLowerCase();
        if (!haystack.includes(filter.search.toLowerCase())) {
          return false;
        }
      }
      if (filter.label && entry.label !== filter.label) {
        return false;
      }
      if (filter.spawnedBy && entry.spawnedBy !== filter.spawnedBy) {
        return false;
      }
      return true;
    });
    const offset = Math.max(0, filter.offset ?? 0);
    const limit = filter.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
  }

  async deleteSession(key: string): Promise<void> {
    this.sessions.delete(key);
  }

  async appendTranscriptEvent(params: TranscriptAppendInput): Promise<{ sessionFile?: string }> {
    await this.appendTranscriptEvents({
      sessionId: params.sessionId,
      agentId: params.agentId,
      sessionFile: params.sessionFile,
      storePath: params.storePath,
      events: [params.event],
      createIfMissing: params.createIfMissing,
    });
    return { sessionFile: `session://${params.sessionId}` };
  }

  async appendTranscriptEvents(
    params: TranscriptAppendManyInput,
  ): Promise<TranscriptAppendManyResult> {
    const current = clone(this.transcripts.get(params.sessionId) ?? []);
    const lastCurrent = current[current.length - 1];
    let seq = lastCurrent?.seq ?? 0;
    const firstSeq = seq + 1;
    for (const event of params.events) {
      seq += 1;
      current.push({
        seq,
        eventType: eventTypeFromEvent(event),
        role: roleFromEvent(event),
        createdAt: Date.now(),
        raw: clone(event),
      });
    }
    this.transcripts.set(params.sessionId, current);
    return {
      count: params.events.length,
      firstSeq: params.events.length > 0 ? firstSeq : 0,
      lastSeq: params.events.length > 0 ? seq : 0,
    };
  }

  async readTranscriptEvents(params: TranscriptReadEventsInput): Promise<TranscriptEventRecord[]> {
    const base = clone(this.transcripts.get(params.sessionId) ?? []);
    const fromSeq = params.fromSeq ?? Number.NEGATIVE_INFINITY;
    const toSeq = params.toSeq ?? Number.POSITIVE_INFINITY;
    const ranged = base.filter((event) => event.seq >= fromSeq && event.seq <= toSeq);
    const ordered = sortEvents(ranged, params.order ?? "asc");
    const limit = params.limit;
    return typeof limit === "number" && limit >= 0 ? ordered.slice(0, limit) : ordered;
  }

  async readTranscriptMessages(params: TranscriptReadInput): Promise<unknown[]> {
    const events = await this.readTranscriptEvents({
      sessionId: params.sessionId,
      agentId: params.agentId,
      sessionFile: params.sessionFile,
      storePath: params.storePath,
      limit: params.limit,
      order: params.order,
    });
    return events.map((event) => {
      const message = event.raw.message;
      return message && typeof message === "object" ? clone(message) : clone(event.raw);
    });
  }

  async readTranscriptPreview(params: TranscriptPreviewInput): Promise<TranscriptPreviewItem[]> {
    const events = await this.readTranscriptEvents({
      sessionId: params.sessionId,
      agentId: params.agentId,
      sessionFile: params.sessionFile,
      storePath: params.storePath,
      order: "desc",
      limit: params.maxItems,
    });
    return events
      .map((event) => extractPreviewText(event.raw, params.maxChars))
      .slice(0, params.maxItems);
  }

  async compactTranscript(params: TranscriptCompactInput): Promise<TranscriptCompactResult> {
    const events = this.transcripts.get(params.sessionId) ?? [];
    if (events.length <= params.maxMessages) {
      return { compacted: false, kept: events.length, reason: "within-limit" };
    }
    const keptEvents = events.slice(Math.max(0, events.length - params.maxMessages));
    this.transcripts.set(
      params.sessionId,
      keptEvents.map((event, index) => ({
        ...event,
        seq: index + 1,
      })),
    );
    return {
      compacted: true,
      kept: keptEvents.length,
      archived: `session://${params.sessionId}#archived`,
    };
  }

  async deleteTranscript(params: TranscriptLocation): Promise<TranscriptDeleteResult> {
    const existed = this.transcripts.delete(params.sessionId);
    return {
      deleted: existed,
      archived: existed ? [`session://${params.sessionId}#deleted`] : [],
    };
  }

  async replaceTranscript(params: TranscriptReplaceInput): Promise<TranscriptReplaceResult> {
    const prior = this.transcripts.get(params.sessionId) ?? [];
    const next: TranscriptEventRecord[] = params.events.map((event, index) => ({
      seq: index + 1,
      eventType: eventTypeFromEvent(event),
      role: roleFromEvent(event),
      createdAt: Date.now(),
      raw: clone(event),
    }));
    this.transcripts.set(params.sessionId, next);
    return {
      replaced: true,
      inserted: next.length,
      deleted: prior.length,
      lastSeq: next[next.length - 1]?.seq ?? 0,
    };
  }

  async cloneTranscript(params: TranscriptCloneInput): Promise<TranscriptCloneResult> {
    const source = this.transcripts.get(params.sourceSessionId) ?? [];
    const limit = params.upToSeq ?? Number.POSITIVE_INFINITY;
    const selected = source.filter((event) => event.seq <= limit);
    const next = selected.map((event, index) => ({
      ...clone(event),
      seq: index + 1,
    }));
    this.transcripts.set(params.targetSessionId, next);
    return {
      cloned: next.length,
      firstSeq: next.length > 0 ? 1 : 0,
      lastSeq: next[next.length - 1]?.seq ?? 0,
    };
  }

  async withSessionLock<T>(params: SessionLockInput, fn: () => Promise<T>): Promise<T> {
    const key = params.sessionId;
    const previous = this.sessionLocks.get(key) ?? Promise.resolve();
    let unlock: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      unlock = () => resolve();
    });
    this.sessionLocks.set(key, current);
    await previous;
    try {
      return await fn();
    } finally {
      unlock?.();
      if (this.sessionLocks.get(key) === current) {
        this.sessionLocks.delete(key);
      }
    }
  }

  async logAuditEvent(event: AuditEvent): Promise<void> {
    this.auditEvents.push(clone(event));
  }

  async listUsers(filter: { limit?: number; offset?: number }): Promise<string[]> {
    const users = Array.from(
      new Set(
        Array.from(this.sessions.values())
          .map((session) => session.userId)
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      ),
    );
    const offset = Math.max(0, filter.offset ?? 0);
    const limit = filter.limit ?? users.length;
    return users.slice(offset, offset + limit);
  }

  async listAuditEvents(filter: {
    userId?: string;
    action?: string;
    limit?: number;
    offset?: number;
  }): Promise<AuditEvent[]> {
    const filtered = this.auditEvents.filter((event) => {
      if (filter.userId && event.actorId !== filter.userId) {
        return false;
      }
      if (filter.action && event.action !== filter.action) {
        return false;
      }
      return true;
    });
    const offset = Math.max(0, filter.offset ?? 0);
    const limit = filter.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit).map((event) => clone(event));
  }
}

export function createMockStorageAdapter(): StorageAdapter {
  return new MockStorageAdapter();
}
