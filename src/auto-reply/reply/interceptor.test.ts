import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { MsgContext } from "../templating.js";
import {
  registerChannelInterceptor,
  clearChannelInterceptor,
} from "../../gateway/channel-interceptor.js";
import { getReplyFromConfig } from "./get-reply.js";
import { createMockTypingController } from "./test-helpers.js";

// Mock dependencies to avoid full agent execution
vi.mock("./get-reply-run.js", () => ({
  runPreparedReply: vi.fn().mockResolvedValue({ text: "Agent reply" }),
}));

vi.mock("../../agents/workspace.js", () => ({
  ensureAgentWorkspace: vi.fn().mockResolvedValue({ dir: "/tmp/mock-workspace", isFresh: false }),
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/mock-workspace",
}));

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  return {
    ...actual,
    initSessionState: vi.fn().mockResolvedValue({
      sessionCtx: {},
      sessionEntry: {
        channel: "telegram",
        chatType: "private",
      },
      sessionKey: "session:123",
      isNewSession: false,
      commandAuthorized: true, // Auto-authorize for testing
      bodyStripped: "test message",
      triggerBodyNormalized: "test message",
    }),
  };
});

vi.mock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: vi.fn().mockImplementation(async ({ cleanedBody }) => {
    if (cleanedBody.startsWith("/")) {
      return {
        kind: "reply",
        reply: { text: "Inline Command Reply" },
      };
    }
    return {
      kind: "continue",
      directives: {},
      abortedLastRun: false,
    };
  }),
}));

// Mock command authorization to ensure /help is processed
vi.mock("../command-auth.js", () => ({
  resolveCommandAuthorization: vi.fn().mockReturnValue({
    providerId: "user123",
    ownerList: [],
    isAuthorizedSender: true,
    senderId: "user123",
    from: "user123",
    to: "bot",
  }),
}));

vi.mock("./inbound-context.js", () => ({
  finalizeInboundContext: (ctx: any) => ({ ...ctx, CommandAuthorized: true }),
}));

const mockConfig = {
  agents: {
    defaults: {
      details: { name: "TestBot" },
    },
  },
  session: {},
};

describe("Channel Interceptor", () => {
  beforeEach(() => {
    clearChannelInterceptor();
  });

  afterEach(() => {
    clearChannelInterceptor();
    vi.clearAllMocks();
  });

  const createCtx = (body: string): MsgContext =>
    ({
      Body: body,
      OneOnOne: true,
      Provider: "telegram",
      SenderId: "user123",
      SessionKey: "telegram:user123",
      CommandAuthorized: true,
      CommandSource: "platform",
    }) as unknown as MsgContext;

  it("should intercept normal messages", async () => {
    const interceptor = vi
      .fn()
      .mockReturnValue({ blocked: true, response: "Blocked by interceptor" });
    registerChannelInterceptor(interceptor);

    const result = await getReplyFromConfig(
      createCtx("hello"),
      {
        onTypingController: (tc) => tc,
      },
      mockConfig as any,
    );

    expect(interceptor).toHaveBeenCalled();
    expect(result).toEqual({ text: "Blocked by interceptor" });
  });

  it("should intercept inline commands like /help", async () => {
    const interceptor = vi
      .fn()
      .mockReturnValue({ blocked: true, response: "Blocked by interceptor" });
    registerChannelInterceptor(interceptor);

    const result = await getReplyFromConfig(
      createCtx("/help"),
      {
        onTypingController: (tc) => tc,
      },
      mockConfig as any,
    );

    expect(interceptor).toHaveBeenCalled();
    expect(result).toEqual({ text: "Blocked by interceptor" });
  });

  it("should allow messages when interceptor returns true", async () => {
    const interceptor = vi.fn().mockReturnValue(true);
    registerChannelInterceptor(interceptor);

    const result = await getReplyFromConfig(
      createCtx("hello"),
      {
        onTypingController: (tc) => tc,
      },
      mockConfig as any,
    );

    expect(interceptor).toHaveBeenCalled();
    expect(result).toEqual({ text: "Agent reply" });
  });
});
