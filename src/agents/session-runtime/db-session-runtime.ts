import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { getSessionStoreBridge } from "../../gateway/session-store-bridge.js";

type RuntimeEntry = Record<string, unknown> & {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
} as const;

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

/**
 * Legacy transcript rows (especially delivery-mirror assistant messages) may omit
 * assistant usage metadata. pi-coding-agent's pre-prompt compaction assumes it exists.
 * Normalize assistant messages so compaction never dereferences undefined usage.
 */
function normalizeTranscriptMessageEntry(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.type !== "message") {
    return raw;
  }
  const message = raw.message;
  if (!message || typeof message !== "object") {
    return raw;
  }
  const typedMessage = message as Record<string, unknown>;
  if (typedMessage.role !== "assistant") {
    return raw;
  }

  const usageRaw =
    typedMessage.usage && typeof typedMessage.usage === "object"
      ? (typedMessage.usage as Record<string, unknown>)
      : {};
  const costRaw =
    usageRaw.cost && typeof usageRaw.cost === "object"
      ? (usageRaw.cost as Record<string, unknown>)
      : {};

  const input = asFiniteNumber(usageRaw.input) ?? ZERO_USAGE.input;
  const output = asFiniteNumber(usageRaw.output) ?? ZERO_USAGE.output;
  const cacheRead = asFiniteNumber(usageRaw.cacheRead) ?? ZERO_USAGE.cacheRead;
  const cacheWrite = asFiniteNumber(usageRaw.cacheWrite) ?? ZERO_USAGE.cacheWrite;
  const totalTokens =
    asFiniteNumber(usageRaw.totalTokens) ?? input + output + cacheRead + cacheWrite;

  return {
    ...raw,
    message: {
      ...typedMessage,
      stopReason:
        typeof typedMessage.stopReason === "string" && typedMessage.stopReason.trim()
          ? typedMessage.stopReason
          : "stop",
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        cost: {
          input: asFiniteNumber(costRaw.input) ?? ZERO_USAGE.cost.input,
          output: asFiniteNumber(costRaw.output) ?? ZERO_USAGE.cost.output,
          cacheRead: asFiniteNumber(costRaw.cacheRead) ?? ZERO_USAGE.cost.cacheRead,
          cacheWrite: asFiniteNumber(costRaw.cacheWrite) ?? ZERO_USAGE.cost.cacheWrite,
          total: asFiniteNumber(costRaw.total) ?? ZERO_USAGE.cost.total,
        },
      },
    },
  };
}

type MutableSessionManager = {
  sessionId: string;
  cwd: string;
  fileEntries: Array<Record<string, unknown>>;
  byId: Map<string, RuntimeEntry>;
  labelsById: Map<string, string>;
  leafId: string | null;
  flushed: boolean;
};

export type DbSessionRuntime = {
  sessionManager: SessionManager;
  appendPendingEntries: () => Promise<void>;
  replaceTranscriptFromManager: () => Promise<void>;
  loadedEntryCount: number;
};

function parseTimestamp(value: unknown, fallbackMs: number): string {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date(fallbackMs).toISOString();
}

function normalizeRuntimeEntry(params: {
  raw: Record<string, unknown>;
  createdAt: number;
  previousId: string | null;
  knownIds: Set<string>;
}): RuntimeEntry | null {
  const { raw, createdAt, previousId, knownIds } = params;
  const normalizedRaw = normalizeTranscriptMessageEntry(raw);
  const type = typeof normalizedRaw.type === "string" ? normalizedRaw.type : "";
  if (!type || type === "session") {
    return null;
  }

  let id =
    typeof normalizedRaw.id === "string" && normalizedRaw.id.trim()
      ? normalizedRaw.id.trim()
      : randomUUID().slice(0, 8);
  while (knownIds.has(id)) {
    id = randomUUID().slice(0, 8);
  }

  const parentIdRaw = normalizedRaw.parentId;
  const parentId =
    parentIdRaw === null
      ? null
      : typeof parentIdRaw === "string" && parentIdRaw.trim()
        ? parentIdRaw
        : previousId;

  const timestamp = parseTimestamp(normalizedRaw.timestamp, createdAt);
  return {
    ...normalizedRaw,
    type,
    id,
    parentId,
    timestamp,
  };
}

function applyEntriesToManager(params: {
  sessionManager: SessionManager;
  sessionId: string;
  cwd: string;
  headerTimestamp: string;
  entries: RuntimeEntry[];
}): void {
  const mutable = params.sessionManager as unknown as MutableSessionManager;
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: params.headerTimestamp,
    cwd: params.cwd,
  };
  mutable.sessionId = params.sessionId;
  mutable.cwd = params.cwd;
  mutable.fileEntries = [header, ...params.entries];
  mutable.byId.clear();
  mutable.labelsById.clear();
  mutable.leafId = null;
  for (const entry of params.entries) {
    mutable.byId.set(entry.id, entry);
    mutable.leafId = entry.id;
    if (entry.type === "label") {
      const label = typeof entry.label === "string" ? entry.label : undefined;
      const targetId = typeof entry.targetId === "string" ? entry.targetId : undefined;
      if (label && targetId) {
        mutable.labelsById.set(targetId, label);
      } else if (targetId) {
        mutable.labelsById.delete(targetId);
      }
    }
  }
  mutable.flushed = true;
}

function serializeManagerEntries(entries: unknown[]): RuntimeEntry[] {
  const out: RuntimeEntry[] = [];
  const knownIds = new Set<string>();
  let previousId: string | null = null;
  const now = Date.now();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const normalized = normalizeRuntimeEntry({
      raw: entry as Record<string, unknown>,
      createdAt: now,
      previousId,
      knownIds,
    });
    if (!normalized) {
      continue;
    }
    knownIds.add(normalized.id);
    previousId = normalized.id;
    out.push(normalized);
  }
  return out;
}

export async function withDbSessionLock<T>(
  params: {
    sessionId: string;
    agentId?: string;
    timeoutMs?: number;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const bridge = getSessionStoreBridge();
  return await bridge.withSessionLock(params, fn);
}

export async function loadDbSessionRuntime(params: {
  sessionId: string;
  agentId?: string;
  cwd: string;
}): Promise<DbSessionRuntime> {
  const bridge = getSessionStoreBridge();
  const rows = await bridge.readTranscriptEvents({
    sessionId: params.sessionId,
    agentId: params.agentId,
    order: "asc",
  });

  let headerCwd = params.cwd;
  let headerTimestamp = new Date().toISOString();
  const entries: RuntimeEntry[] = [];
  const knownIds = new Set<string>();
  let previousId: string | null = null;

  for (const row of rows) {
    const raw = row.raw;
    if (raw.type === "session") {
      if (typeof raw.cwd === "string" && raw.cwd.trim()) {
        headerCwd = raw.cwd;
      }
      headerTimestamp = parseTimestamp(raw.timestamp, row.createdAt);
      continue;
    }
    const normalized = normalizeRuntimeEntry({
      raw,
      createdAt: row.createdAt,
      previousId,
      knownIds,
    });
    if (!normalized) {
      continue;
    }
    knownIds.add(normalized.id);
    previousId = normalized.id;
    entries.push(normalized);
  }

  const sessionManager = SessionManager.inMemory(headerCwd);
  applyEntriesToManager({
    sessionManager,
    sessionId: params.sessionId,
    cwd: headerCwd,
    headerTimestamp,
    entries,
  });

  let persistedIds = new Set(entries.map((entry) => entry.id));

  const appendPendingEntries = async () => {
    const serialized = serializeManagerEntries(sessionManager.getEntries());
    const pending = serialized.filter((entry) => !persistedIds.has(entry.id));
    if (pending.length === 0) {
      return;
    }
    await bridge.appendTranscriptEvents({
      sessionId: params.sessionId,
      agentId: params.agentId,
      events: pending,
      createIfMissing: true,
    });
    for (const entry of pending) {
      persistedIds.add(entry.id);
    }
  };

  const replaceTranscriptFromManager = async () => {
    const serialized = serializeManagerEntries(sessionManager.getEntries());
    await bridge.replaceTranscript({
      sessionId: params.sessionId,
      agentId: params.agentId,
      events: serialized,
      createIfMissing: true,
    });
    persistedIds = new Set(serialized.map((entry) => entry.id));
  };

  return {
    sessionManager,
    appendPendingEntries,
    replaceTranscriptFromManager,
    loadedEntryCount: entries.length,
  };
}
