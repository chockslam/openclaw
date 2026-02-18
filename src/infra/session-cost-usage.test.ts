import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createMockStorageAdapter } from "../../test/helpers/mock-storage-adapter.js";
import {
  initializeSessionStoreBridge,
  getSessionStoreBridge,
} from "../gateway/session-store-bridge.js";
import { loadCostUsageSummary, loadSessionCostSummary } from "./session-cost-usage.js";

describe("session cost usage", () => {
  it("aggregates daily totals with log cost and pricing fallback", async () => {
    initializeSessionStoreBridge(createMockStorageAdapter());
    const bridge = getSessionStoreBridge();
    const sessionId = "sess-1";

    const now = new Date();
    const older = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

    const entries = [
      {
        type: "message",
        timestamp: now.toISOString(),
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.2",
          usage: {
            input: 10,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 30,
            cost: { total: 0.03 },
          },
        },
      },
      {
        type: "message",
        timestamp: now.toISOString(),
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.2",
          usage: {
            input: 10,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 20,
          },
        },
      },
      {
        type: "message",
        timestamp: older.toISOString(),
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.2",
          usage: {
            input: 5,
            output: 5,
            totalTokens: 10,
            cost: { total: 0.01 },
          },
        },
      },
    ];

    await bridge.saveSession(sessionId, {
      sessionId,
      updatedAt: Date.now(),
    });
    await bridge.appendTranscriptEvents({
      sessionId,
      events: entries as Record<string, unknown>[],
      createIfMissing: true,
    });

    const config = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5.2",
                cost: {
                  input: 1,
                  output: 2,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const summary = await loadCostUsageSummary({ days: 30, config });
    expect(summary.daily.length).toBe(1);
    expect(summary.totals.totalTokens).toBe(50);
    expect(summary.totals.totalCost).toBeCloseTo(0.03003, 5);
  });

  it("summarizes a single session file", async () => {
    initializeSessionStoreBridge(createMockStorageAdapter());
    const bridge = getSessionStoreBridge();
    const sessionId = "sess-single";
    const now = new Date();

    await bridge.saveSession(sessionId, {
      sessionId,
      updatedAt: Date.now(),
    });
    await bridge.appendTranscriptEvents({
      sessionId,
      events: [
        {
          type: "message",
          timestamp: now.toISOString(),
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-5.2",
            usage: {
              input: 10,
              output: 20,
              totalTokens: 30,
              cost: { total: 0.03 },
            },
          },
        },
      ],
      createIfMissing: true,
    });

    const summary = await loadSessionCostSummary({
      sessionId,
    });
    expect(summary?.totalCost).toBeCloseTo(0.03, 5);
    expect(summary?.totalTokens).toBe(30);
    expect(summary?.lastActivity).toBeGreaterThan(0);
  });
});
