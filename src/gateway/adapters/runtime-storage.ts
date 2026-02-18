import type { StorageAdapter } from "../interfaces/storage.js";
import { PostgresStorageAdapter, type PostgresStorageConfig } from "./postgres-storage.js";

function readEnvValue(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

export type RuntimeStorageAdapterOptions = {
  env?: NodeJS.ProcessEnv;
};

export async function createRuntimeStorageAdapter(
  opts: RuntimeStorageAdapterOptions = {},
): Promise<StorageAdapter> {
  const env = opts.env ?? process.env;
  const url = readEnvValue(env, [
    "OPENCLAW_STORAGE_POSTGRES_URL",
    "OPENCLAW_POSTGRES_URL",
    "OPENCLAW_MEMORY_POSTGRES_URL",
    "POSTGRES_URL",
    "DATABASE_URL",
  ]);
  if (!url) {
    throw new Error(
      "Postgres storage is required. Set OPENCLAW_STORAGE_POSTGRES_URL (or OPENCLAW_POSTGRES_URL / POSTGRES_URL / DATABASE_URL).",
    );
  }

  const config: PostgresStorageConfig = {
    url,
    schema: readEnvValue(env, ["OPENCLAW_STORAGE_POSTGRES_SCHEMA"]),
    sessionsTable: readEnvValue(env, ["OPENCLAW_STORAGE_POSTGRES_SESSIONS_TABLE"]),
    transcriptsTable: readEnvValue(env, ["OPENCLAW_STORAGE_POSTGRES_TRANSCRIPTS_TABLE"]),
    auditTable: readEnvValue(env, ["OPENCLAW_STORAGE_POSTGRES_AUDIT_TABLE"]),
    tenantId: readEnvValue(env, ["OPENCLAW_STORAGE_POSTGRES_TENANT_ID"]),
    tenantSlug: readEnvValue(env, ["OPENCLAW_STORAGE_POSTGRES_TENANT_SLUG"]),
    defaultAgentId: readEnvValue(env, ["OPENCLAW_STORAGE_POSTGRES_DEFAULT_AGENT_ID"]),
    maxConnections: parseOptionalInteger(
      readEnvValue(env, ["OPENCLAW_STORAGE_POSTGRES_MAX_CONNECTIONS"]),
    ),
    ssl: parseOptionalBoolean(readEnvValue(env, ["OPENCLAW_STORAGE_POSTGRES_SSL"])),
  };

  const adapter = new PostgresStorageAdapter(config);
  await adapter.ensureSchema();
  return adapter;
}

export async function closeRuntimeStorageAdapter(storageAdapter: StorageAdapter): Promise<void> {
  const maybeClosable = storageAdapter as { close?: () => Promise<void> | void };
  if (typeof maybeClosable.close !== "function") {
    return;
  }
  await maybeClosable.close();
}
