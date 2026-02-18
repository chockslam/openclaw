import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { getSessionStoreBridge } from "../../../gateway/session-store-bridge.js";
import { makeTempWorkspace } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";
import handler from "./handler.js";

async function seedMockSession(
  sessionId: string,
  entries: Array<{ role: string; content: string } | { type: string }>,
): Promise<void> {
  const events = entries.map((entry) => {
    if ("role" in entry) {
      return {
        type: "message",
        message: {
          role: entry.role,
          content: entry.content,
        },
      };
    }
    return entry as Record<string, unknown>;
  });
  await getSessionStoreBridge().appendTranscriptEvents({
    sessionId,
    events,
    createIfMissing: true,
  });
}

describe("session-memory hook", () => {
  it("skips non-command events", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);

    // Memory directory should not be created for non-command events
    const memoryDir = path.join(tempDir, "memory");
    await expect(fs.access(memoryDir)).rejects.toThrow();
  });

  it("skips commands other than new", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");

    const event = createHookEvent("command", "help", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);

    // Memory directory should not be created for other commands
    const memoryDir = path.join(tempDir, "memory");
    await expect(fs.access(memoryDir)).rejects.toThrow();
  });

  it("creates memory file with session content on /new command", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionId = "test-123";

    await seedMockSession(sessionId, [
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi! How can I help?" },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "2+2 equals 4" },
    ]);

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId,
      },
    });

    await handler(event);

    // Memory file should be created
    const memoryDir = path.join(tempDir, "memory");
    const files = await fs.readdir(memoryDir);
    expect(files.length).toBe(1);

    // Read the memory file and verify content
    const memoryContent = await fs.readFile(path.join(memoryDir, files[0]), "utf-8");
    expect(memoryContent).toContain("user: Hello there");
    expect(memoryContent).toContain("assistant: Hi! How can I help?");
    expect(memoryContent).toContain("user: What is 2+2?");
    expect(memoryContent).toContain("assistant: 2+2 equals 4");
  });

  it("filters out non-message entries (tool calls, system)", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionId = "test-123";

    await seedMockSession(sessionId, [
      { role: "user", content: "Hello" },
      { type: "tool_use", tool: "search", input: "test" },
      { role: "assistant", content: "World" },
      { type: "tool_result", result: "found it" },
      { role: "user", content: "Thanks" },
    ]);

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId,
      },
    });

    await handler(event);

    const memoryDir = path.join(tempDir, "memory");
    const files = await fs.readdir(memoryDir);
    const memoryContent = await fs.readFile(path.join(memoryDir, files[0]), "utf-8");

    // Only user/assistant messages should be present
    expect(memoryContent).toContain("user: Hello");
    expect(memoryContent).toContain("assistant: World");
    expect(memoryContent).toContain("user: Thanks");
    // Tool entries should not appear
    expect(memoryContent).not.toContain("tool_use");
    expect(memoryContent).not.toContain("tool_result");
    expect(memoryContent).not.toContain("search");
  });

  it("filters out command messages starting with /", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionId = "test-123";

    await seedMockSession(sessionId, [
      { role: "user", content: "/help" },
      { role: "assistant", content: "Here is help info" },
      { role: "user", content: "Normal message" },
      { role: "user", content: "/new" },
    ]);

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId,
      },
    });

    await handler(event);

    const memoryDir = path.join(tempDir, "memory");
    const files = await fs.readdir(memoryDir);
    const memoryContent = await fs.readFile(path.join(memoryDir, files[0]), "utf-8");

    // Command messages should be filtered out
    expect(memoryContent).not.toContain("/help");
    expect(memoryContent).not.toContain("/new");
    // Normal messages should be present
    expect(memoryContent).toContain("assistant: Here is help info");
    expect(memoryContent).toContain("user: Normal message");
  });

  it("respects custom messages config (limits to N messages)", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionId = "test-123";

    // Create 10 messages
    const entries = [];
    for (let i = 1; i <= 10; i++) {
      entries.push({ role: "user", content: `Message ${i}` });
    }
    await seedMockSession(sessionId, entries);

    // Configure to only include last 3 messages
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
      hooks: {
        internal: {
          entries: {
            "session-memory": { enabled: true, messages: 3 },
          },
        },
      },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId,
      },
    });

    await handler(event);

    const memoryDir = path.join(tempDir, "memory");
    const files = await fs.readdir(memoryDir);
    const memoryContent = await fs.readFile(path.join(memoryDir, files[0]), "utf-8");

    // Only last 3 messages should be present
    expect(memoryContent).not.toContain("user: Message 1\n");
    expect(memoryContent).not.toContain("user: Message 7\n");
    expect(memoryContent).toContain("user: Message 8");
    expect(memoryContent).toContain("user: Message 9");
    expect(memoryContent).toContain("user: Message 10");
  });

  it("filters messages before slicing (fix for #2681)", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionId = "test-123";

    // Create session with many tool entries interspersed with messages
    // This tests that we filter FIRST, then slice - not the other way around
    const entries = [
      { role: "user", content: "First message" },
      { type: "tool_use", tool: "test1" },
      { type: "tool_result", result: "result1" },
      { role: "assistant", content: "Second message" },
      { type: "tool_use", tool: "test2" },
      { type: "tool_result", result: "result2" },
      { role: "user", content: "Third message" },
      { type: "tool_use", tool: "test3" },
      { type: "tool_result", result: "result3" },
      { role: "assistant", content: "Fourth message" },
    ];
    await seedMockSession(sessionId, entries);

    // Request 3 messages - if we sliced first, we'd only get 1-2 messages
    // because the last 3 lines include tool entries
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
      hooks: {
        internal: {
          entries: {
            "session-memory": { enabled: true, messages: 3 },
          },
        },
      },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId,
      },
    });

    await handler(event);

    const memoryDir = path.join(tempDir, "memory");
    const files = await fs.readdir(memoryDir);
    const memoryContent = await fs.readFile(path.join(memoryDir, files[0]), "utf-8");

    // Should have exactly 3 user/assistant messages (the last 3)
    expect(memoryContent).not.toContain("First message");
    expect(memoryContent).toContain("user: Third message");
    expect(memoryContent).toContain("assistant: Second message");
    expect(memoryContent).toContain("assistant: Fourth message");
  });

  it("handles empty session files gracefully", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionId = "test-123";

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId,
      },
    });

    // Should not throw
    await handler(event);

    // Memory file should still be created with metadata
    const memoryDir = path.join(tempDir, "memory");
    const files = await fs.readdir(memoryDir);
    expect(files.length).toBe(1);
  });

  it("handles session files with fewer messages than requested", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-memory-");
    const sessionId = "test-123";

    // Only 2 messages but requesting 15 (default)
    await seedMockSession(sessionId, [
      { role: "user", content: "Only message 1" },
      { role: "assistant", content: "Only message 2" },
    ]);

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId,
      },
    });

    await handler(event);

    const memoryDir = path.join(tempDir, "memory");
    const files = await fs.readdir(memoryDir);
    const memoryContent = await fs.readFile(path.join(memoryDir, files[0]), "utf-8");

    // Both messages should be included
    expect(memoryContent).toContain("user: Only message 1");
    expect(memoryContent).toContain("assistant: Only message 2");
  });
});
