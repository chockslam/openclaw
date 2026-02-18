import { beforeEach, describe, expect, test } from "vitest";
import { createMockStorageAdapter } from "../../test/helpers/mock-storage-adapter.js";
import { initializeSessionStoreBridge, getSessionStoreBridge } from "./session-store-bridge.js";
import {
  archiveFileOnDisk,
  capArrayByJsonBytes,
  readFirstUserMessageFromTranscript,
  readLastMessagePreviewFromTranscript,
  readSessionMessages,
  readSessionPreviewItemsFromTranscript,
  resolveSessionTranscriptCandidates,
} from "./session-utils.fs.js";

const STORE_PATH = "/virtual/sessions.json";

async function seedTranscript(sessionId: string, events: Array<Record<string, unknown>>) {
  await getSessionStoreBridge().appendTranscriptEvents({
    sessionId,
    storePath: STORE_PATH,
    events,
    createIfMissing: true,
  });
}

describe("session-utils.fs compatibility wrappers", () => {
  beforeEach(() => {
    initializeSessionStoreBridge(createMockStorageAdapter());
  });

  test("readFirstUserMessageFromTranscript returns first user message from bridge summary", async () => {
    const sessionId = "session-first-preview";
    await seedTranscript(sessionId, [
      { message: { role: "system", content: "ignore me" } },
      { message: { role: "user", content: "First user message" } },
      { message: { role: "assistant", content: "Reply" } },
    ]);

    const result = readFirstUserMessageFromTranscript(sessionId, STORE_PATH);
    expect(result).toBe("First user message");
  });

  test("readLastMessagePreviewFromTranscript returns latest user/assistant preview", async () => {
    const sessionId = "session-last-preview";
    await seedTranscript(sessionId, [
      { message: { role: "user", content: "Question" } },
      { message: { role: "tool", content: "ignored tool payload" } },
      { message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] } },
    ]);

    const result = readLastMessagePreviewFromTranscript(sessionId, STORE_PATH);
    expect(result).toBe("Final answer");
  });

  test("readSessionMessages returns transcript messages from the bridge", async () => {
    const sessionId = "session-messages";
    await seedTranscript(sessionId, [
      { message: { role: "user", content: "Hello" } },
      { message: { role: "assistant", content: [{ type: "text", text: "Hi there" }] } },
      { message: { role: "tool", content: "weather lookup" } },
    ]);

    const messages = await readSessionMessages(sessionId, STORE_PATH);
    expect(messages).toHaveLength(3);
    expect((messages[0] as { role?: string }).role).toBe("user");
    expect((messages[2] as { role?: string }).role).toBe("tool");
  });

  test("readSessionPreviewItemsFromTranscript respects maxItems and maxChars", async () => {
    const sessionId = "session-preview";
    await seedTranscript(sessionId, [
      { message: { role: "user", content: "first message" } },
      { message: { role: "assistant", content: "assistant response" } },
      { message: { role: "tool", content: "very long tool payload that should truncate" } },
    ]);

    const preview = await readSessionPreviewItemsFromTranscript(sessionId, STORE_PATH, undefined, {
      maxItems: 2,
      maxChars: 16,
    });

    expect(preview).toHaveLength(2);
    expect(preview[0]?.role).toBe("tool");
    expect(preview[0]?.text.length).toBeLessThanOrEqual(16);
    expect(preview[1]?.role).toBe("assistant");
  });

  test("resolveSessionTranscriptCandidates delegates to readSessionMessages", async () => {
    const sessionId = "session-candidates";
    await seedTranscript(sessionId, [
      { message: { role: "user", content: "one" } },
      { message: { role: "assistant", content: "two" } },
    ]);

    const candidates = await resolveSessionTranscriptCandidates(sessionId, STORE_PATH);
    expect(candidates).toHaveLength(2);
    expect((candidates[0] as { role?: string }).role).toBe("user");
  });

  test("archiveFileOnDisk is a no-op in adapter mode", () => {
    expect(archiveFileOnDisk("/tmp/unused.jsonl")).toBeNull();
  });

  test("capArrayByJsonBytes trims oldest items until within byte budget", () => {
    const items = [
      { id: "a", text: "old" },
      { id: "b", text: "middle" },
      { id: "c", text: "new" },
    ];
    const targetBytes = Buffer.byteLength(JSON.stringify(items.slice(1)), "utf-8");

    const capped = capArrayByJsonBytes(items, targetBytes);
    expect(capped.items).toEqual(items.slice(1));
  });
});
