import { beforeEach, describe, expect, it } from "vitest";
import { createMockStorageAdapter } from "../../test/helpers/mock-storage-adapter.js";
import { initializeSessionStoreBridge } from "../gateway/session-store-bridge.js";
import {
  loadSessionStore,
  saveSessionStore,
  type SessionEntry,
  updateSessionStore,
} from "./sessions.js";

describe("Session Store Bridge-backed session store", () => {
  const storePath = "test://session-store";

  beforeEach(() => {
    initializeSessionStoreBridge(createMockStorageAdapter());
  });

  it("loads saved session store entries", async () => {
    const testStore: Record<string, SessionEntry> = {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        displayName: "Test Session 1",
      },
    };

    await saveSessionStore(storePath, testStore);

    expect(loadSessionStore(storePath)).toEqual(testStore);
  });

  it("returns cloned values so caller mutations do not leak", async () => {
    const testStore: Record<string, SessionEntry> = {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        cliSessionIds: { openai: "sess-1" },
        skillsSnapshot: {
          prompt: "skills",
          skills: [{ name: "alpha" }],
        },
      },
    };

    await saveSessionStore(storePath, testStore);

    const loaded1 = loadSessionStore(storePath);
    loaded1["session:1"].cliSessionIds = { openai: "mutated" };
    if (loaded1["session:1"].skillsSnapshot?.skills?.length) {
      loaded1["session:1"].skillsSnapshot.skills[0].name = "mutated";
    }

    const loaded2 = loadSessionStore(storePath);
    expect(loaded2["session:1"].cliSessionIds?.openai).toBe("sess-1");
    expect(loaded2["session:1"].skillsSnapshot?.skills?.[0]?.name).toBe("alpha");
  });

  it("updates persisted state through updateSessionStore", async () => {
    await saveSessionStore(storePath, {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        displayName: "Before",
      },
    });

    await updateSessionStore(storePath, (store) => {
      store["session:1"] = {
        ...store["session:1"],
        displayName: "After",
      };
    });

    expect(loadSessionStore(storePath)["session:1"]?.displayName).toBe("After");
  });

  it("returns an empty store when no entries exist", () => {
    expect(loadSessionStore("test://missing-store")).toEqual({});
  });
});
