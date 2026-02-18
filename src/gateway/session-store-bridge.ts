/**
 * Session Store Bridge
 *
 * Bridges the synchronous session store API with the async StorageAdapter interface.
 * This implementation strictly delegates to a provided StorageAdapter.
 *
 * Legacy file-based storage has been removed.
 */

import type { SessionEntry } from "../config/sessions/types.js";
import type {
  StorageAdapter,
  SessionEntry as AdapterSessionEntry,
  TranscriptAppendInput,
  TranscriptAppendManyInput,
  TranscriptAppendManyResult,
  TranscriptCompactInput,
  TranscriptCompactResult,
  TranscriptCloneInput,
  TranscriptCloneResult,
  TranscriptDeleteResult,
  TranscriptLocation,
  TranscriptPreviewInput,
  TranscriptPreviewItem,
  TranscriptReadEventsInput,
  TranscriptEventRecord,
  TranscriptReadInput,
  TranscriptReplaceInput,
  TranscriptReplaceResult,
  SessionLockInput,
} from "./interfaces/storage.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";

/**
 * A session store bridge that delegates to a StorageAdapter.
 * It maintains an in-memory cache for synchronous read compatibility.
 */
export class SessionStoreBridge {
  private adapter: StorageAdapter;
  private cache: Map<string, Record<string, SessionEntry>> = new Map();
  private globalSnapshot: Record<string, SessionEntry> | null = null;
  private transcriptSummaries: Map<
    string,
    { firstUserMessage: string | null; lastMessagePreview: string | null }
  > = new Map();
  private transcriptSummaryLoads: Map<string, Promise<void>> = new Map();
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  constructor(adapter: StorageAdapter) {
    if (!adapter) {
      throw new Error("SessionStoreBridge requires a StorageAdapter");
    }
    this.adapter = adapter;
    // Start background flush
    this.flushInterval = setInterval(() => this.flushPending(), 5000);
  }

  get hasAdapter(): boolean {
    return true;
  }

  /**
   * Load session store - synchronous for compatibility.
   * Returns cached data (may be stale until next sync).
   */
  loadSessionStore(storePath: string): Record<string, SessionEntry> {
    const cached = this.cache.get(storePath);
    if (cached) {
      return structuredClone(cached);
    }

    if (this.globalSnapshot) {
      const snapshot = structuredClone(this.globalSnapshot);
      this.cache.set(storePath, snapshot);
      this.loadFromAdapterAsync(storePath).catch(() => {
        // Best-effort background refresh
      });
      return structuredClone(snapshot);
    }

    // No cache - return empty and trigger background load
    this.loadFromAdapterAsync(storePath).catch(() => {
      // Best-effort background load
    });
    return {};
  }

  /**
   * Load session store asynchronously.
   */
  async loadSessionStoreAsync(storePath: string): Promise<Record<string, SessionEntry>> {
    await this.loadFromAdapterAsync(storePath);
    return structuredClone(this.cache.get(storePath) ?? {});
  }

  /**
   * Save session store - async operation.
   */
  async saveSessionStore(storePath: string, store: Record<string, SessionEntry>): Promise<void> {
    const previous = this.cache.get(storePath) ?? {};

    // Update cache
    const snapshot = structuredClone(store);
    this.cache.set(storePath, snapshot);
    this.globalSnapshot = structuredClone(snapshot);

    // Save each entry to adapter
    for (const [key, entry] of Object.entries(store)) {
      await this.adapter.saveSession(key, this.toAdapterEntry(key, entry));
    }

    // Propagate deletions from the prior snapshot.
    for (const key of Object.keys(previous)) {
      if (!(key in store)) {
        await this.adapter.deleteSession(key);
      }
    }
  }

  /**
   * Update session store with a mutator function.
   */
  async updateSessionStore<T>(
    storePath: string,
    mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  ): Promise<T> {
    // Load current state
    const store = await this.loadSessionStoreAsync(storePath);
    const result = await mutator(store);

    // Save updated state
    await this.saveSessionStore(storePath, store);

    return result;
  }

  /**
   * Load a single session entry.
   */
  async loadSession(key: string): Promise<SessionEntry | null> {
    const adapterEntry = await this.adapter.loadSession(key);
    if (!adapterEntry) {
      return null;
    }
    return this.fromAdapterEntry(adapterEntry);
  }

  /**
   * Save a single session entry.
   */
  async saveSession(key: string, entry: SessionEntry): Promise<void> {
    await this.adapter.saveSession(key, this.toAdapterEntry(key, entry));
  }

  async appendTranscriptEvent(params: TranscriptAppendInput): Promise<{ sessionFile?: string }> {
    const result = await this.adapter.appendTranscriptEvent(params);
    this.mergeTranscriptSummary(params.sessionId, [params.event]);
    emitSessionTranscriptUpdate({
      sessionId: params.sessionId,
      agentId: params.agentId,
      updatedAt: Date.now(),
    });
    return result;
  }

  async appendTranscriptEvents(
    params: TranscriptAppendManyInput,
  ): Promise<TranscriptAppendManyResult> {
    const result = await this.adapter.appendTranscriptEvents(params);
    this.mergeTranscriptSummary(params.sessionId, params.events);
    emitSessionTranscriptUpdate({
      sessionId: params.sessionId,
      agentId: params.agentId,
      seq: result.lastSeq,
      updatedAt: Date.now(),
    });
    return result;
  }

  async readTranscriptMessages(params: TranscriptReadInput): Promise<unknown[]> {
    return await this.adapter.readTranscriptMessages(params);
  }

  async readTranscriptEvents(params: TranscriptReadEventsInput): Promise<TranscriptEventRecord[]> {
    return await this.adapter.readTranscriptEvents(params);
  }

  async readTranscriptPreview(params: TranscriptPreviewInput): Promise<TranscriptPreviewItem[]> {
    return await this.adapter.readTranscriptPreview(params);
  }

  async compactTranscript(params: TranscriptCompactInput): Promise<TranscriptCompactResult> {
    const result = await this.adapter.compactTranscript(params);
    // Compaction may rewrite history; force summary refresh on next request.
    this.transcriptSummaries.delete(params.sessionId);
    return result;
  }

  async deleteTranscript(params: TranscriptLocation): Promise<TranscriptDeleteResult> {
    const result = await this.adapter.deleteTranscript(params);
    this.transcriptSummaries.delete(params.sessionId);
    emitSessionTranscriptUpdate({
      sessionId: params.sessionId,
      agentId: params.agentId,
      updatedAt: Date.now(),
    });
    return result;
  }

  async replaceTranscript(params: TranscriptReplaceInput): Promise<TranscriptReplaceResult> {
    const result = await this.adapter.replaceTranscript(params);
    this.rebuildTranscriptSummary(params.sessionId, params.events);
    emitSessionTranscriptUpdate({
      sessionId: params.sessionId,
      agentId: params.agentId,
      seq: result.lastSeq,
      updatedAt: Date.now(),
    });
    return result;
  }

  async cloneTranscript(params: TranscriptCloneInput): Promise<TranscriptCloneResult> {
    const result = await this.adapter.cloneTranscript(params);
    // Clone source may vary with upToSeq/overwrite; refresh lazily on demand.
    this.transcriptSummaries.delete(params.targetSessionId);
    emitSessionTranscriptUpdate({
      sessionId: params.targetSessionId,
      agentId: params.agentId,
      seq: result.lastSeq,
      updatedAt: Date.now(),
    });
    return result;
  }

  async withSessionLock<T>(params: SessionLockInput, fn: () => Promise<T>): Promise<T> {
    return await this.adapter.withSessionLock(params, fn);
  }

  /**
   * List sessions with filtering.
   */
  async listSessions(
    filter: import("./interfaces/storage.js").SessionFilter,
  ): Promise<Array<{ key: string; entry: SessionEntry }>> {
    const results = await this.adapter.listSessions(filter);
    return results.map((r) => ({
      key: r.key,
      entry: this.fromAdapterEntry(r.entry),
    }));
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  async warmStart(): Promise<void> {
    await this.loadFromAdapterAsync("__global__");
    const sessionIds = new Set<string>();
    for (const entry of Object.values(this.globalSnapshot ?? {})) {
      if (entry?.sessionId) {
        sessionIds.add(entry.sessionId);
      }
    }
    await this.warmTranscriptSummaries([...sessionIds]);
  }

  readFirstUserMessageFromTranscriptSync(sessionId: string): string | null {
    const summary = this.transcriptSummaries.get(sessionId);
    return summary?.firstUserMessage ?? null;
  }

  readLastMessagePreviewFromTranscriptSync(sessionId: string): string | null {
    const summary = this.transcriptSummaries.get(sessionId);
    return summary?.lastMessagePreview ?? null;
  }

  primeTranscriptSummary(params: {
    sessionId: string;
    storePath?: string;
    sessionFile?: string;
    agentId?: string;
  }): void {
    if (this.transcriptSummaries.has(params.sessionId)) {
      return;
    }
    const existing = this.transcriptSummaryLoads.get(params.sessionId);
    if (existing) {
      return;
    }
    const loadPromise = this.loadTranscriptSummaryFromAdapter(params).finally(() => {
      this.transcriptSummaryLoads.delete(params.sessionId);
    });
    this.transcriptSummaryLoads.set(params.sessionId, loadPromise);
    void loadPromise;
  }

  private async loadFromAdapterAsync(storePath: string): Promise<void> {
    // Load all sessions (optimally we would filter by storePath if the adapter supported it,
    // but typically storePath implies a tenant or user scope.
    // For now, listing all sessions might be heavy if not filtered).
    // Ideally update listSessions to support whatever 'storePath' represents,
    // but in the unified model 'storePath' is legacy.
    const results = await this.adapter.listSessions({});
    const store: Record<string, SessionEntry> = {};

    for (const { key, entry } of results) {
      store[key] = this.fromAdapterEntry(entry);
    }

    this.cache.set(storePath, store);
    this.globalSnapshot = structuredClone(store);
  }

  private async flushPending(): Promise<void> {
    for (const [, store] of this.cache) {
      for (const [key, entry] of Object.entries(store)) {
        try {
          await this.adapter.saveSession(key, this.toAdapterEntry(key, entry));
        } catch {
          // Best-effort flush
        }
      }
    }
  }

  private async loadTranscriptSummaryFromAdapter(params: {
    sessionId: string;
    storePath?: string;
    sessionFile?: string;
    agentId?: string;
  }): Promise<void> {
    let firstUserMessage: string | null = null;
    let lastMessagePreview: string | null = null;

    const head = await this.adapter.readTranscriptMessages({
      sessionId: params.sessionId,
      storePath: params.storePath,
      sessionFile: params.sessionFile,
      agentId: params.agentId,
      order: "asc",
      limit: 64,
    });
    for (const message of head) {
      const { role, text } = this.extractRoleAndTextFromMessageObject(message);
      if (role === "user" && text) {
        firstUserMessage = text;
        break;
      }
    }

    const tail = await this.adapter.readTranscriptMessages({
      sessionId: params.sessionId,
      storePath: params.storePath,
      sessionFile: params.sessionFile,
      agentId: params.agentId,
      order: "desc",
      limit: 24,
    });
    for (const message of tail) {
      const { role, text } = this.extractRoleAndTextFromMessageObject(message);
      if ((role === "user" || role === "assistant") && text) {
        lastMessagePreview = text;
        break;
      }
    }

    this.transcriptSummaries.set(params.sessionId, {
      firstUserMessage,
      lastMessagePreview,
    });
  }

  private async warmTranscriptSummaries(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) {
      return;
    }
    const maxConcurrency = 8;
    let cursor = 0;
    const workerCount = Math.min(maxConcurrency, sessionIds.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < sessionIds.length) {
        const sessionId = sessionIds[cursor];
        cursor += 1;
        try {
          await this.loadTranscriptSummaryFromAdapter({ sessionId });
        } catch {
          // Best-effort warm cache
        }
      }
    });
    await Promise.all(workers);
  }

  private mergeTranscriptSummary(sessionId: string, events: Array<Record<string, unknown>>): void {
    const current = this.transcriptSummaries.get(sessionId) ?? {
      firstUserMessage: null,
      lastMessagePreview: null,
    };
    for (const event of events) {
      const { role, text } = this.extractRoleAndTextFromEvent(event);
      if (role === "user" && text && !current.firstUserMessage) {
        current.firstUserMessage = text;
      }
      if ((role === "user" || role === "assistant") && text) {
        current.lastMessagePreview = text;
      }
    }
    this.transcriptSummaries.set(sessionId, current);
  }

  private rebuildTranscriptSummary(
    sessionId: string,
    events: Array<Record<string, unknown>>,
  ): void {
    const next = {
      firstUserMessage: null as string | null,
      lastMessagePreview: null as string | null,
    };
    for (const event of events) {
      const { role, text } = this.extractRoleAndTextFromEvent(event);
      if (role === "user" && text && !next.firstUserMessage) {
        next.firstUserMessage = text;
      }
      if ((role === "user" || role === "assistant") && text) {
        next.lastMessagePreview = text;
      }
    }
    this.transcriptSummaries.set(sessionId, next);
  }

  private extractRoleAndTextFromEvent(event: Record<string, unknown>): {
    role?: string;
    text: string | null;
  } {
    const messageRaw =
      event && typeof event === "object" && "message" in event
        ? (event as { message?: unknown }).message
        : event;
    return this.extractRoleAndTextFromMessageObject(messageRaw);
  }

  private extractRoleAndTextFromMessageObject(messageRaw: unknown): {
    role?: string;
    text: string | null;
  } {
    if (!messageRaw || typeof messageRaw !== "object") {
      return { role: undefined, text: null };
    }
    const message = messageRaw as {
      role?: unknown;
      content?: unknown;
      text?: unknown;
    };
    const role = typeof message.role === "string" ? message.role : undefined;
    const content = message.content;
    if (typeof content === "string") {
      const trimmed = content.trim();
      return { role, text: trimmed || null };
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") {
          continue;
        }
        const typed = part as { type?: unknown; text?: unknown };
        if (typeof typed.text !== "string") {
          continue;
        }
        const partType = typeof typed.type === "string" ? typed.type.toLowerCase() : "";
        if (
          partType === "text" ||
          partType === "input_text" ||
          partType === "output_text" ||
          partType === ""
        ) {
          const trimmed = typed.text.trim();
          if (trimmed) {
            return { role, text: trimmed };
          }
        }
      }
    }
    if (typeof message.text === "string") {
      const trimmed = message.text.trim();
      return { role, text: trimmed || null };
    }
    return { role, text: null };
  }

  /**
   * Convert a SessionEntry to the adapter's SessionEntry format.
   */
  private toAdapterEntry(key: string, entry: SessionEntry): AdapterSessionEntry {
    return {
      id: key,
      userId: entry.origin?.from,
      channelId: undefined,
      createdAt: entry.updatedAt,
      updatedAt: entry.updatedAt,
      metadata: entry,
    };
  }

  /**
   * Convert an adapter SessionEntry back to the config SessionEntry format.
   */
  private fromAdapterEntry(adapterEntry: AdapterSessionEntry): SessionEntry {
    const metadata = adapterEntry.metadata as SessionEntry | undefined;
    if (metadata) {
      return {
        ...metadata,
        sessionId: metadata.sessionId ?? adapterEntry.id,
        updatedAt: adapterEntry.updatedAt,
      };
    }

    // Minimal entry when no metadata
    return {
      sessionId: adapterEntry.id,
      updatedAt: adapterEntry.updatedAt,
    };
  }

  async listAllSessionIds(): Promise<string[]> {
    const sessions = await this.adapter.listSessions({});
    return sessions.map((s) => s.key);
  }

  async getSessionMetadata(
    sessionId: string,
  ): Promise<{ size: number; mtimeMs: number; hash?: string } | null> {
    const events = await this.adapter.readTranscriptEvents({
      sessionId,
      order: "desc",
      limit: 1,
    });
    if (events.length === 0) {
      return {
        size: 0,
        mtimeMs: Date.now(),
      };
    }
    const latest = events[0];
    const all = await this.adapter.readTranscriptEvents({
      sessionId,
      order: "asc",
    });
    const serialized = all.map((evt) => JSON.stringify(evt.raw)).join("\n");
    return {
      size: Buffer.byteLength(serialized, "utf-8"),
      mtimeMs: latest.createdAt,
    };
  }

  async getSessionContent(sessionId: string): Promise<string | null> {
    const events = await this.adapter.readTranscriptEvents({
      sessionId,
      order: "asc",
    });
    if (!events || events.length === 0) {
      return "";
    }
    return events.map((evt) => JSON.stringify(evt.raw)).join("\n");
  }
}

/**
 * Global session store bridge instance.
 */
let globalBridge: SessionStoreBridge | null = null;

export function initializeSessionStoreBridge(adapter: StorageAdapter): void {
  if (globalBridge) {
    globalBridge.dispose();
  }
  globalBridge = new SessionStoreBridge(adapter);
}

export function getSessionStoreBridge(): SessionStoreBridge {
  if (!globalBridge) {
    throw new Error(
      "SessionStoreBridge not initialized. Call initializeSessionStoreBridge() first.",
    );
  }
  return globalBridge;
}
