import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureSchemaMock = vi.fn(async () => {});
const closeMock = vi.fn(async () => {});
const constructorMock = vi.fn();

vi.mock("./postgres-storage.js", () => {
  class MockPostgresStorageAdapter {
    constructor(config: unknown) {
      constructorMock(config);
    }

    async ensureSchema() {
      await ensureSchemaMock();
    }

    async close() {
      await closeMock();
    }
  }

  return {
    PostgresStorageAdapter: MockPostgresStorageAdapter,
  };
});

describe("runtime storage adapter", () => {
  beforeEach(() => {
    constructorMock.mockClear();
    ensureSchemaMock.mockClear();
    closeMock.mockClear();
  });

  it("fails closed when no postgres url is configured", async () => {
    const { createRuntimeStorageAdapter } = await import("./runtime-storage.js");
    await expect(createRuntimeStorageAdapter({ env: {} })).rejects.toThrow(
      "Postgres storage is required",
    );
  });

  it("builds postgres adapter from storage env and ensures schema", async () => {
    const { createRuntimeStorageAdapter, closeRuntimeStorageAdapter } =
      await import("./runtime-storage.js");

    const adapter = await createRuntimeStorageAdapter({
      env: {
        OPENCLAW_STORAGE_POSTGRES_URL: "postgres://user:pw@host/db",
        OPENCLAW_STORAGE_POSTGRES_SCHEMA: "openclaw",
        OPENCLAW_STORAGE_POSTGRES_SESSIONS_TABLE: "sessions",
        OPENCLAW_STORAGE_POSTGRES_TRANSCRIPTS_TABLE: "session_messages",
        OPENCLAW_STORAGE_POSTGRES_AUDIT_TABLE: "audit_logs",
        OPENCLAW_STORAGE_POSTGRES_TENANT_ID: "00000000-0000-0000-0000-000000000001",
        OPENCLAW_STORAGE_POSTGRES_TENANT_SLUG: "tenant-a",
        OPENCLAW_STORAGE_POSTGRES_DEFAULT_AGENT_ID: "ops",
        OPENCLAW_STORAGE_POSTGRES_MAX_CONNECTIONS: "12",
        OPENCLAW_STORAGE_POSTGRES_SSL: "true",
      },
    });

    expect(constructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "postgres://user:pw@host/db",
        schema: "openclaw",
        sessionsTable: "sessions",
        transcriptsTable: "session_messages",
        auditTable: "audit_logs",
        tenantId: "00000000-0000-0000-0000-000000000001",
        tenantSlug: "tenant-a",
        defaultAgentId: "ops",
        maxConnections: 12,
        ssl: true,
      }),
    );
    expect(ensureSchemaMock).toHaveBeenCalledTimes(1);

    await closeRuntimeStorageAdapter(adapter);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("accepts shared postgres env fallback", async () => {
    const { createRuntimeStorageAdapter } = await import("./runtime-storage.js");

    await createRuntimeStorageAdapter({
      env: {
        POSTGRES_URL: "postgres://fallback:pw@host/fallback",
      },
    });

    expect(constructorMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: "postgres://fallback:pw@host/fallback",
      }),
    );
  });
});
