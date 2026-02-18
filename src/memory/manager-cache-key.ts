import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { fingerprintHeaderNames } from "./headers-fingerprint.js";
import { hashText } from "./internal.js";

export function computeMemoryManagerCacheKey(params: {
  agentId: string;
  workspaceDir: string;
  settings: ResolvedMemorySearchConfig;
}): string {
  const settings = params.settings;
  const fingerprint = hashText(
    JSON.stringify({
      enabled: settings.enabled,
      sources: [...settings.sources].toSorted((a, b) => a.localeCompare(b)),
      extraPaths: [...settings.extraPaths].toSorted((a, b) => a.localeCompare(b)),
      provider: settings.provider,
      model: settings.model,
      fallback: settings.fallback,
      local: {
        modelPath: settings.local.modelPath,
        modelCacheDir: settings.local.modelCacheDir,
      },
      remote: settings.remote
        ? {
            baseUrl: settings.remote.baseUrl,
            headerNames: fingerprintHeaderNames(settings.remote.headers),
            batch: settings.remote.batch
              ? {
                  enabled: settings.remote.batch.enabled,
                  wait: settings.remote.batch.wait,
                  concurrency: settings.remote.batch.concurrency,
                  pollIntervalMs: settings.remote.batch.pollIntervalMs,
                  timeoutMinutes: settings.remote.batch.timeoutMinutes,
                }
              : undefined,
          }
        : undefined,
      experimental: settings.experimental,
      store: {
        driver: settings.store.driver,
        path: settings.store.path,
        postgres: settings.store.postgres
          ? {
              tenantId: settings.store.postgres.tenantId,
              schema: settings.store.postgres.schema,
              sessionsTable: settings.store.postgres.sessionsTable,
              sessionMessagesTable: settings.store.postgres.sessionMessagesTable,
              filesTable: settings.store.postgres.filesTable,
              chunksTable: settings.store.postgres.chunksTable,
              embeddingCacheTable: settings.store.postgres.embeddingCacheTable,
              indexStateTable: settings.store.postgres.indexStateTable,
              maxConnections: settings.store.postgres.maxConnections,
              ssl: settings.store.postgres.ssl,
            }
          : undefined,
        vector: {
          enabled: settings.store.vector.enabled,
          extensionPath: settings.store.vector.extensionPath,
        },
      },
      chunking: settings.chunking,
      sync: settings.sync,
      query: settings.query,
      cache: settings.cache,
    }),
  );
  return `${params.agentId}:${params.workspaceDir}:${fingerprint}`;
}
