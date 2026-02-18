import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

describe("pi tool definition adapter", () => {
  it("wraps tool errors into a tool result", async () => {
    const tool = {
      name: "boom",
      label: "Boom",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call1", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "boom",
    });
    expect(result.details).toMatchObject({ error: "nope" });
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call2", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "nope",
    });
  });

  it("returns empty non-error result for optional missing memory files", async () => {
    const missingPath = "/root/.openclaw/workspace/memory/2026-02-12.md";
    const tool = {
      name: "read",
      label: "Read",
      description: "reads files",
      parameters: {},
      execute: async () => {
        throw new Error(`ENOENT: no such file or directory, access '${missingPath}'`);
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call3", { path: missingPath }, undefined, undefined);

    expect(result.details).toMatchObject({
      path: missingPath,
      missing: true,
    });
    expect((result.details as { status?: unknown }).status).toBeUndefined();
  });

  it("returns empty non-error result for optional missing memory directory", async () => {
    const missingPath = "/root/.openclaw/workspace/memory";
    const tool = {
      name: "read",
      label: "Read",
      description: "reads files",
      parameters: {},
      execute: async () => {
        throw new Error(`ENOENT: no such file or directory, access '${missingPath}'`);
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call4", { path: missingPath }, undefined, undefined);

    expect(result.details).toMatchObject({
      path: missingPath,
      missing: true,
    });
    expect((result.details as { status?: unknown }).status).toBeUndefined();
  });

  it("short-circuits guessed daily memory reads before tool execute", async () => {
    const guessedPath = "/root/.openclaw/workspace/memory/2026-02-15.md";
    let called = false;
    const tool = {
      name: "read",
      label: "Read",
      description: "reads files",
      parameters: {},
      execute: async () => {
        called = true;
        return {
          content: [{ type: "text", text: "should not execute" }],
          details: { ok: true },
        };
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call5", { path: guessedPath }, undefined, undefined);

    expect(called).toBe(false);
    expect(result.details).toMatchObject({
      path: guessedPath,
      missing: true,
    });
  });
});
