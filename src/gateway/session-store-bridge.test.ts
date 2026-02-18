import { describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "./interfaces/storage.js";
import { SessionStoreBridge } from "./session-store-bridge.js";

// Mock adapter for testing
class MockAdapter implements StorageAdapter {
  private sessions = new Map<string, any>();
  private transcripts = new Map<string, any[]>();

  async saveSession(key: string, entry: any): Promise<void> {
    this.sessions.set(key, entry);
  }
  async loadSession(key: string): Promise<any> {
    return this.sessions.get(key) || null;
  }
  async listSessions(filter: any): Promise<any[]> {
    return Array.from(this.sessions.entries()).map(([key, entry]) => ({ key, entry }));
  }
  async deleteSession(key: string): Promise<void> {
    this.sessions.delete(key);
  }
  async appendTranscriptEvent(params: any): Promise<{ sessionFile?: string }> {
    const list = this.transcripts.get(params.sessionId) || [];
    list.push(params.event);
    this.transcripts.set(params.sessionId, list);
    return { sessionFile: `mock://${params.sessionId}` };
  }
  async readTranscriptMessages(params: any): Promise<unknown[]> {
    const list = this.transcripts.get(params.sessionId) || [];
    return list.map((e: any) => e.message);
  }
  async readTranscriptPreview(params: any): Promise<any[]> {
    return [];
  }
  async compactTranscript(params: any): Promise<any> {
    return { compacted: false, kept: 0, reason: "mock" };
  }
  async deleteTranscript(params: any): Promise<any> {
    return { deleted: false, archived: [] };
  }
  async logAuditEvent(event: any): Promise<void> {}
  async listUsers(): Promise<string[]> {
    return [];
  }
  async listAuditEvents(): Promise<any[]> {
    return [];
  }
}

describe("SessionStoreBridge", () => {
  it("throws if initialized without an adapter", () => {
    expect(() => new SessionStoreBridge(undefined as any)).toThrow(/requires a StorageAdapter/);
  });

  it("delegates saveSession to adapter", async () => {
    const adapter = new MockAdapter();
    const bridge = new SessionStoreBridge(adapter);
    const date = Date.now();

    await bridge.saveSession("test-1", {
      sessionId: "test-1",
      updatedAt: date,
      origin: { from: "user-1", channel: "web" },
    });

    const stored = await adapter.loadSession("test-1");
    expect(stored).toMatchObject({
      id: "test-1",
      userId: "user-1",
      updatedAt: date,
      metadata: {
        sessionId: "test-1",
        updatedAt: date,
        origin: { from: "user-1", channel: "web" },
      },
    });
  });

  it("delegates loadSessionStore to adapter (async)", async () => {
    const adapter = new MockAdapter();
    const bridge = new SessionStoreBridge(adapter);
    const date = Date.now();

    // Pre-populate adapter
    await adapter.saveSession("s1", { sessionId: "s1", updatedAt: date });
    await adapter.saveSession("s2", { sessionId: "s2", updatedAt: date });

    // Load
    const store = await bridge.loadSessionStoreAsync("any-path");

    expect(Object.keys(store)).toHaveLength(2);
    expect(store["s1"]).toBeDefined();
    expect(store["s2"]).toBeDefined();
  });

  it("caches sessions for synchronous loadSessionStore", async () => {
    const adapter = new MockAdapter();
    const bridge = new SessionStoreBridge(adapter);

    // Initial sync load is empty but triggers background fetch
    const empty = bridge.loadSessionStore("path");
    expect(empty).toEqual({});

    // Wait for background fetch (mocked by calling async load explicitly for test stability)
    await bridge.loadSessionStoreAsync("path");

    // Now sync load should have data (but initially empty as adapter was empty)
    const cached = bridge.loadSessionStore("path");
    expect(cached).toEqual({});

    // Add data via bridge
    await bridge.saveSessionStore("path", {
      s1: { sessionId: "s1", updatedAt: 123 },
    });

    // Sync load should now return cached data
    const loaded = bridge.loadSessionStore("path");
    expect(loaded["s1"]).toBeDefined();
  });

  it("delegates transcript events", async () => {
    const adapter = new MockAdapter();
    const bridge = new SessionStoreBridge(adapter);

    await bridge.appendTranscriptEvent({
      sessionId: "s1",
      event: { type: "message", message: { text: "hello" } } as any,
    });

    const messages = await bridge.readTranscriptMessages({ sessionId: "s1" });
    expect(messages).toHaveLength(1);
    expect((messages[0] as any).text).toBe("hello");
  });
});
