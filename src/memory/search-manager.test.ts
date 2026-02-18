import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSqliteManager = {
  search: vi.fn(async () => []),
  readFile: vi.fn(async () => ({ text: "", path: "MEMORY.md" })),
  status: vi.fn(() => ({ backend: "builtin" as const, provider: "openai" })),
  probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
  probeVectorAvailability: vi.fn(async () => true),
};

const mockPostgresManager = {
  search: vi.fn(async () => []),
  readFile: vi.fn(async () => ({ text: "", path: "MEMORY.md" })),
  status: vi.fn(() => ({ backend: "builtin" as const, provider: "openai" })),
  probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
  probeVectorAvailability: vi.fn(async () => true),
};

vi.mock("./manager.js", () => ({
  MemoryIndexManager: {
    get: vi.fn(async () => mockSqliteManager),
  },
}));

vi.mock("./manager-postgres.js", () => ({
  PostgresMemoryIndexManager: {
    get: vi.fn(async () => mockPostgresManager),
  },
}));

import { PostgresMemoryIndexManager } from "./manager-postgres.js";
import { MemoryIndexManager } from "./manager.js";
import { getMemorySearchManager } from "./search-manager.js";

beforeEach(() => {
  mockSqliteManager.search.mockClear();
  mockSqliteManager.readFile.mockClear();
  mockSqliteManager.status.mockClear();
  mockSqliteManager.probeEmbeddingAvailability.mockClear();
  mockSqliteManager.probeVectorAvailability.mockClear();
  mockPostgresManager.search.mockClear();
  mockPostgresManager.readFile.mockClear();
  mockPostgresManager.status.mockClear();
  mockPostgresManager.probeEmbeddingAvailability.mockClear();
  mockPostgresManager.probeVectorAvailability.mockClear();
  MemoryIndexManager.get.mockClear();
  PostgresMemoryIndexManager.get.mockClear();
});

describe("getMemorySearchManager routing", () => {
  it("uses sqlite manager by default", async () => {
    const cfg = {
      memory: { backend: "builtin" },
      agents: { list: [{ id: "main", default: true, workspace: "/tmp/workspace" }] },
    } as const;

    const resolved = await getMemorySearchManager({ cfg, agentId: "main" });

    expect(resolved.manager).toBe(mockSqliteManager);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(MemoryIndexManager.get).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(PostgresMemoryIndexManager.get).not.toHaveBeenCalled();
  });

  it("routes to postgres manager when store driver is postgres", async () => {
    const cfg = {
      memory: {
        backend: "builtin",
      },
      agents: {
        defaults: {
          workspace: "/tmp/workspace",
          memorySearch: {
            enabled: true,
            provider: "openai",
            store: {
              driver: "postgres",
              postgres: { url: "postgres://localhost:5432/openclaw" },
            },
          },
        },
      },
    } as const;

    const resolved = await getMemorySearchManager({ cfg, agentId: "main" });

    expect(resolved.manager).toBe(mockPostgresManager);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(PostgresMemoryIndexManager.get).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(MemoryIndexManager.get).not.toHaveBeenCalled();
  });
});
