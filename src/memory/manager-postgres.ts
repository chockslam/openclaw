import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { truncateUtf16Safe } from "../utils.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
} from "./embeddings.js";
import { buildFtsQuery, mergeHybridResults } from "./hybrid.js";
import {
  buildFileEntry,
  chunkMarkdown,
  cosineSimilarity,
  hashText,
  isMemoryPath,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  type MemoryChunk,
  type MemoryFileEntry,
} from "./internal.js";
import { computeMemoryManagerCacheKey } from "./manager-cache-key.js";
import { extractSessionText } from "./session-files.js";

const require = createRequire(import.meta.url);
const log = createSubsystemLogger("memory");

const INDEX_CACHE = new Map<string, PostgresMemoryIndexManager>();

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SNIPPET_MAX_CHARS = 700;
const EMBEDDING_BATCH_MAX_TOKENS = 8000;
const EMBEDDING_APPROX_CHARS_PER_TOKEN = 1;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8000;
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_REMOTE_MS = 2 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_LOCAL_MS = 10 * 60_000;

type PgQueryResultLike = {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
};

type PgPoolLike = {
  query: (sql: string, params?: unknown[]) => Promise<PgQueryResultLike>;
  end: () => Promise<void>;
};

type PgPoolCtor = new (config: Record<string, unknown>) => PgPoolLike;

type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey?: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
  updatedAt?: string;
};

type SourceEntry = {
  path: string;
  source: MemorySource;
  hash: string;
  mtimeMs: number;
  size: number;
  content: string;
};

type Tables = {
  sessions: string;
  sessionMessages: string;
  files: string;
  chunks: string;
  embeddingCache: string;
  indexState: string;
};

type QualifiedTables = {
  sessions: string;
  sessionMessages: string;
  files: string;
  chunks: string;
  embeddingCache: string;
  indexState: string;
};

type SessionMessageColumns = {
  hasMessageJson: boolean;
  hasRawJson: boolean;
  hasTextRedacted: boolean;
  hasRole: boolean;
  hasId: boolean;
  hasSeq: boolean;
  hasCreatedAt: boolean;
};

function quoteIdent(value: string, kind: string): string {
  if (!IDENT_RE.test(value)) {
    throw new Error(`invalid postgres ${kind}: ${value}`);
  }
  return `"${value}"`;
}

function createPgPool(config: Record<string, unknown>): PgPoolLike {
  const pg = require("pg") as { Pool: PgPoolCtor };
  return new pg.Pool(config);
}

function safeConnectionLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.host || "localhost";
    const pathname = parsed.pathname || "/";
    return `${parsed.protocol}//${host}${pathname}`;
  } catch {
    return "postgres";
  }
}

function toVectorLiteral(embedding: number[]): string {
  const safe = embedding.map((value) => (Number.isFinite(value) ? Number(value).toString() : "0"));
  return `[${safe.join(",")}]`;
}

function parseArrayLikeEmbedding(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry));
  }
  if (typeof value !== "string") {
    return [];
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const body = trimmed.slice(1, -1).trim();
    if (!body) {
      return [];
    }
    return body
      .split(",")
      .map((entry) => Number(entry.trim()))
      .filter((entry) => Number.isFinite(entry));
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const body = trimmed.slice(1, -1).trim();
    if (!body) {
      return [];
    }
    return body
      .split(",")
      .map((entry) => Number(entry.trim().replace(/^"(.*)"$/, "$1")))
      .filter((entry) => Number.isFinite(entry));
  }
  return [];
}

function toMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    const numeric = Number.parseInt(value, 10);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return Date.now();
}

function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return 0;
}

export class PostgresMemoryIndexManager implements MemorySearchManager {
  private readonly cacheKey: string;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly settings: ResolvedMemorySearchConfig;
  private readonly tables: Tables;
  private readonly qualified: QualifiedTables;
  private readonly indexNames: {
    chunksPath: string;
    chunksModel: string;
    chunksTsv: string;
    chunksEmbedding: string;
    cacheUpdated: string;
  };
  private readonly tenantId: string;
  private readonly schemaName: string;
  private readonly postgresUrl: string;
  private readonly pool: PgPoolLike;
  private readonly sources: Set<MemorySource>;
  private readonly cache: { enabled: boolean; maxEntries?: number };
  private provider: EmbeddingProvider;
  private readonly requestedProvider: "openai" | "local" | "gemini" | "auto";
  private fallbackFrom?: "openai" | "local" | "gemini";
  private fallbackReason?: string;
  private providerKey: string;
  private readonly vector: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
    dims?: number;
  };
  private readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  };
  private ready: Promise<void>;
  private sessionMessageColumns: SessionMessageColumns = {
    hasMessageJson: true,
    hasRawJson: false,
    hasTextRedacted: false,
    hasRole: false,
    hasId: true,
    hasSeq: false,
    hasCreatedAt: true,
  };
  private closed = false;
  private dirty = true;
  private syncing: Promise<void> | null = null;
  private lastSyncAt?: number;
  private statusSnapshot: MemoryProviderStatus;

  static async get(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): Promise<PostgresMemoryIndexManager | null> {
    const settings = resolveMemorySearchConfig(params.cfg, params.agentId);
    if (!settings || settings.store.driver !== "postgres") {
      return null;
    }
    const postgres = settings.store.postgres;
    if (!postgres?.url) {
      throw new Error(
        "memorySearch.store.driver is postgres but no store.postgres.url is configured",
      );
    }
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const cacheKey = `${computeMemoryManagerCacheKey({
      agentId: params.agentId,
      workspaceDir,
      settings,
    })}:pg:${hashText(postgres.url)}`;
    const existing = INDEX_CACHE.get(cacheKey);
    if (existing) {
      return existing;
    }
    const providerResult = await createEmbeddingProvider({
      config: params.cfg,
      agentDir: resolveAgentDir(params.cfg, params.agentId),
      provider: settings.provider,
      remote: settings.remote,
      model: settings.model,
      fallback: settings.fallback,
      local: settings.local,
    });
    const manager = new PostgresMemoryIndexManager({
      cacheKey,
      agentId: params.agentId,
      workspaceDir,
      settings,
      providerResult,
    });
    INDEX_CACHE.set(cacheKey, manager);
    return manager;
  }

  private constructor(params: {
    cacheKey: string;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    providerResult: EmbeddingProviderResult;
    poolFactory?: (config: Record<string, unknown>) => PgPoolLike;
  }) {
    const postgres = params.settings.store.postgres;
    if (!postgres?.url) {
      throw new Error("postgres memory store is missing url");
    }
    this.cacheKey = params.cacheKey;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.settings = params.settings;
    this.provider = params.providerResult.provider;
    this.requestedProvider = params.providerResult.requestedProvider;
    this.fallbackFrom = params.providerResult.fallbackFrom;
    this.fallbackReason = params.providerResult.fallbackReason;
    this.providerKey = this.computeProviderKey();
    this.sources = new Set(params.settings.sources);
    this.cache = {
      enabled: params.settings.cache.enabled,
      maxEntries: params.settings.cache.maxEntries,
    };
    this.vector = {
      enabled: params.settings.store.vector.enabled,
      available: params.settings.store.vector.enabled,
    };
    this.fts = {
      enabled: params.settings.query.hybrid.enabled,
      available: true,
    };
    this.tenantId = postgres.tenantId;
    this.schemaName = postgres.schema;
    this.postgresUrl = postgres.url;
    this.tables = {
      sessions: postgres.sessionsTable,
      sessionMessages: postgres.sessionMessagesTable,
      files: postgres.filesTable,
      chunks: postgres.chunksTable,
      embeddingCache: postgres.embeddingCacheTable,
      indexState: postgres.indexStateTable,
    };
    const schema = quoteIdent(this.schemaName, "schema");
    this.qualified = {
      sessions: `${schema}.${quoteIdent(this.tables.sessions, "table")}`,
      sessionMessages: `${schema}.${quoteIdent(this.tables.sessionMessages, "table")}`,
      files: `${schema}.${quoteIdent(this.tables.files, "table")}`,
      chunks: `${schema}.${quoteIdent(this.tables.chunks, "table")}`,
      embeddingCache: `${schema}.${quoteIdent(this.tables.embeddingCache, "table")}`,
      indexState: `${schema}.${quoteIdent(this.tables.indexState, "table")}`,
    };
    this.indexNames = {
      chunksPath: `idx_${this.tables.chunks}_path`,
      chunksModel: `idx_${this.tables.chunks}_model`,
      chunksTsv: `idx_${this.tables.chunks}_tsv`,
      chunksEmbedding: `idx_${this.tables.chunks}_embedding_hnsw`,
      cacheUpdated: `idx_${this.tables.embeddingCache}_updated_at`,
    };
    const poolConfig = {
      connectionString: postgres.url,
      max: postgres.maxConnections,
      ssl:
        typeof postgres.ssl === "boolean"
          ? postgres.ssl
            ? { rejectUnauthorized: false }
            : false
          : undefined,
    };
    this.pool = params.poolFactory ? params.poolFactory(poolConfig) : createPgPool(poolConfig);
    this.statusSnapshot = {
      backend: "builtin",
      provider: this.provider.id,
      model: this.provider.model,
      requestedProvider: this.requestedProvider,
      files: 0,
      chunks: 0,
      dirty: this.dirty,
      workspaceDir: this.workspaceDir,
      dbPath: safeConnectionLabel(this.postgresUrl),
      extraPaths: this.settings.extraPaths,
      sources: Array.from(this.sources),
      sourceCounts: Array.from(this.sources).map((source) => ({ source, files: 0, chunks: 0 })),
      cache: {
        enabled: this.cache.enabled,
        maxEntries: this.cache.maxEntries,
      },
      fts: {
        enabled: this.fts.enabled,
        available: this.fts.available,
      },
      vector: {
        enabled: this.vector.enabled,
        available: this.vector.available,
        loadError: this.vector.loadError,
        dims: this.vector.dims,
      },
      custom: {
        postgres: {
          tenantId: this.tenantId,
          schema: this.schemaName,
          tables: this.tables,
          vectorIndexReady: false,
          lastSyncAt: undefined,
        },
      },
    };
    this.ready = this.initialize();
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    await this.ensureReady();
    if (this.settings.sync.onSearch) {
      await this.sync({ reason: "search" });
    }
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const hybrid = this.settings.query.hybrid;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );
    const queryVec = await this.embedQueryWithTimeout(cleaned);
    const vectorResults = await this.searchVector(cleaned, queryVec, candidates);
    if (!hybrid.enabled) {
      return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }
    const keywordResults = await this.searchKeyword(cleaned, candidates);
    const merged = mergeHybridResults({
      vector: vectorResults.map((entry) => ({
        id: entry.id,
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        source: entry.source,
        snippet: entry.snippet,
        vectorScore: entry.score,
      })),
      keyword: keywordResults.map((entry) => ({
        id: entry.id,
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        source: entry.source,
        snippet: entry.snippet,
        textScore: entry.textScore,
      })),
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
    });
    return merged
      .filter((entry) => entry.score >= minScore)
      .slice(0, maxResults)
      .map((entry) => ({ ...entry, source: entry.source as MemorySource }));
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const rawPath = params.relPath.trim();
    if (!rawPath) {
      throw new Error("path required");
    }
    const absPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.workspaceDir, rawPath);
    const relPath = path.relative(this.workspaceDir, absPath).replace(/\\/g, "/");
    const inWorkspace =
      relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath);
    const allowedWorkspace = inWorkspace && isMemoryPath(relPath);
    let allowedAdditional = false;
    if (!allowedWorkspace && this.settings.extraPaths.length > 0) {
      const additionalPaths = normalizeExtraMemoryPaths(
        this.workspaceDir,
        this.settings.extraPaths,
      );
      for (const additionalPath of additionalPaths) {
        try {
          const stat = await fs.lstat(additionalPath);
          if (stat.isSymbolicLink()) {
            continue;
          }
          if (stat.isDirectory()) {
            if (absPath === additionalPath || absPath.startsWith(`${additionalPath}${path.sep}`)) {
              allowedAdditional = true;
              break;
            }
            continue;
          }
          if (stat.isFile() && absPath === additionalPath && absPath.endsWith(".md")) {
            allowedAdditional = true;
            break;
          }
        } catch {}
      }
    }
    if (!allowedWorkspace && !allowedAdditional) {
      throw new Error("path required");
    }
    if (!absPath.endsWith(".md")) {
      throw new Error("path required");
    }
    const stat = await fs.lstat(absPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("path required");
    }
    const content = await fs.readFile(absPath, "utf-8");
    if (!params.from && !params.lines) {
      return { text: content, path: relPath };
    }
    const lines = content.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    const slice = lines.slice(start - 1, start - 1 + count);
    return { text: slice.join("\n"), path: relPath };
  }

  status(): MemoryProviderStatus {
    return this.statusSnapshot;
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    await this.ensureReady();
    if (this.syncing) {
      return this.syncing;
    }
    this.syncing = this.runSync(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    await this.ensureReady();
    try {
      await this.embedBatchWithRetry(["ping"]);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    await this.ensureReady();
    return this.vector.enabled && this.vector.available;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.pool.end();
    } finally {
      INDEX_CACHE.delete(this.cacheKey);
    }
  }

  private async initialize(): Promise<void> {
    await this.ensureSchema();
    await this.refreshSessionMessageColumns();
    await this.refreshStatusSnapshot();
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  private async ensureSchema(): Promise<void> {
    await this.assertTableExists(this.tables.sessions);
    await this.assertTableExists(this.tables.sessionMessages);
    await this.assertTableExists(this.tables.files);
    await this.assertTableExists(this.tables.chunks);
    await this.assertTableExists(this.tables.embeddingCache);
    await this.assertTableExists(this.tables.indexState);

    if (!this.vector.enabled) {
      this.vector.available = false;
      return;
    }
    try {
      const ext = await this.query(
        "SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector' LIMIT 1",
      );
      this.vector.available = ext.rows.length > 0;
      if (!this.vector.available) {
        this.vector.loadError = "pgvector extension is not installed";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.vector.available = false;
      this.vector.loadError = message;
      log.warn(`failed to probe pgvector extension: ${message}`);
    }
  }

  private async assertTableExists(tableName: string): Promise<void> {
    const result = await this.query(
      `SELECT 1\n` +
        `FROM information_schema.tables\n` +
        `WHERE table_schema = $1 AND table_name = $2\n` +
        `LIMIT 1`,
      [this.schemaName, tableName],
    );
    if (result.rows.length > 0) {
      return;
    }
    throw new Error(
      `missing Postgres table ${this.schemaName}.${tableName}; apply enterprise migrations before enabling postgres memory search`,
    );
  }

  private async refreshSessionMessageColumns(): Promise<void> {
    try {
      const result = await this.query(
        `SELECT column_name\n` +
          `FROM information_schema.columns\n` +
          `WHERE table_schema = $1 AND table_name = $2`,
        [this.schemaName, this.tables.sessionMessages],
      );
      const cols = new Set(
        result.rows
          .map((row) => row.column_name)
          .filter((value): value is string => typeof value === "string"),
      );
      this.sessionMessageColumns = {
        hasMessageJson: cols.has("message_json"),
        hasRawJson: cols.has("raw_json"),
        hasTextRedacted: cols.has("text_redacted"),
        hasRole: cols.has("role"),
        hasId: cols.has("id"),
        hasSeq: cols.has("seq"),
        hasCreatedAt: cols.has("created_at"),
      };
    } catch {
      this.sessionMessageColumns = {
        hasMessageJson: true,
        hasRawJson: false,
        hasTextRedacted: false,
        hasRole: false,
        hasId: true,
        hasSeq: false,
        hasCreatedAt: true,
      };
    }
  }

  private async runSync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    const progress = params?.progress ? this.createSyncProgress(params.progress) : undefined;
    this.dirty = true;
    const meta = await this.readMeta();
    const needsFullReindex =
      params?.force ||
      !meta ||
      meta.model !== this.provider.model ||
      meta.provider !== this.provider.id ||
      meta.providerKey !== this.providerKey ||
      meta.chunkTokens !== this.settings.chunking.tokens ||
      meta.chunkOverlap !== this.settings.chunking.overlap;

    log.info(
      `[MemorySync] Starting sync (force=${params?.force}, reason=${params?.reason}). Needs full reindex: ${needsFullReindex}`,
    );

    if (needsFullReindex) {
      log.info("[MemorySync] Resetting index due to configuration change or force flag.");
      await this.resetIndex();
    }
    if (this.sources.has("memory")) {
      log.info("[MemorySync] Syncing memory files...");
      await this.syncMemoryFiles(needsFullReindex, progress);
    }
    if (this.sources.has("sessions")) {
      log.info("[MemorySync] Syncing session rows...");
      await this.syncSessionRows(needsFullReindex, progress);
    }
    await this.writeMeta({
      model: this.provider.model,
      provider: this.provider.id,
      providerKey: this.providerKey,
      chunkTokens: this.settings.chunking.tokens,
      chunkOverlap: this.settings.chunking.overlap,
      vectorDims: this.vector.dims,
    });
    await this.pruneEmbeddingCacheIfNeeded();
    this.lastSyncAt = Date.now();
    this.dirty = false;
    await this.refreshStatusSnapshot();
    log.info("[MemorySync] Sync completed successfully.");
  }

  private createSyncProgress(onProgress: (update: MemorySyncProgressUpdate) => void): {
    completed: number;
    total: number;
    label?: string;
    report: (update: { completed: number; total: number; label?: string }) => void;
  } {
    const state: {
      completed: number;
      total: number;
      label?: string;
      report: (update: { completed: number; total: number; label?: string }) => void;
    } = {
      completed: 0,
      total: 0,
      label: undefined,
      report: (update) => {
        if (update.label) {
          state.label = update.label;
        }
        const label =
          update.total > 0 && state.label
            ? `${state.label} ${update.completed}/${update.total}`
            : state.label;
        onProgress({
          completed: update.completed,
          total: update.total,
          label,
        });
      },
    };
    return state;
  }

  private async syncMemoryFiles(
    needsFullReindex: boolean,
    progress?: {
      completed: number;
      total: number;
      label?: string;
      report: (update: { completed: number; total: number; label?: string }) => void;
    },
  ): Promise<void> {
    const files = await listMemoryFiles(this.workspaceDir, this.settings.extraPaths);
    log.info(`[MemorySync] Found ${files.length} memory files to process.`);
    const fileEntries = await Promise.all(
      files.map(async (file) => await this.buildMemoryEntry(file)),
    );
    const active = new Set<string>();
    if (progress) {
      progress.total += fileEntries.length;
      progress.report({
        completed: progress.completed,
        total: progress.total,
        label: "Indexing memory files…",
      });
    }
    let indexedCount = 0;
    const tasks = fileEntries.map((entry) => async () => {
      active.add(entry.path);
      const shouldIndex = await this.shouldIndexSourceEntry({
        source: "memory",
        path: entry.path,
        hash: entry.hash,
        needsFullReindex,
      });
      if (shouldIndex) {
        log.debug(`[MemorySync] Indexing file: ${entry.path}`);
        await this.indexSourceEntry({
          source: "memory",
          path: entry.path,
          hash: entry.hash,
          mtimeMs: entry.mtimeMs,
          size: entry.size,
          content: await fs.readFile(entry.absPath, "utf-8"),
        });
        indexedCount++;
      }
      if (progress) {
        progress.completed += 1;
        progress.report({ completed: progress.completed, total: progress.total });
      }
    });
    await this.runWithConcurrency(tasks, EMBEDDING_INDEX_CONCURRENCY);
    log.info(`[MemorySync] Indexed ${indexedCount} memory files.`);
    await this.cleanupStaleSourceEntries("memory", active);
  }

  private async syncSessionRows(
    needsFullReindex: boolean,
    progress?: {
      completed: number;
      total: number;
      label?: string;
      report: (update: { completed: number; total: number; label?: string }) => void;
    },
  ): Promise<void> {
    const entries = await this.listSessionEntries();
    const active = new Set<string>();
    if (progress) {
      progress.total += entries.length;
      progress.report({
        completed: progress.completed,
        total: progress.total,
        label: "Indexing session transcripts…",
      });
    }
    const tasks = entries.map((entry) => async () => {
      active.add(entry.path);
      const shouldIndex = await this.shouldIndexSourceEntry({
        source: "sessions",
        path: entry.path,
        hash: entry.hash,
        needsFullReindex,
      });
      if (shouldIndex) {
        await this.indexSourceEntry(entry);
      }
      if (progress) {
        progress.completed += 1;
        progress.report({ completed: progress.completed, total: progress.total });
      }
    });
    await this.runWithConcurrency(tasks, EMBEDDING_INDEX_CONCURRENCY);
    await this.cleanupStaleSourceEntries("sessions", active);
  }

  private async buildMemoryEntry(absPath: string): Promise<MemoryFileEntry> {
    return await buildFileEntry(absPath, this.workspaceDir);
  }

  private async listSessionEntries(): Promise<SourceEntry[]> {
    const sessionIds = await this.listSessionIds();
    const entries: SourceEntry[] = [];
    for (const sessionId of sessionIds) {
      const entry = await this.buildSessionEntry(sessionId);
      if (entry) {
        entries.push(entry);
      }
    }
    return entries;
  }

  private async listSessionIds(): Promise<string[]> {
    const out = new Set<string>();
    try {
      const pattern = `agent:${this.agentId}:%`;
      const result = await this.query(
        `SELECT key, data FROM ${this.qualified.sessions} WHERE key LIKE $1`,
        [pattern],
      );
      for (const row of result.rows) {
        const data = row.data;
        if (!data || typeof data !== "object") {
          continue;
        }
        const record = data as Record<string, unknown>;
        const id =
          (typeof record.id === "string" && record.id) ||
          (typeof record.sessionId === "string" && record.sessionId) ||
          (typeof record.session_id === "string" && record.session_id) ||
          "";
        if (id) {
          out.add(id);
        }
      }
    } catch {}
    if (out.size > 0) {
      return Array.from(out);
    }
    try {
      const result = await this.query(
        `SELECT session_id FROM ${this.qualified.sessions} WHERE tenant_id = $1 AND agent_id = $2`,
        [this.tenantId, this.agentId],
      );
      for (const row of result.rows) {
        if (typeof row.session_id === "string" && row.session_id) {
          out.add(row.session_id);
        }
      }
    } catch {}
    return Array.from(out);
  }

  private async buildSessionEntry(sessionId: string): Promise<SourceEntry | null> {
    const rows = await this.loadSessionMessages(sessionId);
    if (rows.length === 0) {
      return null;
    }
    const lines: string[] = [];
    let mtimeMs = 0;
    for (const row of rows) {
      mtimeMs = Math.max(mtimeMs, row.createdAtMs);
      if (!row.text) {
        continue;
      }
      const safeText = redactSensitiveText(row.text, { mode: "tools" });
      const label = row.role === "assistant" ? "Assistant" : "User";
      lines.push(`${label}: ${safeText}`);
    }
    const content = lines.join("\n");
    const pathToken = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_");
    const relPath = `sessions/${pathToken || "session"}`;
    return {
      source: "sessions",
      path: relPath,
      hash: hashText(content),
      mtimeMs: mtimeMs || Date.now(),
      size: Buffer.byteLength(content, "utf-8"),
      content,
    };
  }

  private async loadSessionMessages(sessionId: string): Promise<
    Array<{
      role: "user" | "assistant";
      text: string;
      createdAtMs: number;
    }>
  > {
    const columns = this.sessionMessageColumns;
    const orderBy = columns.hasSeq
      ? "seq ASC"
      : columns.hasId
        ? "id ASC"
        : columns.hasCreatedAt
          ? "created_at ASC"
          : "1 ASC";
    if (columns.hasMessageJson) {
      const createdAtSelect = columns.hasCreatedAt
        ? "created_at"
        : "NULL::timestamptz AS created_at";
      const result = await this.query(
        `SELECT message_json, ${createdAtSelect}\n` +
          `FROM ${this.qualified.sessionMessages}\n` +
          `WHERE session_id = $1 AND message_json IS NOT NULL\n` +
          `ORDER BY ${orderBy}`,
        [sessionId],
      );
      const out: Array<{ role: "user" | "assistant"; text: string; createdAtMs: number }> = [];
      for (const row of result.rows) {
        const message = row.message_json;
        if (!message || typeof message !== "object") {
          continue;
        }
        const role = (message as { role?: unknown }).role;
        if (role !== "user" && role !== "assistant") {
          continue;
        }
        const text = extractSessionText((message as { content?: unknown }).content);
        if (!text) {
          continue;
        }
        out.push({
          role,
          text,
          createdAtMs: toMs(row.created_at),
        });
      }
      return out;
    }
    if (columns.hasTextRedacted && columns.hasRole) {
      const createdAtSelect = columns.hasCreatedAt
        ? "created_at"
        : "NULL::timestamptz AS created_at";
      const result = await this.query(
        `SELECT role, text_redacted, ${createdAtSelect}\n` +
          `FROM ${this.qualified.sessionMessages}\n` +
          `WHERE session_id = $1\n` +
          `ORDER BY ${orderBy}`,
        [sessionId],
      );
      return result.rows
        .map((row) => ({
          role: row.role,
          text: row.text_redacted,
          createdAtMs: toMs(row.created_at),
        }))
        .filter(
          (
            row,
          ): row is {
            role: "user" | "assistant";
            text: string;
            createdAtMs: number;
          } =>
            (row.role === "user" || row.role === "assistant") &&
            typeof row.text === "string" &&
            row.text.trim().length > 0,
        )
        .map((row) => ({
          role: row.role,
          text: row.text.trim(),
          createdAtMs: row.createdAtMs,
        }));
    }
    if (columns.hasRawJson) {
      const createdAtSelect = columns.hasCreatedAt
        ? "created_at"
        : "NULL::timestamptz AS created_at";
      const result = await this.query(
        `SELECT raw_json, ${createdAtSelect}\n` +
          `FROM ${this.qualified.sessionMessages}\n` +
          `WHERE session_id = $1 AND raw_json IS NOT NULL\n` +
          `ORDER BY ${orderBy}`,
        [sessionId],
      );
      const out: Array<{ role: "user" | "assistant"; text: string; createdAtMs: number }> = [];
      for (const row of result.rows) {
        const raw = row.raw_json;
        if (!raw || typeof raw !== "object") {
          continue;
        }
        const record = raw as Record<string, unknown>;
        if (record.type !== "message") {
          continue;
        }
        const message = record.message;
        if (!message || typeof message !== "object") {
          continue;
        }
        const role = (message as { role?: unknown }).role;
        if (role !== "user" && role !== "assistant") {
          continue;
        }
        const text = extractSessionText((message as { content?: unknown }).content);
        if (!text) {
          continue;
        }
        out.push({
          role,
          text,
          createdAtMs: toMs(row.created_at),
        });
      }
      return out;
    }
    return [];
  }

  private async shouldIndexSourceEntry(params: {
    source: MemorySource;
    path: string;
    hash: string;
    needsFullReindex: boolean;
  }): Promise<boolean> {
    if (params.needsFullReindex) {
      return true;
    }
    const result = await this.query(
      `SELECT hash FROM ${this.qualified.files}\n` +
        `WHERE tenant_id = $1 AND agent_id = $2 AND source = $3 AND path = $4`,
      [this.tenantId, this.agentId, params.source, params.path],
    );
    const existing = result.rows[0]?.hash;
    return typeof existing !== "string" || existing !== params.hash;
  }

  private async cleanupStaleSourceEntries(
    source: MemorySource,
    activePaths: Set<string>,
  ): Promise<void> {
    const result = await this.query(
      `SELECT path FROM ${this.qualified.files}\n` +
        `WHERE tenant_id = $1 AND agent_id = $2 AND source = $3`,
      [this.tenantId, this.agentId, source],
    );
    for (const row of result.rows) {
      const rowPath = row.path;
      if (typeof rowPath !== "string" || activePaths.has(rowPath)) {
        continue;
      }
      await this.query(
        `DELETE FROM ${this.qualified.files}\n` +
          `WHERE tenant_id = $1 AND agent_id = $2 AND source = $3 AND path = $4`,
        [this.tenantId, this.agentId, source, rowPath],
      );
      await this.query(
        `DELETE FROM ${this.qualified.chunks}\n` +
          `WHERE tenant_id = $1 AND agent_id = $2 AND source = $3 AND path = $4`,
        [this.tenantId, this.agentId, source, rowPath],
      );
    }
  }

  private async indexSourceEntry(entry: SourceEntry): Promise<void> {
    const chunks = chunkMarkdown(entry.content, this.settings.chunking).filter(
      (chunk) => chunk.text.trim().length > 0,
    );
    const embeddings = await this.embedChunksInBatches(chunks);
    const sample = embeddings.find((embedding) => embedding.length > 0);
    if (sample && sample.length > 0) {
      this.vector.dims = sample.length;
    }
    await this.query(
      `DELETE FROM ${this.qualified.chunks}\n` +
        `WHERE tenant_id = $1 AND agent_id = $2 AND source = $3 AND path = $4`,
      [this.tenantId, this.agentId, entry.source, entry.path],
    );
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const embedding = embeddings[i] ?? [];
      const embeddingParam = this.serializeEmbedding(embedding);
      const chunkId = hashText(
        `${entry.source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`,
      );
      await this.query(
        `INSERT INTO ${this.qualified.chunks}\n` +
          `  (tenant_id, agent_id, chunk_id, source, path, start_line, end_line, hash,\n` +
          `   provider, model, provider_key, text_raw, text_redacted, embedding, embedding_dims, updated_at)\n` +
          `VALUES\n` +
          `  ($1, $2, $3, $4, $5, $6, $7, $8,\n` +
          `   $9, $10, $11, $12, $13, $14::${this.embeddingSqlType()}, $15, NOW())\n` +
          `ON CONFLICT (tenant_id, agent_id, chunk_id) DO UPDATE SET\n` +
          `  source = EXCLUDED.source,\n` +
          `  path = EXCLUDED.path,\n` +
          `  start_line = EXCLUDED.start_line,\n` +
          `  end_line = EXCLUDED.end_line,\n` +
          `  hash = EXCLUDED.hash,\n` +
          `  provider = EXCLUDED.provider,\n` +
          `  model = EXCLUDED.model,\n` +
          `  provider_key = EXCLUDED.provider_key,\n` +
          `  text_raw = EXCLUDED.text_raw,\n` +
          `  text_redacted = EXCLUDED.text_redacted,\n` +
          `  embedding = EXCLUDED.embedding,\n` +
          `  embedding_dims = EXCLUDED.embedding_dims,\n` +
          `  updated_at = NOW()`,
        [
          this.tenantId,
          this.agentId,
          chunkId,
          entry.source,
          entry.path,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          this.provider.id,
          this.provider.model,
          this.providerKey,
          chunk.text,
          redactSensitiveText(chunk.text, { mode: "tools" }),
          embeddingParam,
          embedding.length,
        ],
      );
    }
    await this.query(
      `INSERT INTO ${this.qualified.files}\n` +
        `  (tenant_id, agent_id, source, path, hash, mtime_ms, size_bytes, updated_at)\n` +
        `VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())\n` +
        `ON CONFLICT (tenant_id, agent_id, source, path) DO UPDATE SET\n` +
        `  hash = EXCLUDED.hash,\n` +
        `  mtime_ms = EXCLUDED.mtime_ms,\n` +
        `  size_bytes = EXCLUDED.size_bytes,\n` +
        `  updated_at = NOW()`,
      [
        this.tenantId,
        this.agentId,
        entry.source,
        entry.path,
        entry.hash,
        entry.mtimeMs,
        entry.size,
      ],
    );
  }

  private async searchVector(
    query: string,
    queryVec: number[],
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    if (queryVec.length === 0 || limit <= 0) {
      return [];
    }
    const sources = Array.from(this.sources);
    if (sources.length === 0) {
      return [];
    }
    if (this.vector.enabled && this.vector.available) {
      try {
        const result = await this.query(
          `SELECT chunk_id AS id, path, start_line, end_line, source, text_redacted,\n` +
            `       (1 - (embedding <=> $7::vector)) AS score\n` +
            `FROM ${this.qualified.chunks}\n` +
            `WHERE tenant_id = $1\n` +
            `  AND agent_id = $2\n` +
            `  AND provider = $3\n` +
            `  AND model = $4\n` +
            `  AND provider_key = $5\n` +
            `  AND source = ANY($6::text[])\n` +
            `  AND embedding IS NOT NULL\n` +
            `ORDER BY embedding <=> $7::vector\n` +
            `LIMIT $8`,
          [
            this.tenantId,
            this.agentId,
            this.provider.id,
            this.provider.model,
            this.providerKey,
            sources,
            toVectorLiteral(queryVec),
            limit,
          ],
        );
        return result.rows.map((row) => ({
          id: String(row.id ?? ""),
          path: String(row.path ?? ""),
          startLine: toCount(row.start_line),
          endLine: toCount(row.end_line),
          source: (row.source as MemorySource) ?? "memory",
          score: typeof row.score === "number" ? row.score : Number(row.score ?? 0),
          snippet: truncateUtf16Safe(String(row.text_redacted ?? ""), SNIPPET_MAX_CHARS),
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.vector.available = false;
        this.vector.loadError = message;
      }
    }
    const result = await this.query(
      `SELECT chunk_id AS id, path, start_line, end_line, source, text_redacted,\n` +
        `       embedding${this.vector.available ? "::text" : ""} AS embedding\n` +
        `FROM ${this.qualified.chunks}\n` +
        `WHERE tenant_id = $1\n` +
        `  AND agent_id = $2\n` +
        `  AND provider = $3\n` +
        `  AND model = $4\n` +
        `  AND provider_key = $5\n` +
        `  AND source = ANY($6::text[])\n` +
        `  AND embedding IS NOT NULL\n` +
        `LIMIT $7`,
      [
        this.tenantId,
        this.agentId,
        this.provider.id,
        this.provider.model,
        this.providerKey,
        sources,
        limit * 4,
      ],
    );
    return result.rows
      .map((row) => {
        const embedding = parseArrayLikeEmbedding(row.embedding);
        return {
          id: String(row.id ?? ""),
          path: String(row.path ?? ""),
          startLine: toCount(row.start_line),
          endLine: toCount(row.end_line),
          source: (row.source as MemorySource) ?? "memory",
          score: cosineSimilarity(queryVec, embedding),
          snippet: truncateUtf16Safe(String(row.text_redacted ?? ""), SNIPPET_MAX_CHARS),
        };
      })
      .filter((row) => Number.isFinite(row.score))
      .toSorted((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private async searchKeyword(
    query: string,
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string; textScore: number }>> {
    if (!this.fts.enabled || !this.fts.available || limit <= 0) {
      return [];
    }
    if (!buildFtsQuery(query)) {
      return [];
    }
    const sources = Array.from(this.sources);
    if (sources.length === 0) {
      return [];
    }
    const result = await this.query(
      `SELECT chunk_id AS id, path, start_line, end_line, source, text_redacted,\n` +
        `       ts_rank_cd(search_tsv, plainto_tsquery('simple', $7)) AS rank\n` +
        `FROM ${this.qualified.chunks}\n` +
        `WHERE tenant_id = $1\n` +
        `  AND agent_id = $2\n` +
        `  AND provider = $3\n` +
        `  AND model = $4\n` +
        `  AND provider_key = $5\n` +
        `  AND source = ANY($6::text[])\n` +
        `  AND search_tsv @@ plainto_tsquery('simple', $7)\n` +
        `ORDER BY rank DESC\n` +
        `LIMIT $8`,
      [
        this.tenantId,
        this.agentId,
        this.provider.id,
        this.provider.model,
        this.providerKey,
        sources,
        query,
        limit,
      ],
    );
    return result.rows.map((row) => {
      const rank = typeof row.rank === "number" ? row.rank : Number(row.rank ?? 0);
      const textScore = rank > 0 ? rank / (1 + rank) : 0;
      return {
        id: String(row.id ?? ""),
        path: String(row.path ?? ""),
        startLine: toCount(row.start_line),
        endLine: toCount(row.end_line),
        source: (row.source as MemorySource) ?? "memory",
        score: textScore,
        textScore,
        snippet: truncateUtf16Safe(String(row.text_redacted ?? ""), SNIPPET_MAX_CHARS),
      };
    });
  }

  private async readMeta(): Promise<MemoryIndexMeta | null> {
    const result = await this.query(
      `SELECT provider, model, provider_key, chunk_tokens, chunk_overlap, embedding_dims, updated_at\n` +
        `FROM ${this.qualified.indexState}\n` +
        `WHERE tenant_id = $1 AND agent_id = $2`,
      [this.tenantId, this.agentId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      provider: String(row.provider ?? ""),
      model: String(row.model ?? ""),
      providerKey: typeof row.provider_key === "string" ? row.provider_key : undefined,
      chunkTokens: toCount(row.chunk_tokens),
      chunkOverlap: toCount(row.chunk_overlap),
      vectorDims:
        row.embedding_dims === null || row.embedding_dims === undefined
          ? undefined
          : toCount(row.embedding_dims),
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : undefined,
    };
  }

  private async writeMeta(meta: MemoryIndexMeta): Promise<void> {
    await this.query(
      `INSERT INTO ${this.qualified.indexState}\n` +
        `  (tenant_id, agent_id, provider, model, provider_key, chunk_tokens, chunk_overlap, embedding_dims, updated_at)\n` +
        `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())\n` +
        `ON CONFLICT (tenant_id, agent_id) DO UPDATE SET\n` +
        `  provider = EXCLUDED.provider,\n` +
        `  model = EXCLUDED.model,\n` +
        `  provider_key = EXCLUDED.provider_key,\n` +
        `  chunk_tokens = EXCLUDED.chunk_tokens,\n` +
        `  chunk_overlap = EXCLUDED.chunk_overlap,\n` +
        `  embedding_dims = EXCLUDED.embedding_dims,\n` +
        `  updated_at = NOW()`,
      [
        this.tenantId,
        this.agentId,
        meta.provider,
        meta.model,
        meta.providerKey ?? "",
        meta.chunkTokens,
        meta.chunkOverlap,
        meta.vectorDims ?? null,
      ],
    );
  }

  private async resetIndex(): Promise<void> {
    await this.query(`DELETE FROM ${this.qualified.files} WHERE tenant_id = $1 AND agent_id = $2`, [
      this.tenantId,
      this.agentId,
    ]);
    await this.query(
      `DELETE FROM ${this.qualified.chunks} WHERE tenant_id = $1 AND agent_id = $2`,
      [this.tenantId, this.agentId],
    );
  }

  private estimateEmbeddingTokens(text: string): number {
    if (!text) {
      return 0;
    }
    return Math.ceil(text.length / EMBEDDING_APPROX_CHARS_PER_TOKEN);
  }

  private buildEmbeddingBatches(chunks: MemoryChunk[]): MemoryChunk[][] {
    const batches: MemoryChunk[][] = [];
    let current: MemoryChunk[] = [];
    let currentTokens = 0;
    for (const chunk of chunks) {
      const estimate = this.estimateEmbeddingTokens(chunk.text);
      const wouldExceed =
        current.length > 0 && currentTokens + estimate > EMBEDDING_BATCH_MAX_TOKENS;
      if (wouldExceed) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      if (current.length === 0 && estimate > EMBEDDING_BATCH_MAX_TOKENS) {
        batches.push([chunk]);
        continue;
      }
      current.push(chunk);
      currentTokens += estimate;
    }
    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  private async embedChunksInBatches(chunks: MemoryChunk[]): Promise<number[][]> {
    if (chunks.length === 0) {
      return [];
    }
    const cached = await this.loadEmbeddingCache(chunks.map((chunk) => chunk.hash));
    const embeddings: number[][] = Array.from({ length: chunks.length }, () => []);
    const missing: Array<{ index: number; chunk: MemoryChunk }> = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const hit = chunk?.hash ? cached.get(chunk.hash) : undefined;
      if (hit && hit.length > 0) {
        embeddings[i] = hit;
      } else if (chunk) {
        missing.push({ index: i, chunk });
      }
    }
    if (missing.length === 0) {
      return embeddings;
    }
    const batches = this.buildEmbeddingBatches(missing.map((item) => item.chunk));
    const toCache: Array<{ hash: string; embedding: number[] }> = [];
    let cursor = 0;
    for (const batch of batches) {
      const batchEmbeddings = await this.embedBatchWithRetry(batch.map((chunk) => chunk.text));
      for (let i = 0; i < batch.length; i += 1) {
        const mapping = missing[cursor + i];
        const embedding = batchEmbeddings[i] ?? [];
        if (!mapping) {
          continue;
        }
        embeddings[mapping.index] = embedding;
        toCache.push({ hash: mapping.chunk.hash, embedding });
      }
      cursor += batch.length;
    }
    await this.upsertEmbeddingCache(toCache);
    return embeddings;
  }

  private async loadEmbeddingCache(hashes: string[]): Promise<Map<string, number[]>> {
    if (!this.cache.enabled || hashes.length === 0) {
      return new Map();
    }
    const unique = Array.from(new Set(hashes.filter(Boolean)));
    if (unique.length === 0) {
      return new Map();
    }
    const out = new Map<string, number[]>();
    const batchSize = 400;
    for (let start = 0; start < unique.length; start += batchSize) {
      const slice = unique.slice(start, start + batchSize);
      const result = await this.query(
        `SELECT hash, embedding${this.vector.available ? "::text" : ""} AS embedding\n` +
          `FROM ${this.qualified.embeddingCache}\n` +
          `WHERE tenant_id = $1\n` +
          `  AND agent_id = $2\n` +
          `  AND provider = $3\n` +
          `  AND model = $4\n` +
          `  AND provider_key = $5\n` +
          `  AND hash = ANY($6::text[])`,
        [
          this.tenantId,
          this.agentId,
          this.provider.id,
          this.provider.model,
          this.providerKey,
          slice,
        ],
      );
      for (const row of result.rows) {
        if (typeof row.hash !== "string") {
          continue;
        }
        out.set(row.hash, parseArrayLikeEmbedding(row.embedding));
      }
    }
    return out;
  }

  private async upsertEmbeddingCache(entries: Array<{ hash: string; embedding: number[] }>) {
    if (!this.cache.enabled || entries.length === 0) {
      return;
    }
    for (const entry of entries) {
      if (!entry.hash || entry.embedding.length === 0) {
        continue;
      }
      await this.query(
        `INSERT INTO ${this.qualified.embeddingCache}\n` +
          `  (tenant_id, agent_id, provider, model, provider_key, hash, embedding, embedding_dims, updated_at)\n` +
          `VALUES ($1, $2, $3, $4, $5, $6, $7::${this.embeddingSqlType()}, $8, NOW())\n` +
          `ON CONFLICT (tenant_id, agent_id, provider, model, provider_key, hash) DO UPDATE SET\n` +
          `  embedding = EXCLUDED.embedding,\n` +
          `  embedding_dims = EXCLUDED.embedding_dims,\n` +
          `  updated_at = NOW()`,
        [
          this.tenantId,
          this.agentId,
          this.provider.id,
          this.provider.model,
          this.providerKey,
          entry.hash,
          this.serializeEmbedding(entry.embedding),
          entry.embedding.length,
        ],
      );
    }
  }

  private async pruneEmbeddingCacheIfNeeded(): Promise<void> {
    if (!this.cache.enabled || !this.cache.maxEntries || this.cache.maxEntries <= 0) {
      return;
    }
    const countResult = await this.query(
      `SELECT COUNT(*)::bigint AS count FROM ${this.qualified.embeddingCache}\n` +
        `WHERE tenant_id = $1 AND agent_id = $2`,
      [this.tenantId, this.agentId],
    );
    const count = toCount(countResult.rows[0]?.count);
    if (count <= this.cache.maxEntries) {
      return;
    }
    const excess = count - this.cache.maxEntries;
    await this.query(
      `DELETE FROM ${this.qualified.embeddingCache}\n` +
        `WHERE ctid IN (\n` +
        `  SELECT ctid FROM ${this.qualified.embeddingCache}\n` +
        `  WHERE tenant_id = $1 AND agent_id = $2\n` +
        `  ORDER BY updated_at ASC\n` +
        `  LIMIT $3\n` +
        `)`,
      [this.tenantId, this.agentId, excess],
    );
  }

  private serializeEmbedding(embedding: number[]): string | number[] | null {
    if (!embedding.length) {
      return null;
    }
    if (this.vector.available) {
      return toVectorLiteral(embedding);
    }
    return embedding;
  }

  private embeddingSqlType(): string {
    return this.vector.available ? "vector" : "double precision[]";
  }

  private computeProviderKey(): string {
    return hashText(JSON.stringify({ provider: this.provider.id, model: this.provider.model }));
  }

  private async embedBatchWithRetry(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    let attempt = 0;
    let delayMs = EMBEDDING_RETRY_BASE_DELAY_MS;
    while (true) {
      try {
        const timeoutMs = this.resolveEmbeddingTimeout("batch");
        return await this.withTimeout(
          this.provider.embedBatch(texts),
          timeoutMs,
          `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.isRetryableEmbeddingError(message) || attempt >= EMBEDDING_RETRY_MAX_ATTEMPTS) {
          throw err;
        }
        const waitMs = Math.min(
          EMBEDDING_RETRY_MAX_DELAY_MS,
          Math.round(delayMs * (1 + Math.random() * 0.2)),
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        delayMs *= 2;
        attempt += 1;
      }
    }
  }

  private async embedQueryWithTimeout(text: string): Promise<number[]> {
    const timeoutMs = this.resolveEmbeddingTimeout("query");
    return await this.withTimeout(
      this.provider.embedQuery(text),
      timeoutMs,
      `memory embeddings query timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
  }

  private resolveEmbeddingTimeout(kind: "query" | "batch"): number {
    const isLocal = this.provider.id === "local";
    if (kind === "query") {
      return isLocal ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;
    }
    return isLocal ? EMBEDDING_BATCH_TIMEOUT_LOCAL_MS : EMBEDDING_BATCH_TIMEOUT_REMOTE_MS;
  }

  private isRetryableEmbeddingError(message: string): boolean {
    return /(rate[_ ]limit|too many requests|429|resource has been exhausted|5\d\d|cloudflare)/i.test(
      message,
    );
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return await promise;
    }
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
      return (await Promise.race([promise, timeoutPromise])) as T;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async refreshStatusSnapshot(): Promise<void> {
    const sources = Array.from(this.sources);
    const sourceCounts = new Map<MemorySource, { files: number; chunks: number }>();
    for (const source of sources) {
      sourceCounts.set(source, { files: 0, chunks: 0 });
    }
    const fileCounts = await this.query(
      `SELECT source, COUNT(*)::bigint AS count\n` +
        `FROM ${this.qualified.files}\n` +
        `WHERE tenant_id = $1 AND agent_id = $2 AND source = ANY($3::text[])\n` +
        `GROUP BY source`,
      [this.tenantId, this.agentId, sources],
    );
    for (const row of fileCounts.rows) {
      if (row.source === "memory" || row.source === "sessions") {
        const existing = sourceCounts.get(row.source) ?? { files: 0, chunks: 0 };
        existing.files = toCount(row.count);
        sourceCounts.set(row.source, existing);
      }
    }
    const chunkCounts = await this.query(
      `SELECT source, COUNT(*)::bigint AS count\n` +
        `FROM ${this.qualified.chunks}\n` +
        `WHERE tenant_id = $1 AND agent_id = $2 AND source = ANY($3::text[])\n` +
        `GROUP BY source`,
      [this.tenantId, this.agentId, sources],
    );
    for (const row of chunkCounts.rows) {
      if (row.source === "memory" || row.source === "sessions") {
        const existing = sourceCounts.get(row.source) ?? { files: 0, chunks: 0 };
        existing.chunks = toCount(row.count);
        sourceCounts.set(row.source, existing);
      }
    }
    const totalFiles = Array.from(sourceCounts.values()).reduce((sum, item) => sum + item.files, 0);
    const totalChunks = Array.from(sourceCounts.values()).reduce(
      (sum, item) => sum + item.chunks,
      0,
    );
    const cacheCount = this.cache.enabled
      ? await this.query(
          `SELECT COUNT(*)::bigint AS count\n` +
            `FROM ${this.qualified.embeddingCache}\n` +
            `WHERE tenant_id = $1 AND agent_id = $2`,
          [this.tenantId, this.agentId],
        )
      : { rows: [{ count: 0 }], rowCount: 1 };
    let vectorIndexReady = false;
    if (this.vector.available) {
      try {
        const idx = await this.query(
          `SELECT 1\n` +
            `FROM pg_indexes\n` +
            `WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
          [this.schemaName, this.tables.chunks, this.indexNames.chunksEmbedding],
        );
        vectorIndexReady = idx.rows.length > 0;
      } catch {}
    }
    this.statusSnapshot = {
      backend: "builtin",
      provider: this.provider.id,
      model: this.provider.model,
      requestedProvider: this.requestedProvider,
      files: totalFiles,
      chunks: totalChunks,
      dirty: this.dirty,
      workspaceDir: this.workspaceDir,
      dbPath: safeConnectionLabel(this.postgresUrl),
      extraPaths: this.settings.extraPaths,
      sources,
      sourceCounts: sources.map((source) => ({
        source,
        ...(sourceCounts.get(source) ?? { files: 0, chunks: 0 }),
      })),
      cache: this.cache.enabled
        ? {
            enabled: true,
            entries: toCount(cacheCount.rows[0]?.count),
            maxEntries: this.cache.maxEntries,
          }
        : { enabled: false, maxEntries: this.cache.maxEntries },
      fts: {
        enabled: this.fts.enabled,
        available: this.fts.available,
        error: this.fts.loadError,
      },
      fallback: this.fallbackReason
        ? { from: this.fallbackFrom ?? "local", reason: this.fallbackReason }
        : undefined,
      vector: {
        enabled: this.vector.enabled,
        available: this.vector.available,
        loadError: this.vector.loadError,
        dims: this.vector.dims,
      },
      custom: {
        postgres: {
          tenantId: this.tenantId,
          schema: this.schemaName,
          tables: this.tables,
          vectorIndexReady,
          lastSyncAt: this.lastSyncAt,
        },
      },
    };
  }

  private async runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
    if (tasks.length === 0) {
      return [];
    }
    const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
    const results: T[] = Array.from({ length: tasks.length });
    let next = 0;
    let firstError: unknown = null;
    const workers = Array.from({ length: resolvedLimit }, async () => {
      while (true) {
        if (firstError) {
          return;
        }
        const index = next;
        next += 1;
        if (index >= tasks.length) {
          return;
        }
        try {
          results[index] = await tasks[index]();
        } catch (err) {
          firstError = err;
          return;
        }
      }
    });
    await Promise.allSettled(workers);
    if (firstError) {
      throw firstError;
    }
    return results;
  }

  private async query(sql: string, params: unknown[] = []): Promise<PgQueryResultLike> {
    return await this.pool.query(sql, params);
  }
}
