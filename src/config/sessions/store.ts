import type { MsgContext } from "../../auto-reply/templating.js";
import { getSessionStoreBridge } from "../../gateway/session-store-bridge.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
  type DeliveryContext,
} from "../../utils/delivery-context.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import { mergeSessionEntry, type SessionEntry } from "./types.js";

function storeLockKey(storePath: string): string {
  return `store:${storePath}`;
}

async function withSessionStoreLock<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
  return await getSessionStoreBridge().withSessionLock(
    {
      sessionId: storeLockKey(storePath),
    },
    fn,
  );
}

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const normalized = normalizeSessionDeliveryFields({
    channel: entry.channel,
    lastChannel: entry.lastChannel,
    lastTo: entry.lastTo,
    lastAccountId: entry.lastAccountId,
    lastThreadId: entry.lastThreadId ?? entry.deliveryContext?.threadId ?? entry.origin?.threadId,
    deliveryContext: entry.deliveryContext,
  });
  const nextDelivery = normalized.deliveryContext;
  const sameDelivery =
    (entry.deliveryContext?.channel ?? undefined) === nextDelivery?.channel &&
    (entry.deliveryContext?.to ?? undefined) === nextDelivery?.to &&
    (entry.deliveryContext?.accountId ?? undefined) === nextDelivery?.accountId &&
    (entry.deliveryContext?.threadId ?? undefined) === nextDelivery?.threadId;
  const sameLast =
    entry.lastChannel === normalized.lastChannel &&
    entry.lastTo === normalized.lastTo &&
    entry.lastAccountId === normalized.lastAccountId &&
    entry.lastThreadId === normalized.lastThreadId;
  if (sameDelivery && sameLast) {
    return entry;
  }
  return {
    ...entry,
    deliveryContext: nextDelivery,
    lastChannel: normalized.lastChannel,
    lastTo: normalized.lastTo,
    lastAccountId: normalized.lastAccountId,
    lastThreadId: normalized.lastThreadId,
  };
}

function normalizeSessionStore(store: Record<string, SessionEntry>): void {
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const normalized = normalizeSessionEntryDelivery(entry);
    if (normalized !== entry) {
      store[key] = normalized;
    }
  }
}

function migrateLegacySessionFields(store: Record<string, SessionEntry>): void {
  for (const entry of Object.values(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rec = entry as unknown as Record<string, unknown>;
    if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
      rec.channel = rec.provider;
      delete rec.provider;
    }
    if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
      rec.lastChannel = rec.lastProvider;
      delete rec.lastProvider;
    }
    if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
      rec.groupChannel = rec.room;
      delete rec.room;
    } else if ("room" in rec) {
      delete rec.room;
    }
  }
}

export function loadSessionStore(storePath: string): Record<string, SessionEntry> {
  const store = getSessionStoreBridge().loadSessionStore(storePath);
  migrateLegacySessionFields(store);
  normalizeSessionStore(store);
  return store;
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  migrateLegacySessionFields(store);
  normalizeSessionStore(store);
  await getSessionStoreBridge().saveSessionStore(storePath, store);
}

export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
): Promise<T> {
  return await withSessionStoreLock(storePath, async () => {
    const bridge = getSessionStoreBridge();
    const store = await bridge.loadSessionStoreAsync(storePath);
    migrateLegacySessionFields(store);
    normalizeSessionStore(store);
    const result = await mutator(store);
    migrateLegacySessionFields(store);
    normalizeSessionStore(store);
    await bridge.saveSessionStore(storePath, store);
    return result;
  });
}

export function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
  try {
    const store = loadSessionStore(params.storePath);
    return store[params.sessionKey]?.updatedAt;
  } catch {
    return undefined;
  }
}

export async function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (
    entry: SessionEntry,
  ) =>
    | Promise<SessionEntry | Partial<SessionEntry> | null | undefined>
    | SessionEntry
    | Partial<SessionEntry>
    | null
    | undefined;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, update } = params;
  return await withSessionStoreLock(storePath, async () => {
    const bridge = getSessionStoreBridge();
    const store = await bridge.loadSessionStoreAsync(storePath);
    migrateLegacySessionFields(store);
    const existing = store[sessionKey];
    if (!existing) {
      return null;
    }
    const patch = await update(existing);
    if (!patch) {
      return existing;
    }
    const next = mergeSessionEntry(existing, patch);
    store[sessionKey] = next;
    migrateLegacySessionFields(store);
    normalizeSessionStore(store);
    await bridge.saveSessionStore(storePath, store);
    return next;
  });
}

export async function recordSessionMetaFromInbound(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  return await updateSessionStore(storePath, (store) => {
    const existing = store[sessionKey];
    const patch = deriveSessionMetaPatch({
      ctx,
      sessionKey,
      existing,
      groupResolution: params.groupResolution,
    });
    if (!patch) {
      return existing ?? null;
    }
    if (!existing && !createIfMissing) {
      return null;
    }
    const next = mergeSessionEntry(existing, patch);
    store[sessionKey] = next;
    return next;
  });
}

export async function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
}): Promise<SessionEntry> {
  const { storePath, sessionKey, channel, to, accountId, threadId, ctx } = params;
  return await withSessionStoreLock(storePath, async () => {
    const bridge = getSessionStoreBridge();
    const store = await bridge.loadSessionStoreAsync(storePath);
    migrateLegacySessionFields(store);
    const existing = store[sessionKey];
    const now = Date.now();
    const explicitContext = normalizeDeliveryContext(params.deliveryContext);
    const inlineContext = normalizeDeliveryContext({
      channel,
      to,
      accountId,
      threadId,
    });
    const mergedInput = mergeDeliveryContext(explicitContext, inlineContext);
    const merged = mergeDeliveryContext(mergedInput, deliveryContextFromSession(existing));
    const normalized = normalizeSessionDeliveryFields({
      deliveryContext: {
        channel: merged?.channel,
        to: merged?.to,
        accountId: merged?.accountId,
        threadId: merged?.threadId,
      },
    });
    const metaPatch = ctx
      ? deriveSessionMetaPatch({
          ctx,
          sessionKey,
          existing,
          groupResolution: params.groupResolution,
        })
      : null;
    const basePatch: Partial<SessionEntry> = {
      updatedAt: Math.max(existing?.updatedAt ?? 0, now),
      deliveryContext: normalized.deliveryContext,
      lastChannel: normalized.lastChannel,
      lastTo: normalized.lastTo,
      lastAccountId: normalized.lastAccountId,
      lastThreadId: normalized.lastThreadId,
    };
    const next = mergeSessionEntry(
      existing,
      metaPatch ? { ...basePatch, ...metaPatch } : basePatch,
    );
    store[sessionKey] = next;
    normalizeSessionStore(store);
    await bridge.saveSessionStore(storePath, store);
    return next;
  });
}
