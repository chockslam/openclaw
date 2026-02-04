/**
 * Session Store Bridge
 *
 * Bridges the synchronous session store API with the async StorageAdapter interface.
 * When a StorageAdapter is provided, operations are delegated to it.
 * Otherwise, falls back to the default file-based implementation.
 *
 * This allows enterprise deployments to use PostgreSQL/Redis while preserving
 * the existing synchronous API for OSS file-based storage.
 */

import type { SessionEntry } from "../config/sessions/types.js";
import type { StorageAdapter, SessionEntry as AdapterSessionEntry } from "./interfaces/storage.js";
import {
  loadSessionStore as loadFromFile,
  saveSessionStore as saveToFile,
  updateSessionStore as updateInFile,
} from "../config/sessions/store.js";

/**
 * A session store bridge that can operate in two modes:
 * 1. File-based (default): Uses the existing synchronous file operations
 * 2. Adapter-based: Delegates to a StorageAdapter for async operations
 *
 * The bridge maintains an in-memory cache for sync reads when using an adapter,
 * with periodic background sync to the adapter.
 */
export class SessionStoreBridge {
  private adapter: StorageAdapter | undefined;
  private cache: Map<string, Record<string, SessionEntry>> = new Map();
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  constructor(adapter?: StorageAdapter) {
    this.adapter = adapter;
    if (adapter) {
      // Start background flush for adapter mode
      this.flushInterval = setInterval(() => this.flushPending(), 5000);
    }
  }

  /**
   * Load session store - synchronous for compatibility.
   * When using adapter, returns cached data (may be stale until next sync).
   */
  loadSessionStore(storePath: string): Record<string, SessionEntry> {
    if (!this.adapter) {
      return loadFromFile(storePath);
    }

    // Return cached data for sync compatibility
    const cached = this.cache.get(storePath);
    if (cached) {
      return structuredClone(cached);
    }

    // No cache - return empty and trigger background load
    this.loadFromAdapterAsync(storePath).catch(() => {
      // Best-effort background load
    });
    return {};
  }

  /**
   * Load session store asynchronously (preferred for adapter mode).
   */
  async loadSessionStoreAsync(storePath: string): Promise<Record<string, SessionEntry>> {
    if (!this.adapter) {
      return loadFromFile(storePath);
    }

    await this.loadFromAdapterAsync(storePath);
    return this.cache.get(storePath) ?? {};
  }

  /**
   * Save session store - async operation.
   */
  async saveSessionStore(storePath: string, store: Record<string, SessionEntry>): Promise<void> {
    if (!this.adapter) {
      return saveToFile(storePath, store);
    }

    // Update cache
    this.cache.set(storePath, structuredClone(store));

    // Save each entry to adapter
    for (const [key, entry] of Object.entries(store)) {
      await this.adapter.saveSession(key, this.toAdapterEntry(key, entry));
    }
  }

  /**
   * Update session store with a mutator function.
   */
  async updateSessionStore<T>(
    storePath: string,
    mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  ): Promise<T> {
    if (!this.adapter) {
      return updateInFile(storePath, mutator);
    }

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
    if (!this.adapter) {
      return null; // Not supported in file mode - use loadSessionStore
    }

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
    if (!this.adapter) {
      return; // Not supported in file mode - use updateSessionStore
    }

    await this.adapter.saveSession(key, this.toAdapterEntry(key, entry));
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

  private async loadFromAdapterAsync(storePath: string): Promise<void> {
    if (!this.adapter) return;

    // Load all sessions for this store path
    const sessions = await this.adapter.listSessions({});
    const store: Record<string, SessionEntry> = {};

    for (const session of sessions) {
      store[session.id] = this.fromAdapterEntry(session);
    }

    this.cache.set(storePath, store);
  }

  private async flushPending(): Promise<void> {
    if (!this.adapter) return;

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

  /**
   * Convert a SessionEntry to the adapter's SessionEntry format.
   */
  private toAdapterEntry(key: string, entry: SessionEntry): AdapterSessionEntry {
    return {
      id: key,
      userId: entry.origin?.from,
      channelId: undefined, // Add missing property
      createdAt: entry.updatedAt, // No createdAt in config type, use updatedAt
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
}

/**
 * Global session store bridge instance.
 * Initialized at gateway startup with the configured adapter.
 */
let globalBridge: SessionStoreBridge | null = null;

/**
 * Initialize the global session store bridge.
 */
export function initializeSessionStoreBridge(adapter?: StorageAdapter): void {
  if (globalBridge) {
    globalBridge.dispose();
  }
  globalBridge = new SessionStoreBridge(adapter);
}

/**
 * Get the global session store bridge.
 * Falls back to a default file-based bridge if not initialized.
 */
export function getSessionStoreBridge(): SessionStoreBridge {
  if (!globalBridge) {
    globalBridge = new SessionStoreBridge();
  }
  return globalBridge;
}
