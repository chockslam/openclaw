import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
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
} from "../interfaces/storage.js";

const require = createRequire(import.meta.url);

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_TENANT_SLUG = "default";
const DEFAULT_SCHEMA = "public";
const DEFAULT_AGENT_ID = "main";
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_ID_LINE_RE = /^\s*\[message_id:\s*([^\]\r\n]+)\]\s*$/im;
const INBOUND_HEADER_RE = /^\s*\[([A-Za-z0-9_-]+)[^\]]*\bid:([^\]\s]+)[^\]]*\]/i;

type PgQueryRow = Record<string, unknown>;
type PgQueryResult = {
  rows: PgQueryRow[];
  rowCount?: number | null;
};

type PgQueryRunner = {
  query: (sql: string, params?: unknown[]) => Promise<PgQueryResult>;
};

type PgPoolClient = PgQueryRunner & {
  release: () => void;
};

type PgPoolLike = PgQueryRunner & {
  connect: () => Promise<PgPoolClient>;
  end?: () => Promise<void>;
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
};

type PgPoolCtor = new (config: Record<string, unknown>) => PgPoolLike;

function quoteIdent(value: string, kind: string): string {
  if (!SAFE_IDENT_RE.test(value)) {
    throw new Error(`invalid ${kind}: ${value}`);
  }
  return `"${value}"`;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toSafeObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toDate(value: unknown, fallbackMs: number): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date(fallbackMs);
}

function toMillis(value: unknown): number {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getTime();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function parseAgentIdFromSessionKey(key: string): string {
  const parts = key.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    const parsed = asTrimmedString(parts[1]);
    if (parsed) {
      return parsed;
    }
  }
  return DEFAULT_AGENT_ID;
}

type TranscriptMessage = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string; name?: string }>;
  text?: string;
  toolName?: string;
  tool_name?: string;
};

function extractMessageText(message: TranscriptMessage | undefined): string | null {
  if (!message) {
    return null;
  }
  if (typeof message.content === "string") {
    const trimmed = message.content.trim();
    return trimmed || null;
  }
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((part) => {
        const type = typeof part?.type === "string" ? part.type.toLowerCase() : "";
        if (type === "text" || type === "input_text" || type === "output_text" || type === "") {
          return typeof part?.text === "string" ? part.text.trim() : "";
        }
        return "";
      })
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  if (typeof message.text === "string") {
    const trimmed = message.text.trim();
    return trimmed || null;
  }
  return null;
}

function extractPreviewText(message: TranscriptMessage): string | null {
  const text = extractMessageText(message);
  if (text) {
    return text;
  }
  if (Array.isArray(message.content)) {
    const names = message.content
      .map((part) => (typeof part?.name === "string" ? part.name.trim() : ""))
      .filter(Boolean);
    if (names.length > 0) {
      return `call ${names.slice(0, 2).join(", ")}`;
    }
  }
  const fallbackName =
    typeof message.toolName === "string"
      ? message.toolName.trim()
      : typeof message.tool_name === "string"
        ? message.tool_name.trim()
        : "";
  if (fallbackName) {
    return `call ${fallbackName}`;
  }
  return null;
}

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function normalizePreviewRole(role: string | undefined): TranscriptPreviewItem["role"] {
  const normalized = (role ?? "").toLowerCase();
  if (
    normalized === "user" ||
    normalized === "assistant" ||
    normalized === "tool" ||
    normalized === "system"
  ) {
    return normalized;
  }
  return "other";
}

function eventTypeFromEvent(event: Record<string, unknown>): string {
  const type = asTrimmedString((event as { type?: unknown }).type);
  return type ?? "message";
}

function parseEventTimestamp(event: Record<string, unknown>): Date {
  const timestamp = (event as { timestamp?: unknown }).timestamp;
  const createdAt =
    typeof timestamp === "string"
      ? new Date(timestamp)
      : timestamp instanceof Date
        ? timestamp
        : new Date();
  return Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;
}

function deterministicUuidFromText(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  const timeHiAndVersion = ((Number.parseInt(digest.slice(12, 16), 16) & 0x0fff) | 0x5000)
    .toString(16)
    .padStart(4, "0");
  const clockSeqHiAndReserved = ((Number.parseInt(digest.slice(16, 20), 16) & 0x3fff) | 0x8000)
    .toString(16)
    .padStart(4, "0");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${timeHiAndVersion}-${clockSeqHiAndReserved}-${digest.slice(20, 32)}`;
}

function extractProviderMessageId(textRaw?: string | null): string | null {
  if (!textRaw) {
    return null;
  }
  const match = textRaw.match(MESSAGE_ID_LINE_RE);
  return asTrimmedString(match?.[1]) ?? null;
}

function extractInboundRouteHint(textRaw?: string | null): { channel?: string; chatId?: string } {
  const firstLine = textRaw?.split(/\r?\n/, 1)[0] ?? "";
  const match = firstLine.match(INBOUND_HEADER_RE);
  if (!match) {
    return {};
  }
  return {
    channel: asTrimmedString(match[1])?.toLowerCase(),
    chatId: asTrimmedString(match[2]),
  };
}

function resolveInboundSemanticEventId(params: {
  sessionId: string;
  eventType: string;
  role: string | null;
  textRaw: string | null;
}): string | null {
  if (params.eventType !== "message" || params.role?.toLowerCase() !== "user") {
    return null;
  }
  const providerMessageId = extractProviderMessageId(params.textRaw);
  if (!providerMessageId) {
    return null;
  }
  const route = extractInboundRouteHint(params.textRaw);
  const channel = route.channel ?? "unknown";
  const chatId = route.chatId ?? params.sessionId;
  const semanticKey = `${channel}:${chatId}:${providerMessageId}`;
  return deterministicUuidFromText(`inbound:${semanticKey}`);
}

function ensureEventIdForInsert(params: {
  event: Record<string, unknown>;
  sessionId: string;
  eventType: string;
  role: string | null;
  textRaw: string | null;
}): string {
  const candidates = [
    asTrimmedString((params.event as { event_id?: unknown }).event_id),
    asTrimmedString((params.event as { eventId?: unknown }).eventId),
    asTrimmedString((params.event as { id?: unknown }).id),
  ].filter((value): value is string => Boolean(value));
  const existing = candidates.find((value) => UUID_RE.test(value));
  if (existing) {
    return existing;
  }

  const semanticInboundEventId = resolveInboundSemanticEventId({
    sessionId: params.sessionId,
    eventType: params.eventType,
    role: params.role,
    textRaw: params.textRaw,
  });
  if (semanticInboundEventId) {
    return semanticInboundEventId;
  }

  const fallbackId = asTrimmedString((params.event as { id?: unknown }).id);
  if (fallbackId) {
    return deterministicUuidFromText(`event:${params.sessionId}:${fallbackId}`);
  }

  return randomUUID();
}

export interface PostgresStorageConfig {
  url?: string;
  pool?: PgPoolLike;
  sessionsTable?: string;
  transcriptsTable?: string;
  auditTable?: string;
  schema?: string;
  tenantId?: string;
  tenantSlug?: string;
  defaultAgentId?: string;
  maxConnections?: number;
  ssl?: boolean;
}

export class PostgresStorageAdapter implements StorageAdapter {
  private readonly pool: PgPoolLike;
  private readonly schemaName: string;
  private readonly tenantId: string;
  private readonly tenantSlug: string;
  private readonly defaultAgentId: string;
  private readonly sessionsTable: string;
  private readonly transcriptsTable: string;
  private readonly auditTable: string;
  private readonly qualifiedSessionsTable: string;
  private readonly qualifiedTranscriptsTable: string;
  private readonly qualifiedAuditTable: string;
  private initialized = false;

  constructor(config: PostgresStorageConfig) {
    if (config.pool) {
      this.pool = config.pool;
    } else if (config.url) {
      let PgPool: PgPoolCtor;
      try {
        const pg = require("pg") as { Pool: PgPoolCtor };
        PgPool = pg.Pool;
      } catch {
        throw new Error(
          'Postgres storage adapter requires the "pg" package. Install it with `pnpm add pg` in openclaw.',
        );
      }
      this.pool = new PgPool({
        connectionString: config.url,
        max: config.maxConnections ?? 10,
        ssl:
          typeof config.ssl === "boolean"
            ? config.ssl
              ? { rejectUnauthorized: process.env.NODE_ENV === "production" }
              : false
            : undefined,
      });
    } else {
      throw new Error("PostgresStorageConfig requires either 'url' or 'pool'");
    }

    this.schemaName = config.schema ?? DEFAULT_SCHEMA;
    this.tenantId = config.tenantId ?? DEFAULT_TENANT_ID;
    this.tenantSlug = config.tenantSlug ?? DEFAULT_TENANT_SLUG;
    this.defaultAgentId = config.defaultAgentId ?? DEFAULT_AGENT_ID;
    this.sessionsTable = config.sessionsTable ?? "sessions";
    this.transcriptsTable = config.transcriptsTable ?? "session_messages";
    this.auditTable = config.auditTable ?? "audit_logs";

    const schema = quoteIdent(this.schemaName, "schema");
    this.qualifiedSessionsTable = `${schema}.${quoteIdent(this.sessionsTable, "sessions table")}`;
    this.qualifiedTranscriptsTable = `${schema}.${quoteIdent(this.transcriptsTable, "transcripts table")}`;
    this.qualifiedAuditTable = `${schema}.${quoteIdent(this.auditTable, "audit table")}`;
  }

  async ensureSchema(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(this.schemaName, "schema")}`);

      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.qualifiedSessionsTable} (\n` +
          `  tenant_id UUID NOT NULL,\n` +
          `  agent_id TEXT NOT NULL,\n` +
          `  session_key TEXT NOT NULL,\n` +
          `  session_id TEXT NOT NULL,\n` +
          `  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n` +
          `  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n` +
          `  chat_type TEXT,\n` +
          `  channel TEXT,\n` +
          `  user_id TEXT,\n` +
          `  label TEXT,\n` +
          `  display_name TEXT,\n` +
          `  subject TEXT,\n` +
          `  group_id TEXT,\n` +
          `  group_channel TEXT,\n` +
          `  space TEXT,\n` +
          `  spawned_by TEXT,\n` +
          `  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,\n` +
          `  PRIMARY KEY (tenant_id, session_key),\n` +
          `  UNIQUE (tenant_id, session_id)\n` +
          `)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_${this.sessionsTable}_updated_at\n` +
          `ON ${this.qualifiedSessionsTable} (tenant_id, updated_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_${this.sessionsTable}_agent_id\n` +
          `ON ${this.qualifiedSessionsTable} (tenant_id, agent_id, updated_at DESC)`,
      );

      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.qualifiedTranscriptsTable} (\n` +
          `  tenant_id UUID NOT NULL,\n` +
          `  session_id TEXT NOT NULL,\n` +
          `  seq BIGINT NOT NULL,\n` +
          `  event_id UUID NOT NULL,\n` +
          `  role TEXT,\n` +
          `  event_type TEXT NOT NULL,\n` +
          `  raw_json JSONB NOT NULL,\n` +
          `  text_raw TEXT,\n` +
          `  text_redacted TEXT,\n` +
          `  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n` +
          `  PRIMARY KEY (tenant_id, session_id, seq),\n` +
          `  UNIQUE (tenant_id, session_id, event_id)\n` +
          `)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_${this.transcriptsTable}_created_at\n` +
          `ON ${this.qualifiedTranscriptsTable} (tenant_id, session_id, created_at DESC)`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_${this.transcriptsTable}_event_id_unique\n` +
          `ON ${this.qualifiedTranscriptsTable} (tenant_id, session_id, event_id)`,
      );

      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.qualifiedAuditTable} (\n` +
          `  id BIGSERIAL PRIMARY KEY,\n` +
          `  timestamp TIMESTAMPTZ NOT NULL,\n` +
          `  actor_id TEXT NOT NULL,\n` +
          `  action TEXT NOT NULL,\n` +
          `  resource TEXT,\n` +
          `  details JSONB\n` +
          `)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_${this.auditTable}_timestamp\n` +
          `ON ${this.qualifiedAuditTable} (timestamp DESC)`,
      );

      this.initialized = true;
    } finally {
      client.release();
    }
  }

  private async ensureSessionForTranscriptWithClient(
    client: PgQueryRunner,
    sessionId: string,
    agentIdHint?: string,
  ): Promise<void> {
    const existing = await client.query(
      `SELECT 1 FROM ${this.qualifiedSessionsTable}\n` +
        `WHERE tenant_id = $1::uuid AND session_id = $2\n` +
        `LIMIT 1`,
      [this.tenantId, sessionId],
    );
    if (existing.rows.length > 0) {
      return;
    }

    const agentId = asTrimmedString(agentIdHint) ?? this.defaultAgentId;
    const sessionKey = `agent:${agentId}:session:${sessionId}`;
    await client.query(
      `INSERT INTO ${this.qualifiedSessionsTable}\n` +
        `  (tenant_id, agent_id, session_key, session_id, updated_at, created_at, metadata)\n` +
        `VALUES ($1::uuid, $2, $3, $4, NOW(), NOW(), '{}'::jsonb)\n` +
        `ON CONFLICT (tenant_id, session_id) DO NOTHING`,
      [this.tenantId, agentId, sessionKey, sessionId],
    );
  }

  private async withSessionLockClient<T>(
    params: SessionLockInput,
    fn: (client: PgPoolClient) => Promise<T>,
  ): Promise<T> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
        const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
        await client.query("SET LOCAL lock_timeout = $1", [`${timeoutMs}ms`]);
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        this.tenantId,
        params.sessionId,
      ]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private mapSessionRow(row: PgQueryRow): SessionEntry {
    const metadata = toSafeObject(row.metadata);
    const mergedMetadata = {
      ...metadata,
      sessionId:
        asTrimmedString((metadata as { sessionId?: unknown }).sessionId) ??
        asTrimmedString(row.session_id),
      updatedAt: toMillis(row.updated_at),
    };
    return {
      id: asTrimmedString(row.session_key) ?? asTrimmedString(row.session_id) ?? "session",
      userId: asTrimmedString(row.user_id),
      channelId: asTrimmedString(row.channel),
      createdAt: toMillis(row.created_at),
      updatedAt: toMillis(row.updated_at),
      displayName: asTrimmedString(row.display_name),
      label: asTrimmedString(row.label),
      spawnedBy: asTrimmedString(row.spawned_by),
      metadata: mergedMetadata,
    };
  }

  async saveSession(key: string, entry: SessionEntry): Promise<void> {
    await this.ensureSchema();
    const metadata = toSafeObject(entry.metadata);
    const agentId = parseAgentIdFromSessionKey(key);
    const sessionId =
      asTrimmedString((metadata as { sessionId?: unknown }).sessionId) ??
      asTrimmedString((metadata as { id?: unknown }).id) ??
      asTrimmedString(entry.id) ??
      key;
    const updatedAt = toDate(entry.updatedAt, Date.now());
    const createdAt = toDate(entry.createdAt, updatedAt.getTime());
    const chatType = asTrimmedString((metadata as { chatType?: unknown }).chatType);
    const channel =
      asTrimmedString((metadata as { lastChannel?: unknown }).lastChannel) ??
      asTrimmedString(entry.channelId);
    const userId =
      asTrimmedString(entry.userId) ??
      asTrimmedString((metadata as { origin?: { from?: unknown } }).origin?.from);
    const label =
      asTrimmedString((metadata as { label?: unknown }).label) ?? asTrimmedString(entry.label);
    const displayName =
      asTrimmedString((metadata as { displayName?: unknown }).displayName) ??
      asTrimmedString(entry.displayName);
    const subject = asTrimmedString((metadata as { subject?: unknown }).subject);
    const groupId = asTrimmedString((metadata as { groupId?: unknown }).groupId);
    const groupChannel = asTrimmedString((metadata as { groupChannel?: unknown }).groupChannel);
    const space = asTrimmedString((metadata as { space?: unknown }).space);
    const spawnedBy =
      asTrimmedString((metadata as { spawnedBy?: unknown }).spawnedBy) ??
      asTrimmedString(entry.spawnedBy);

    const params = [
      this.tenantId,
      key,
      agentId,
      sessionId,
      updatedAt,
      createdAt,
      chatType ?? null,
      channel ?? null,
      userId ?? null,
      label ?? null,
      displayName ?? null,
      subject ?? null,
      groupId ?? null,
      groupChannel ?? null,
      space ?? null,
      spawnedBy ?? null,
      JSON.stringify(metadata),
    ];

    const upsertSql =
      `INSERT INTO ${this.qualifiedSessionsTable}\n` +
      `  (tenant_id, session_key, agent_id, session_id, updated_at, created_at,\n` +
      `   chat_type, channel, user_id, label, display_name, subject, group_id,\n` +
      `   group_channel, space, spawned_by, metadata)\n` +
      `VALUES\n` +
      `  ($1::uuid, $2, $3, $4, $5, $6,\n` +
      `   $7, $8, $9, $10, $11, $12, $13,\n` +
      `   $14, $15, $16, $17::jsonb)\n` +
      `ON CONFLICT (tenant_id, session_key) DO UPDATE SET\n` +
      `  agent_id = EXCLUDED.agent_id,\n` +
      `  session_id = EXCLUDED.session_id,\n` +
      `  updated_at = EXCLUDED.updated_at,\n` +
      `  created_at = LEAST(${this.qualifiedSessionsTable}.created_at, EXCLUDED.created_at),\n` +
      `  chat_type = EXCLUDED.chat_type,\n` +
      `  channel = EXCLUDED.channel,\n` +
      `  user_id = EXCLUDED.user_id,\n` +
      `  label = EXCLUDED.label,\n` +
      `  display_name = EXCLUDED.display_name,\n` +
      `  subject = EXCLUDED.subject,\n` +
      `  group_id = EXCLUDED.group_id,\n` +
      `  group_channel = EXCLUDED.group_channel,\n` +
      `  space = EXCLUDED.space,\n` +
      `  spawned_by = EXCLUDED.spawned_by,\n` +
      `  metadata = EXCLUDED.metadata`;

    try {
      await this.pool.query(upsertSql, params);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "23505") {
        throw error;
      }
      await this.pool.query(
        `UPDATE ${this.qualifiedSessionsTable}\n` +
          `SET session_key = 'archived:' || CAST(EXTRACT(EPOCH FROM NOW()) AS BIGINT) || ':' || session_key\n` +
          `WHERE tenant_id = $1::uuid AND session_key = $2 AND session_id <> $4`,
        [params[0], params[1], params[2], params[3]],
      );
      const fallback = await this.pool.query(
        `UPDATE ${this.qualifiedSessionsTable}\n` +
          `SET session_key = $2,\n` +
          `    agent_id = $3,\n` +
          `    updated_at = $5,\n` +
          `    created_at = LEAST(created_at, $6),\n` +
          `    chat_type = $7,\n` +
          `    channel = $8,\n` +
          `    user_id = $9,\n` +
          `    label = $10,\n` +
          `    display_name = $11,\n` +
          `    subject = $12,\n` +
          `    group_id = $13,\n` +
          `    group_channel = $14,\n` +
          `    space = $15,\n` +
          `    spawned_by = $16,\n` +
          `    metadata = $17::jsonb\n` +
          `WHERE tenant_id = $1::uuid AND session_id = $4`,
        params,
      );
      if ((fallback.rowCount ?? 0) === 0) {
        await this.pool.query(upsertSql, params);
      }
    }
  }

  async loadSession(key: string): Promise<SessionEntry | null> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `SELECT session_key, session_id, created_at, updated_at, user_id, channel, label,\n` +
        `       display_name, spawned_by, metadata\n` +
        `FROM ${this.qualifiedSessionsTable}\n` +
        `WHERE tenant_id = $1::uuid AND session_key = $2\n` +
        `LIMIT 1`,
      [this.tenantId, key],
    );
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapSessionRow(result.rows[0]);
  }

  async listSessions(filter: SessionFilter): Promise<{ key: string; entry: SessionEntry }[]> {
    await this.ensureSchema();

    const clauses: string[] = [`tenant_id = $1::uuid`];
    const values: unknown[] = [this.tenantId];
    let paramIndex = 2;

    if (filter.userId) {
      clauses.push(`user_id = $${paramIndex++}`);
      values.push(filter.userId);
    }
    if (filter.channelId) {
      clauses.push(`channel = $${paramIndex++}`);
      values.push(filter.channelId);
    }
    if (filter.agentId) {
      clauses.push(`agent_id = $${paramIndex++}`);
      values.push(filter.agentId);
    }
    if (filter.label) {
      clauses.push(`label = $${paramIndex++}`);
      values.push(filter.label);
    }
    if (filter.spawnedBy) {
      clauses.push(`spawned_by = $${paramIndex++}`);
      values.push(filter.spawnedBy);
    }
    if (filter.activeSince) {
      clauses.push(`updated_at >= to_timestamp($${paramIndex++}::double precision / 1000)`);
      values.push(filter.activeSince);
    }
    if (filter.search) {
      const pattern = `%${filter.search}%`;
      clauses.push(
        `(subject ILIKE $${paramIndex} OR display_name ILIKE $${paramIndex} OR session_key ILIKE $${paramIndex})`,
      );
      values.push(pattern);
      paramIndex += 1;
    }

    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;

    const result = await this.pool.query(
      `SELECT session_key, session_id, created_at, updated_at, user_id, channel, label,\n` +
        `       display_name, spawned_by, metadata\n` +
        `FROM ${this.qualifiedSessionsTable}\n` +
        `WHERE ${clauses.join(" AND ")}\n` +
        `ORDER BY updated_at DESC\n` +
        `LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...values, limit, offset],
    );

    return result.rows.map((row) => ({
      key: asTrimmedString(row.session_key) ?? "session",
      entry: this.mapSessionRow(row),
    }));
  }

  async deleteSession(key: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `DELETE FROM ${this.qualifiedSessionsTable} WHERE tenant_id = $1::uuid AND session_key = $2`,
      [this.tenantId, key],
    );
  }

  async withSessionLock<T>(params: SessionLockInput, fn: () => Promise<T>): Promise<T> {
    return await this.withSessionLockClient(params, async () => await fn());
  }

  async appendTranscriptEvent(params: TranscriptAppendInput): Promise<{ sessionFile?: string }> {
    await this.appendTranscriptEvents({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      storePath: params.storePath,
      agentId: params.agentId,
      events: [params.event],
      createIfMissing: params.createIfMissing,
    });
    return { sessionFile: params.sessionFile ?? `session://${params.sessionId}` };
  }

  async appendTranscriptEvents(
    params: TranscriptAppendManyInput,
  ): Promise<TranscriptAppendManyResult> {
    await this.ensureSchema();
    const events = params.events
      .map((entry) => toSafeObject(entry))
      .filter((entry) => Object.keys(entry).length > 0);
    if (events.length === 0) {
      return { count: 0, firstSeq: 0, lastSeq: 0 };
    }

    return await this.withSessionLockClient(
      {
        sessionId: params.sessionId,
        agentId: params.agentId,
      },
      async (client) => {
        if (params.createIfMissing === false) {
          const existing = await client.query(
            `SELECT 1 FROM ${this.qualifiedSessionsTable}\n` +
              `WHERE tenant_id = $1::uuid AND session_id = $2\n` +
              `LIMIT 1`,
            [this.tenantId, params.sessionId],
          );
          if (existing.rows.length === 0) {
            return { count: 0, firstSeq: 0, lastSeq: 0 };
          }
        } else {
          await this.ensureSessionForTranscriptWithClient(client, params.sessionId, params.agentId);
        }

        const seqResult = await client.query(
          `SELECT (COALESCE(MAX(seq), 0) + 1)::bigint AS next_seq\n` +
            `FROM ${this.qualifiedTranscriptsTable}\n` +
            `WHERE tenant_id = $1::uuid AND session_id = $2`,
          [this.tenantId, params.sessionId],
        );
        let nextSeq = Number.parseInt(String(seqResult.rows[0]?.next_seq ?? "1"), 10);
        if (!Number.isFinite(nextSeq) || nextSeq < 1) {
          nextSeq = 1;
        }

        let firstSeq = 0;
        let lastSeq = 0;
        let insertedCount = 0;
        for (const event of events) {
          const message =
            event && typeof event === "object" && "message" in event
              ? ((event as { message?: unknown }).message as TranscriptMessage | undefined)
              : undefined;
          const eventType = eventTypeFromEvent(event);
          const role =
            asTrimmedString(message?.role) ?? asTrimmedString((event as { role?: unknown }).role);
          const textRaw =
            extractMessageText(message) ?? asTrimmedString((event as { text?: unknown }).text);
          const createdAt = parseEventTimestamp(event);
          const eventId = ensureEventIdForInsert({
            event,
            sessionId: params.sessionId,
            eventType,
            role: role ?? null,
            textRaw: textRaw ?? null,
          });

          const inserted = await client.query(
            `INSERT INTO ${this.qualifiedTranscriptsTable}\n` +
              `  (tenant_id, session_id, seq, event_id, role, event_type, raw_json, text_raw, text_redacted, created_at)\n` +
              `VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7::jsonb, $8, $9, $10)\n` +
              `ON CONFLICT (tenant_id, session_id, event_id) DO NOTHING`,
            [
              this.tenantId,
              params.sessionId,
              nextSeq,
              eventId,
              role ?? null,
              eventType,
              JSON.stringify(event),
              textRaw ?? null,
              textRaw ?? null,
              createdAt,
            ],
          );
          if ((inserted.rowCount ?? 0) > 0) {
            if (firstSeq === 0) {
              firstSeq = nextSeq;
            }
            lastSeq = nextSeq;
            insertedCount += 1;
            nextSeq += 1;
          }
        }

        await client.query(
          `UPDATE ${this.qualifiedSessionsTable}\n` +
            `SET updated_at = GREATEST(updated_at, NOW())\n` +
            `WHERE tenant_id = $1::uuid AND session_id = $2`,
          [this.tenantId, params.sessionId],
        );

        return {
          count: insertedCount,
          firstSeq,
          lastSeq,
        };
      },
    );
  }

  async readTranscriptEvents(params: TranscriptReadEventsInput): Promise<TranscriptEventRecord[]> {
    await this.ensureSchema();
    const clauses = ["tenant_id = $1::uuid", "session_id = $2"];
    const values: unknown[] = [this.tenantId, params.sessionId];
    let paramIndex = 3;

    if (typeof params.fromSeq === "number" && Number.isFinite(params.fromSeq)) {
      clauses.push(`seq >= $${paramIndex++}`);
      values.push(Math.max(1, Math.floor(params.fromSeq)));
    }
    if (typeof params.toSeq === "number" && Number.isFinite(params.toSeq)) {
      clauses.push(`seq <= $${paramIndex++}`);
      values.push(Math.max(1, Math.floor(params.toSeq)));
    }

    const order: TranscriptSortOrder = (params.order ?? "asc") === "desc" ? "desc" : "asc";
    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
        ? Math.floor(params.limit)
        : undefined;
    const limitClause = typeof limit === "number" ? `LIMIT ${limit}` : "";

    const result = await this.pool.query(
      `SELECT seq, event_id, event_type, role, raw_json, created_at\n` +
        `FROM ${this.qualifiedTranscriptsTable}\n` +
        `WHERE ${clauses.join(" AND ")}\n` +
        `ORDER BY seq ${order === "desc" ? "DESC" : "ASC"}\n` +
        `${limitClause}`,
      values,
    );

    return result.rows.map((row) => ({
      seq: Number(row.seq ?? 0),
      eventId: asTrimmedString(row.event_id),
      eventType: asTrimmedString(row.event_type) ?? "message",
      role: asTrimmedString(row.role) ?? undefined,
      createdAt: toMillis(row.created_at),
      raw: toSafeObject(row.raw_json),
    }));
  }

  async readTranscriptMessages(params: TranscriptReadInput): Promise<unknown[]> {
    const events = await this.readTranscriptEvents({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      storePath: params.storePath,
      agentId: params.agentId,
      order: params.order,
      limit: params.limit,
    });

    return events
      .map((entry) => {
        const raw = entry.raw;
        const message = raw.message;
        if (message && typeof message === "object") {
          return message;
        }
        const role = asTrimmedString(raw.role) ?? "assistant";
        const text = asTrimmedString(raw.text) ?? asTrimmedString(raw.message);
        if (!text) {
          return null;
        }
        return {
          role,
          content: [{ type: "text", text }],
        };
      })
      .filter((message) => Boolean(message));
  }

  async readTranscriptPreview(params: TranscriptPreviewInput): Promise<TranscriptPreviewItem[]> {
    const maxItems = Math.max(1, Math.floor(params.maxItems));
    const maxChars = Math.max(20, Math.floor(params.maxChars));
    const fetchLimit = Math.min(200, Math.max(maxItems * 4, maxItems));

    const events = await this.readTranscriptEvents({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      storePath: params.storePath,
      agentId: params.agentId,
      order: "desc",
      limit: fetchLimit,
    });

    const preview: TranscriptPreviewItem[] = [];
    for (const event of [...events].reverse()) {
      const raw = event.raw;
      const message = toSafeObject(raw.message) as TranscriptMessage;
      const text =
        asTrimmedString((raw as { text_redacted?: unknown }).text_redacted) ??
        asTrimmedString((raw as { text_raw?: unknown }).text_raw) ??
        extractPreviewText(message);
      if (!text) {
        continue;
      }
      preview.push({
        role: normalizePreviewRole(event.role),
        text: truncateText(text, maxChars),
      });
    }

    if (preview.length <= maxItems) {
      return preview;
    }
    return preview.slice(-maxItems);
  }

  async replaceTranscript(params: TranscriptReplaceInput): Promise<TranscriptReplaceResult> {
    await this.ensureSchema();
    const events = params.events
      .map((entry) => toSafeObject(entry))
      .filter((entry) => Object.keys(entry).length > 0);

    return await this.withSessionLockClient(
      {
        sessionId: params.sessionId,
        agentId: params.agentId,
      },
      async (client) => {
        if (params.createIfMissing === false) {
          const existingSession = await client.query(
            `SELECT 1 FROM ${this.qualifiedSessionsTable}\n` +
              `WHERE tenant_id = $1::uuid AND session_id = $2\n` +
              `LIMIT 1`,
            [this.tenantId, params.sessionId],
          );
          if (existingSession.rows.length === 0) {
            return {
              replaced: false,
              inserted: 0,
              deleted: 0,
              lastSeq: 0,
            };
          }
        } else {
          await this.ensureSessionForTranscriptWithClient(client, params.sessionId, params.agentId);
        }

        const deletedResult = await client.query(
          `DELETE FROM ${this.qualifiedTranscriptsTable}\n` +
            `WHERE tenant_id = $1::uuid AND session_id = $2`,
          [this.tenantId, params.sessionId],
        );
        const deleted = deletedResult.rowCount ?? 0;

        let seq = 1;
        for (const event of events) {
          const message =
            event && typeof event === "object" && "message" in event
              ? ((event as { message?: unknown }).message as TranscriptMessage | undefined)
              : undefined;
          const eventType = eventTypeFromEvent(event);
          const role =
            asTrimmedString(message?.role) ?? asTrimmedString((event as { role?: unknown }).role);
          const textRaw =
            extractMessageText(message) ?? asTrimmedString((event as { text?: unknown }).text);
          const createdAt = parseEventTimestamp(event);
          const eventId = ensureEventIdForInsert({
            event,
            sessionId: params.sessionId,
            eventType,
            role: role ?? null,
            textRaw: textRaw ?? null,
          });

          await client.query(
            `INSERT INTO ${this.qualifiedTranscriptsTable}\n` +
              `  (tenant_id, session_id, seq, event_id, role, event_type, raw_json, text_raw, text_redacted, created_at)\n` +
              `VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7::jsonb, $8, $9, $10)`,
            [
              this.tenantId,
              params.sessionId,
              seq,
              eventId,
              role ?? null,
              eventType,
              JSON.stringify(event),
              textRaw ?? null,
              textRaw ?? null,
              createdAt,
            ],
          );
          seq += 1;
        }

        await client.query(
          `UPDATE ${this.qualifiedSessionsTable}\n` +
            `SET updated_at = GREATEST(updated_at, NOW())\n` +
            `WHERE tenant_id = $1::uuid AND session_id = $2`,
          [this.tenantId, params.sessionId],
        );

        return {
          replaced: deleted > 0 || events.length > 0,
          inserted: events.length,
          deleted,
          lastSeq: events.length > 0 ? events.length : 0,
        };
      },
    );
  }

  async cloneTranscript(params: TranscriptCloneInput): Promise<TranscriptCloneResult> {
    await this.ensureSchema();
    return await this.withSessionLockClient(
      {
        sessionId: params.targetSessionId,
        agentId: params.agentId,
      },
      async (client) => {
        if (params.sourceSessionId !== params.targetSessionId) {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
            this.tenantId,
            params.sourceSessionId,
          ]);
        }

        await this.ensureSessionForTranscriptWithClient(
          client,
          params.targetSessionId,
          params.agentId,
        );

        const overwriteTarget = params.overwriteTarget !== false;
        if (overwriteTarget) {
          await client.query(
            `DELETE FROM ${this.qualifiedTranscriptsTable}\n` +
              `WHERE tenant_id = $1::uuid AND session_id = $2`,
            [this.tenantId, params.targetSessionId],
          );
        }

        let startSeq = 1;
        if (!overwriteTarget) {
          const maxSeqResult = await client.query(
            `SELECT COALESCE(MAX(seq), 0)::bigint AS max_seq\n` +
              `FROM ${this.qualifiedTranscriptsTable}\n` +
              `WHERE tenant_id = $1::uuid AND session_id = $2`,
            [this.tenantId, params.targetSessionId],
          );
          const maxSeq = Number.parseInt(String(maxSeqResult.rows[0]?.max_seq ?? "0"), 10);
          startSeq = Number.isFinite(maxSeq) ? maxSeq + 1 : 1;
        }

        const sourceClauses = ["tenant_id = $1::uuid", "session_id = $2"];
        const sourceValues: unknown[] = [this.tenantId, params.sourceSessionId];
        if (typeof params.upToSeq === "number" && Number.isFinite(params.upToSeq)) {
          sourceClauses.push("seq <= $3");
          sourceValues.push(Math.max(1, Math.floor(params.upToSeq)));
        }

        const sourceRows = await client.query(
          `SELECT event_id, role, event_type, raw_json, text_raw, text_redacted, created_at\n` +
            `FROM ${this.qualifiedTranscriptsTable}\n` +
            `WHERE ${sourceClauses.join(" AND ")}\n` +
            `ORDER BY seq ASC`,
          sourceValues,
        );

        let seq = startSeq;
        for (const row of sourceRows.rows) {
          const raw = toSafeObject(row.raw_json);
          const rowEventId = asTrimmedString(row.event_id);
          const message = toSafeObject(raw.message) as TranscriptMessage;
          const eventType = asTrimmedString(row.event_type) ?? "message";
          const role = asTrimmedString(row.role) ?? asTrimmedString(message.role);
          const textRaw = asTrimmedString(row.text_raw) ?? extractMessageText(message);
          const eventId =
            rowEventId && UUID_RE.test(rowEventId)
              ? rowEventId
              : ensureEventIdForInsert({
                  event: raw,
                  sessionId: params.targetSessionId,
                  eventType,
                  role: role ?? null,
                  textRaw: textRaw ?? null,
                });

          await client.query(
            `INSERT INTO ${this.qualifiedTranscriptsTable}\n` +
              `  (tenant_id, session_id, seq, event_id, role, event_type, raw_json, text_raw, text_redacted, created_at)\n` +
              `VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7::jsonb, $8, $9, $10)`,
            [
              this.tenantId,
              params.targetSessionId,
              seq,
              eventId,
              asTrimmedString(row.role) ?? null,
              asTrimmedString(row.event_type) ?? "message",
              JSON.stringify(raw),
              asTrimmedString(row.text_raw) ?? null,
              asTrimmedString(row.text_redacted) ?? null,
              toDate(row.created_at, Date.now()),
            ],
          );
          seq += 1;
        }

        await client.query(
          `UPDATE ${this.qualifiedSessionsTable}\n` +
            `SET updated_at = GREATEST(updated_at, NOW())\n` +
            `WHERE tenant_id = $1::uuid AND session_id = $2`,
          [this.tenantId, params.targetSessionId],
        );

        return {
          cloned: sourceRows.rows.length,
          firstSeq: sourceRows.rows.length > 0 ? startSeq : 0,
          lastSeq: sourceRows.rows.length > 0 ? seq - 1 : 0,
        };
      },
    );
  }

  async compactTranscript(params: TranscriptCompactInput): Promise<TranscriptCompactResult> {
    const maxMessages = Math.max(1, Math.floor(params.maxMessages));
    const events = await this.readTranscriptEvents({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      storePath: params.storePath,
      agentId: params.agentId,
      order: "asc",
    });
    if (events.length === 0) {
      return { compacted: false, kept: 0, reason: "no-transcript" };
    }
    if (events.length <= maxMessages) {
      return { compacted: false, kept: events.length, reason: "within-limit" };
    }

    const kept = events.slice(-maxMessages).map((entry) => entry.raw);
    await this.replaceTranscript({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      storePath: params.storePath,
      agentId: params.agentId,
      events: kept,
      createIfMissing: true,
    });

    return {
      compacted: true,
      kept: maxMessages,
    };
  }

  async deleteTranscript(params: TranscriptLocation): Promise<TranscriptDeleteResult> {
    const result = await this.withSessionLockClient(
      {
        sessionId: params.sessionId,
        agentId: params.agentId,
      },
      async (client) =>
        await client.query(
          `DELETE FROM ${this.qualifiedTranscriptsTable}\n` +
            `WHERE tenant_id = $1::uuid AND session_id = $2`,
          [this.tenantId, params.sessionId],
        ),
    );

    return {
      deleted: (result.rowCount ?? 0) > 0,
      archived: [],
    };
  }

  async logAuditEvent(event: AuditEvent): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO ${this.qualifiedAuditTable} (timestamp, actor_id, action, resource, details)\n` +
        `VALUES (to_timestamp($1::double precision / 1000), $2, $3, $4, $5::jsonb)`,
      [
        event.timestamp,
        event.actorId,
        event.action,
        event.resource ?? null,
        event.details ? JSON.stringify(event.details) : null,
      ],
    );
  }

  async listUsers(filter: { limit?: number; offset?: number }): Promise<string[]> {
    await this.ensureSchema();
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;
    const result = await this.pool.query(
      `SELECT DISTINCT user_id\n` +
        `FROM ${this.qualifiedSessionsTable}\n` +
        `WHERE tenant_id = $1::uuid AND user_id IS NOT NULL\n` +
        `ORDER BY user_id ASC\n` +
        `LIMIT $2 OFFSET $3`,
      [this.tenantId, limit, offset],
    );
    return result.rows
      .map((row) => asTrimmedString(row.user_id))
      .filter((value): value is string => Boolean(value));
  }

  async listAuditEvents(filter: {
    userId?: string;
    action?: string;
    limit?: number;
    offset?: number;
  }): Promise<AuditEvent[]> {
    await this.ensureSchema();
    const clauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (filter.userId) {
      clauses.push(`actor_id = $${idx++}`);
      values.push(filter.userId);
    }
    if (filter.action) {
      clauses.push(`action = $${idx++}`);
      values.push(filter.action);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;

    const result = await this.pool.query(
      `SELECT timestamp, actor_id, action, resource, details\n` +
        `FROM ${this.qualifiedAuditTable}\n` +
        `${where}\n` +
        `ORDER BY timestamp DESC\n` +
        `LIMIT $${idx++} OFFSET $${idx}`,
      [...values, limit, offset],
    );

    return result.rows.map((row) => ({
      timestamp: toMillis(row.timestamp),
      actorId: asTrimmedString(row.actor_id) ?? "unknown",
      action: asTrimmedString(row.action) ?? "unknown",
      resource: asTrimmedString(row.resource),
      details:
        row.details && typeof row.details === "object"
          ? (row.details as Record<string, unknown>)
          : undefined,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }

  getPoolStats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount ?? 0,
      idle: this.pool.idleCount ?? 0,
      waiting: this.pool.waitingCount ?? 0,
    };
  }
}
