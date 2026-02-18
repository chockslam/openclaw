import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEventRecord } from "../../gateway/interfaces/storage.js";

const readTranscriptEventsMock = vi.fn();
const appendTranscriptEventsMock = vi.fn();
const replaceTranscriptMock = vi.fn();
const withSessionLockMock = vi.fn(
  async (_params: unknown, fn: () => Promise<unknown>) => await fn(),
);

vi.mock("../../gateway/session-store-bridge.js", () => ({
  getSessionStoreBridge: () => ({
    readTranscriptEvents: readTranscriptEventsMock,
    appendTranscriptEvents: appendTranscriptEventsMock,
    replaceTranscript: replaceTranscriptMock,
    withSessionLock: withSessionLockMock,
  }),
}));

import { loadDbSessionRuntime } from "./db-session-runtime.js";

function makeRow(seq: number, raw: Record<string, unknown>): TranscriptEventRecord {
  return {
    seq,
    eventType: "message",
    createdAt: Date.now() + seq,
    raw,
  };
}

describe("loadDbSessionRuntime", () => {
  beforeEach(() => {
    readTranscriptEventsMock.mockReset();
    appendTranscriptEventsMock.mockReset();
    replaceTranscriptMock.mockReset();
    withSessionLockMock.mockClear();
  });

  it("normalizes legacy assistant messages missing usage", async () => {
    const ts = new Date().toISOString();
    readTranscriptEventsMock.mockResolvedValue([
      makeRow(1, {
        type: "message",
        id: "assistant-1",
        timestamp: ts,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "legacy assistant message" }],
          timestamp: Date.now(),
        },
      }),
      makeRow(2, {
        type: "message",
        id: "user-1",
        timestamp: ts,
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: Date.now(),
        },
      }),
    ]);

    const runtime = await loadDbSessionRuntime({
      sessionId: "session-1",
      cwd: "/tmp/workspace",
    });

    const assistantEntry = runtime.sessionManager
      .getEntries()
      .find(
        (entry) =>
          entry.type === "message" &&
          (entry as { message?: { role?: string } }).message?.role === "assistant",
      ) as { message?: Record<string, unknown> } | undefined;
    expect(assistantEntry?.message).toBeDefined();
    const usage = assistantEntry?.message?.usage as Record<string, unknown> | undefined;
    expect(usage).toBeDefined();
    expect(usage).toMatchObject({
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
    });
    expect(assistantEntry?.message?.stopReason).toBe("stop");
  });

  it("preserves and completes partial assistant usage", async () => {
    const ts = new Date().toISOString();
    readTranscriptEventsMock.mockResolvedValue([
      makeRow(1, {
        type: "message",
        id: "assistant-1",
        timestamp: ts,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "aborted",
          usage: {
            input: 11,
            output: 7,
            cacheRead: 2,
          },
        },
      }),
    ]);

    const runtime = await loadDbSessionRuntime({
      sessionId: "session-2",
      cwd: "/tmp/workspace",
    });

    const assistantEntry = runtime.sessionManager.getEntries()[0] as {
      message: Record<string, unknown>;
    };
    const usage = assistantEntry.message.usage as Record<string, unknown>;
    expect(usage.input).toBe(11);
    expect(usage.output).toBe(7);
    expect(usage.cacheRead).toBe(2);
    expect(usage.cacheWrite).toBe(0);
    expect(usage.totalTokens).toBe(20);
    expect(assistantEntry.message.stopReason).toBe("aborted");
  });
});
