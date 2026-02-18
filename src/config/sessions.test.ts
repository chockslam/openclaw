import { beforeEach, describe, expect, it } from "vitest";
import { createMockStorageAdapter } from "../../test/helpers/mock-storage-adapter.js";
import {
  getSessionStoreBridge,
  initializeSessionStoreBridge,
} from "../gateway/session-store-bridge.js";
import { sleep } from "../utils.js";
import {
  buildGroupDisplayName,
  deriveSessionKey,
  loadSessionStore,
  resolveSessionFilePath,
  resolveSessionKey,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptsDir,
  updateLastRoute,
  updateSessionStore,
  updateSessionStoreEntry,
} from "./sessions.js";

function nextStorePath(label: string): string {
  return `store://sessions-test/${label}`;
}

async function seedStore(
  storePath: string,
  store: Record<string, Record<string, unknown>>,
): Promise<void> {
  await getSessionStoreBridge().saveSessionStore(storePath, store as never);
}

describe("sessions", () => {
  beforeEach(() => {
    initializeSessionStoreBridge(createMockStorageAdapter());
  });

  it("returns normalized per-sender key", () => {
    expect(deriveSessionKey("per-sender", { From: "whatsapp:+1555" })).toBe("+1555");
  });

  it("falls back to unknown when sender missing", () => {
    expect(deriveSessionKey("per-sender", {})).toBe("unknown");
  });

  it("global scope returns global", () => {
    expect(deriveSessionKey("global", { From: "+1" })).toBe("global");
  });

  it("keeps group chats distinct", () => {
    expect(deriveSessionKey("per-sender", { From: "12345-678@g.us" })).toBe(
      "whatsapp:group:12345-678@g.us",
    );
  });

  it("prefixes group keys with provider when available", () => {
    expect(
      deriveSessionKey("per-sender", {
        From: "12345-678@g.us",
        ChatType: "group",
        Provider: "whatsapp",
      }),
    ).toBe("whatsapp:group:12345-678@g.us");
  });

  it("keeps explicit provider when provided in group key", () => {
    expect(
      resolveSessionKey("per-sender", { From: "discord:group:12345", ChatType: "group" }, "main"),
    ).toBe("agent:main:discord:group:12345");
  });

  it("builds discord display name with guild+channel slugs", () => {
    expect(
      buildGroupDisplayName({
        provider: "discord",
        groupChannel: "#general",
        space: "friends-of-openclaw",
        id: "123",
        key: "discord:group:123",
      }),
    ).toBe("discord:friends-of-openclaw#general");
  });

  it("collapses direct chats to main by default", () => {
    expect(resolveSessionKey("per-sender", { From: "+1555" })).toBe("agent:main:main");
  });

  it("collapses direct chats to main even when sender missing", () => {
    expect(resolveSessionKey("per-sender", {})).toBe("agent:main:main");
  });

  it("maps direct chats to main key when provided", () => {
    expect(resolveSessionKey("per-sender", { From: "whatsapp:+1555" }, "main")).toBe(
      "agent:main:main",
    );
  });

  it("uses custom main key when provided", () => {
    expect(resolveSessionKey("per-sender", { From: "+1555" }, "primary")).toBe(
      "agent:main:primary",
    );
  });

  it("keeps global scope untouched", () => {
    expect(resolveSessionKey("global", { From: "+1555" })).toBe("global");
  });

  it("leaves groups untouched even with main key", () => {
    expect(resolveSessionKey("per-sender", { From: "12345-678@g.us" }, "main")).toBe(
      "agent:main:whatsapp:group:12345-678@g.us",
    );
  });

  it("updateLastRoute persists channel and target", async () => {
    const mainSessionKey = "agent:main:main";
    const storePath = nextStorePath("update-last-route");
    await seedStore(storePath, {
      [mainSessionKey]: {
        sessionId: "sess-1",
        updatedAt: 123,
        systemSent: true,
        thinkingLevel: "low",
        responseUsage: "on",
        queueDebounceMs: 1234,
        reasoningLevel: "on",
        elevatedLevel: "on",
        authProfileOverride: "auth-1",
        compactionCount: 2,
      },
    });

    await updateLastRoute({
      storePath,
      sessionKey: mainSessionKey,
      deliveryContext: {
        channel: "telegram",
        to: "  12345  ",
      },
    });

    const store = loadSessionStore(storePath);
    expect(store[mainSessionKey]?.sessionId).toBe("sess-1");
    expect(store[mainSessionKey]?.updatedAt).toBeGreaterThanOrEqual(123);
    expect(store[mainSessionKey]?.lastChannel).toBe("telegram");
    expect(store[mainSessionKey]?.lastTo).toBe("12345");
    expect(store[mainSessionKey]?.deliveryContext).toEqual({
      channel: "telegram",
      to: "12345",
    });
    expect(store[mainSessionKey]?.responseUsage).toBe("on");
    expect(store[mainSessionKey]?.queueDebounceMs).toBe(1234);
    expect(store[mainSessionKey]?.reasoningLevel).toBe("on");
    expect(store[mainSessionKey]?.elevatedLevel).toBe("on");
    expect(store[mainSessionKey]?.authProfileOverride).toBe("auth-1");
    expect(store[mainSessionKey]?.compactionCount).toBe(2);
  });

  it("updateLastRoute prefers explicit deliveryContext", async () => {
    const mainSessionKey = "agent:main:main";
    const storePath = nextStorePath("update-last-route-explicit");
    await seedStore(storePath, {});

    await updateLastRoute({
      storePath,
      sessionKey: mainSessionKey,
      channel: "whatsapp",
      to: "111",
      accountId: "legacy",
      deliveryContext: {
        channel: "telegram",
        to: "222",
        accountId: "primary",
      },
    });

    const store = loadSessionStore(storePath);
    expect(store[mainSessionKey]?.lastChannel).toBe("telegram");
    expect(store[mainSessionKey]?.lastTo).toBe("222");
    expect(store[mainSessionKey]?.lastAccountId).toBe("primary");
    expect(store[mainSessionKey]?.deliveryContext).toEqual({
      channel: "telegram",
      to: "222",
      accountId: "primary",
    });
  });

  it("updateLastRoute records origin + group metadata when ctx is provided", async () => {
    const sessionKey = "agent:main:whatsapp:group:123@g.us";
    const storePath = nextStorePath("update-last-route-group");
    await seedStore(storePath, {});

    await updateLastRoute({
      storePath,
      sessionKey,
      deliveryContext: {
        channel: "whatsapp",
        to: "123@g.us",
      },
      ctx: {
        Provider: "whatsapp",
        ChatType: "group",
        GroupSubject: "Family",
        From: "123@g.us",
      },
    });

    const store = loadSessionStore(storePath);
    expect(store[sessionKey]?.subject).toBe("Family");
    expect(store[sessionKey]?.channel).toBe("whatsapp");
    expect(store[sessionKey]?.groupId).toBe("123@g.us");
    expect(store[sessionKey]?.origin?.label).toBe("Family id:123@g.us");
    expect(store[sessionKey]?.origin?.provider).toBe("whatsapp");
    expect(store[sessionKey]?.origin?.chatType).toBe("group");
  });

  it("updateSessionStoreEntry preserves existing fields when patching", async () => {
    const sessionKey = "agent:main:main";
    const storePath = nextStorePath("update-entry-preserve");
    await seedStore(storePath, {
      [sessionKey]: {
        sessionId: "sess-1",
        updatedAt: 100,
        reasoningLevel: "on",
      },
    });

    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: async () => ({ updatedAt: 200 }),
    });

    const store = loadSessionStore(storePath);
    expect(store[sessionKey]?.updatedAt).toBeGreaterThanOrEqual(200);
    expect(store[sessionKey]?.reasoningLevel).toBe("on");
  });

  it("updateSessionStore preserves concurrent additions", async () => {
    const storePath = nextStorePath("concurrent-add");
    await seedStore(storePath, {});

    await Promise.all([
      updateSessionStore(storePath, (store) => {
        store["agent:main:one"] = { sessionId: "sess-1", updatedAt: 1 };
      }),
      updateSessionStore(storePath, (store) => {
        store["agent:main:two"] = { sessionId: "sess-2", updatedAt: 2 };
      }),
    ]);

    const store = loadSessionStore(storePath);
    expect(store["agent:main:one"]?.sessionId).toBe("sess-1");
    expect(store["agent:main:two"]?.sessionId).toBe("sess-2");
  });

  it("recovers from empty stores", async () => {
    const storePath = nextStorePath("empty-store");
    await seedStore(storePath, {});

    await updateSessionStore(storePath, (store) => {
      store["agent:main:main"] = { sessionId: "sess-1", updatedAt: 1 };
    });

    const store = loadSessionStore(storePath);
    expect(store["agent:main:main"]?.sessionId).toBe("sess-1");
  });

  it("normalizes last route fields on write", async () => {
    const storePath = nextStorePath("normalize-last-route");
    await seedStore(storePath, {});

    await updateSessionStore(storePath, (store) => {
      store["agent:main:main"] = {
        sessionId: "sess-normalized",
        updatedAt: 1,
        lastChannel: " WhatsApp ",
        lastTo: " +1555 ",
        lastAccountId: " acct-1 ",
      };
    });

    const store = loadSessionStore(storePath);
    expect(store["agent:main:main"]?.lastChannel).toBe("whatsapp");
    expect(store["agent:main:main"]?.lastTo).toBe("+1555");
    expect(store["agent:main:main"]?.lastAccountId).toBe("acct-1");
    expect(store["agent:main:main"]?.deliveryContext).toEqual({
      channel: "whatsapp",
      to: "+1555",
      accountId: "acct-1",
    });
  });

  it("updateSessionStore keeps deletions when concurrent writes happen", async () => {
    const storePath = nextStorePath("concurrent-delete");
    await seedStore(storePath, {
      "agent:main:old": { sessionId: "sess-old", updatedAt: 1 },
      "agent:main:keep": { sessionId: "sess-keep", updatedAt: 2 },
    });

    await Promise.all([
      updateSessionStore(storePath, (store) => {
        delete store["agent:main:old"];
      }),
      updateSessionStore(storePath, (store) => {
        store["agent:main:new"] = { sessionId: "sess-new", updatedAt: 3 };
      }),
    ]);

    const store = loadSessionStore(storePath);
    expect(store["agent:main:old"]).toBeUndefined();
    expect(store["agent:main:keep"]?.sessionId).toBe("sess-keep");
    expect(store["agent:main:new"]?.sessionId).toBe("sess-new");
  });

  it("loadSessionStore auto-migrates legacy provider keys to channel keys", async () => {
    const mainSessionKey = "agent:main:main";
    const storePath = nextStorePath("legacy-provider");
    await seedStore(storePath, {
      [mainSessionKey]: {
        sessionId: "sess-legacy",
        updatedAt: 123,
        provider: "slack",
        lastProvider: "telegram",
        lastTo: "user:U123",
      },
    });

    const store = loadSessionStore(storePath) as unknown as Record<string, Record<string, unknown>>;
    const entry = store[mainSessionKey] ?? {};
    expect(entry.channel).toBe("slack");
    expect(entry.provider).toBeUndefined();
    expect(entry.lastChannel).toBe("telegram");
    expect(entry.lastProvider).toBeUndefined();
  });

  it("derives session transcripts dir from OPENCLAW_STATE_DIR", () => {
    const dir = resolveSessionTranscriptsDir(
      { OPENCLAW_STATE_DIR: "/custom/state" } as NodeJS.ProcessEnv,
      () => "/home/ignored",
    );
    expect(dir).toBe("store://agent/main/transcripts");
  });

  it("includes topic ids in session transcript filenames", () => {
    const sessionFile = resolveSessionTranscriptPath("sess-1", "main", 123);
    expect(sessionFile).toBe("session://sess-1?topic=123");
  });

  it("uses agent id when resolving session file fallback paths", () => {
    const sessionFile = resolveSessionFilePath("sess-2", undefined, {
      agentId: "codex",
    });
    expect(sessionFile).toBe("session://sess-2");
  });

  it("updateSessionStoreEntry merges concurrent patches", async () => {
    const mainSessionKey = "agent:main:main";
    const storePath = nextStorePath("concurrent-patch");
    await seedStore(storePath, {
      [mainSessionKey]: {
        sessionId: "sess-1",
        updatedAt: 123,
        thinkingLevel: "low",
      },
    });

    await Promise.all([
      updateSessionStoreEntry({
        storePath,
        sessionKey: mainSessionKey,
        update: async () => {
          await sleep(50);
          return { modelOverride: "anthropic/claude-opus-4-5" };
        },
      }),
      updateSessionStoreEntry({
        storePath,
        sessionKey: mainSessionKey,
        update: async () => {
          await sleep(10);
          return { thinkingLevel: "high" };
        },
      }),
    ]);

    const store = loadSessionStore(storePath);
    expect(store[mainSessionKey]?.modelOverride).toBe("anthropic/claude-opus-4-5");
    expect(store[mainSessionKey]?.thinkingLevel).toBe("high");
  });
});
