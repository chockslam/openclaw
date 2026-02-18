import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { PostgresMemoryIndexManager } from "./manager-postgres.js";

// Mock dependencies
const mockConfig: OpenClawConfig = {
  agents: { defaults: { workspace: "/tmp/test-workspace" } },
};

// Mock pool factory
const mockPool = {
  query: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
};

const mockPoolFactory = () => mockPool;

vi.mock("../config/config.js", () => ({
  loadConfig: () => mockConfig,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentDir: () => "/tmp/agent-dir",
  resolveAgentWorkspaceDir: () => "/tmp/test-workspace",
}));

// Mock embedding provider creation
vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: vi.fn().mockResolvedValue({
    provider: { id: "openai", model: "text-embedding-3-small" },
    requestedProvider: "openai",
  }),
}));

describe("PostgresMemoryIndexManager Integration", () => {
  let manager: PostgresMemoryIndexManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("should list session IDs from postgres", async () => {
    const settings = {
      store: {
        driver: "postgres",
        postgres: {
          url: "postgres://localhost:5432/test",
          sessionsTable: "sessions",
          sessionMessagesTable: "session_messages",
          filesTable: "files",
          chunksTable: "chunks",
          embeddingCacheTable: "embedding_cache",
          indexStateTable: "index_state",
          schema: "public",
        },
        vector: { enabled: false },
      },
      provider: "openai",
      model: "text-embedding-3-small",
      sync: { sessions: { deltaBytes: 1 } },
      chunking: { tokens: 100 },
      query: { hybrid: { enabled: false } },
      cache: { enabled: false },
      sources: ["sessions"],
    };

    // Schema existence check mocks
    mockPool.query.mockResolvedValue({ rows: [{ 1: 1 }] });

    manager = new (PostgresMemoryIndexManager as any)({
      cacheKey: "test-key",
      agentId: "test-agent",
      workspaceDir: "/tmp/test-workspace",
      settings: settings as any,
      providerResult: {
        provider: { id: "openai", model: "text-embedding-3-small" },
        requestedProvider: "openai",
      },
      poolFactory: mockPoolFactory,
    });

    // Reset for actual test
    mockPool.query.mockClear();
    // Mock session list response
    mockPool.query.mockResolvedValue({ rows: [{ data: { id: "pg-session-1" } }] });

    const ids = await (manager as any).listSessionIds();

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT key, data FROM "public"."sessions"'),
      expect.anything(),
    );
    expect(ids).toContain("pg-session-1");
  });

  it("should build session entry from postgres rows", async () => {
    const settings = {
      store: {
        driver: "postgres",
        postgres: {
          url: "postgres://localhost:5432/test",
          sessionsTable: "sessions",
          sessionMessagesTable: "session_messages",
          filesTable: "files",
          chunksTable: "chunks",
          embeddingCacheTable: "embedding_cache",
          indexStateTable: "index_state",
          schema: "public",
        },
        vector: { enabled: false },
      },
      provider: "openai",
      model: "text-embedding-3-small",
      sync: { sessions: { deltaBytes: 1 } },
      chunking: { tokens: 100 },
      query: { hybrid: { enabled: false } },
      cache: { enabled: false },
      sources: ["sessions"],
    };

    mockPool.query.mockResolvedValue({ rows: [{ 1: 1 }] });

    manager = new (PostgresMemoryIndexManager as any)({
      cacheKey: "test-key",
      agentId: "test-agent",
      workspaceDir: "/tmp/test-workspace",
      settings: settings as any,
      providerResult: {
        provider: { id: "openai", model: "text-embedding-3-small" },
        requestedProvider: "openai",
      },
      poolFactory: mockPoolFactory,
    });

    mockPool.query.mockClear();

    mockPool.query.mockResolvedValue({
      rows: [
        { message_json: { role: "user", content: "hello pg" }, created_at: new Date() },
        { message_json: { role: "assistant", content: "hi pg" }, created_at: new Date() },
      ],
    });

    const entry = await (manager as any).buildSessionEntry("session-1");

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT message_json"),
      expect.arrayContaining(["session-1"]),
    );
    expect(entry).not.toBeNull();
    expect(entry?.content).toContain("User: hello pg");
    expect(entry?.content).toContain("Assistant: hi pg");
  });
});
