import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSessionStoreBridge } from "../../gateway/session-store-bridge.js";
import { saveSessionStore } from "./store.js";
import {
  appendAssistantMessageToSessionTranscript,
  resolveMirroredTranscriptText,
} from "./transcript.js";

describe("resolveMirroredTranscriptText", () => {
  it("prefers media filenames over text", () => {
    const result = resolveMirroredTranscriptText({
      text: "caption here",
      mediaUrls: ["https://example.com/files/report.pdf?sig=123"],
    });
    expect(result).toBe("report.pdf");
  });

  it("returns trimmed text when no media", () => {
    const result = resolveMirroredTranscriptText({ text: "  hello  " });
    expect(result).toBe("hello");
  });
});

describe("appendAssistantMessageToSessionTranscript", () => {
  let tempDir: string;
  let storePath: string;
  let sessionsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-test-"));
    sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    storePath = path.join(sessionsDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns error for missing sessionKey", async () => {
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "",
      text: "test",
      storePath,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing sessionKey");
    }
  });

  it("returns error for empty text", async () => {
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "test-session",
      text: "   ",
      storePath,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("empty text");
    }
  });

  it("returns error for unknown sessionKey", async () => {
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "nonexistent",
      text: "test message",
      storePath,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unknown sessionKey");
    }
  });

  it("creates transcript file and appends message for valid session", async () => {
    const sessionId = "test-session-id";
    const sessionKey = "test-session";
    const store = {
      [sessionKey]: {
        sessionId,
        chatType: "direct",
        channel: "discord",
      },
    };
    await saveSessionStore(storePath, store);

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      storePath,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionFile).toContain(sessionId);
      const events = await getSessionStoreBridge().readTranscriptEvents({
        sessionId,
        order: "asc",
      });
      expect(events.length).toBe(1);
      const messageLine = events[0]?.raw as {
        type?: string;
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      expect(messageLine.type).toBe("message");
      expect(messageLine.message?.role).toBe("assistant");
      expect(messageLine.message?.content?.[0]?.type).toBe("text");
      expect(messageLine.message?.content?.[0]?.text).toBe("Hello from delivery mirror!");
    }
  });
});
