import { beforeEach, describe, expect, it, vi } from "vitest";
import { getReplyFromConfig } from "./get-reply.js";
import { buildTestCtx } from "./test-ctx.js";

const mocks = vi.hoisted(() => ({
  appendUserTranscriptMessage: vi.fn(async () => ({ ok: true })),
  appendAssistantTranscriptMessage: vi.fn(async () => ({ ok: true })),
  runPreparedReply: vi.fn(async () => ({ text: "bot response" })),
  initSessionState: vi.fn(async () => ({
    sessionCtx: { Provider: "telegram" },
    sessionEntry: { sessionFile: "session.json" },
    sessionKey: "session-key",
    sessionId: "session-id",
    storePath: "store-path",
  })),
}));

vi.mock("../../gateway/session-transcript.js", () => ({
  appendUserTranscriptMessage: mocks.appendUserTranscriptMessage,
  appendAssistantTranscriptMessage: mocks.appendAssistantTranscriptMessage,
}));

vi.mock("./get-reply-run.js", () => ({
  runPreparedReply: mocks.runPreparedReply,
}));

vi.mock("./session.js", () => ({
  initSessionState: mocks.initSessionState,
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({})),
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveSessionAgentId: vi.fn(() => "agent-id"),
  resolveAgentSkillsFilter: vi.fn(),
}));

vi.mock("../../agents/workspace.js", () => ({
  ensureAgentWorkspace: vi.fn(async () => ({ dir: "workspace-dir" })),
  DEFAULT_AGENT_WORKSPACE_DIR: "default-dir",
}));

vi.mock("./inbound-context.js", () => ({
  finalizeInboundContext: vi.fn((ctx) => ctx),
}));

vi.mock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: vi.fn(async () => ({
    result: {
      provider: "provider",
      model: "model",
      modelState: { resolveDefaultThinkingLevel: async () => "off" },
      command: { isAuthorizedSender: true },
      directives: new Set(),
    },
  })),
}));

vi.mock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: vi.fn(async () => ({
    directives: new Set(),
  })),
}));

describe("getReplyFromConfig persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not append transcript rows directly for external channels (telegram)", async () => {
    const ctx = buildTestCtx({
      Provider: "telegram",
      Body: "user message",
    });

    await getReplyFromConfig(ctx);

    // Runtime/session manager is the canonical transcript writer.
    expect(mocks.appendUserTranscriptMessage).not.toHaveBeenCalled();
    expect(mocks.appendAssistantTranscriptMessage).not.toHaveBeenCalled();
  });

  it("does not append transcript rows directly for internal channel (webchat)", async () => {
    mocks.initSessionState.mockResolvedValueOnce({
      sessionCtx: { Provider: "webchat" },
      sessionEntry: { sessionFile: "session.json" },
      sessionKey: "session-key",
      sessionId: "session-id",
      storePath: "store-path",
    });

    const ctx = buildTestCtx({
      Provider: "webchat",
      Body: "user message",
    });

    await getReplyFromConfig(ctx);

    // Internal channel persistence is handled by chat.ts and runtime writer.
    expect(mocks.appendUserTranscriptMessage).not.toHaveBeenCalled();
    expect(mocks.appendAssistantTranscriptMessage).not.toHaveBeenCalled();
  });
});
