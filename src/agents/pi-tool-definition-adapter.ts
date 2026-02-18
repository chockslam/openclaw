import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import { logDebug, logError } from "../logger.js";
import { runBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import { normalizeToolName } from "./tool-policy.js";
import { jsonResult } from "./tools/common.js";

// oxlint-disable-next-line typescript/no-explicit-any
type AnyAgentTool = AgentTool<any, unknown>;

type ToolExecuteArgsCurrent = [
  string,
  unknown,
  AgentToolUpdateCallback<unknown> | undefined,
  unknown,
  AbortSignal | undefined,
];
type ToolExecuteArgsLegacy = [
  string,
  unknown,
  AbortSignal | undefined,
  AgentToolUpdateCallback<unknown> | undefined,
  unknown,
];
type ToolExecuteArgs = ToolDefinition["execute"] extends (...args: infer P) => unknown
  ? P
  : ToolExecuteArgsCurrent;
type ToolExecuteArgsAny = ToolExecuteArgs | ToolExecuteArgsLegacy | ToolExecuteArgsCurrent;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value;
}

function isLegacyToolExecuteArgs(args: ToolExecuteArgsAny): args is ToolExecuteArgsLegacy {
  const third = args[2];
  const fourth = args[3];
  return isAbortSignal(third) || typeof fourth === "function";
}

function describeToolExecutionError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const message = err.message?.trim() ? err.message : String(err);
    return { message, stack: err.stack };
  }
  return { message: String(err) };
}

function parseMissingPathFromEnoent(message: string): string | null {
  if (!/ENOENT/i.test(message)) {
    return null;
  }
  const quoted = message.match(/'(.*?)'/);
  if (quoted?.[1]) {
    return quoted[1];
  }
  const doubleQuoted = message.match(/"(.*?)"/);
  if (doubleQuoted?.[1]) {
    return doubleQuoted[1];
  }
  return null;
}

function isOptionalMemoryPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = path.posix.basename(normalized);
  if (base === "MEMORY.md" || base === "memory.md") {
    return true;
  }
  if (/(^|\/)memory\/\d{4}-\d{2}-\d{2}\.md$/i.test(normalized)) {
    return true;
  }
  return /(^|\/)memory$/i.test(normalized);
}

function isGuessedDailyMemoryPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  return /(^|\/)memory\/\d{4}-\d{2}-\d{2}\.md$/i.test(normalized);
}

function buildPreflightMemoryReadResult(
  normalizedToolName: string,
  params: unknown,
): AgentToolResult<unknown> | null {
  if (normalizedToolName !== "read") {
    return null;
  }
  const inputPath =
    params && typeof params === "object" && typeof (params as { path?: unknown }).path === "string"
      ? (params as { path: string }).path
      : null;
  if (!inputPath || !isGuessedDailyMemoryPath(inputPath)) {
    return null;
  }
  return jsonResult({
    path: inputPath,
    text: "",
    content: "",
    missing: true,
    note: "Guessed daily memory file paths are disabled; use memory_search and memory_get.",
  });
}

function buildOptionalMemoryReadMissResult(
  normalizedToolName: string,
  params: unknown,
  message: string,
): AgentToolResult<unknown> | null {
  if (normalizedToolName !== "read") {
    return null;
  }
  const inputPath =
    params && typeof params === "object" && typeof (params as { path?: unknown }).path === "string"
      ? (params as { path: string }).path
      : parseMissingPathFromEnoent(message);
  if (!inputPath || !isOptionalMemoryPath(inputPath)) {
    return null;
  }
  return jsonResult({
    path: inputPath,
    text: "",
    content: "",
    missing: true,
    note: "Optional memory file is missing; continue with memory_search/session memory.",
  });
}

function splitToolExecuteArgs(args: ToolExecuteArgsAny): {
  toolCallId: string;
  params: unknown;
  onUpdate: AgentToolUpdateCallback<unknown> | undefined;
  signal: AbortSignal | undefined;
} {
  if (isLegacyToolExecuteArgs(args)) {
    const [toolCallId, params, signal, onUpdate] = args;
    return {
      toolCallId,
      params,
      onUpdate,
      signal,
    };
  }
  const [toolCallId, params, onUpdate, _ctx, signal] = args;
  return {
    toolCallId,
    params,
    onUpdate,
    signal,
  };
}

export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => {
    const name = tool.name || "tool";
    const normalizedName = normalizeToolName(name);
    return {
      name,
      label: tool.label ?? name,
      description: tool.description ?? "",
      parameters: tool.parameters,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params, onUpdate, signal } = splitToolExecuteArgs(args);
        const preflightMemoryRead = buildPreflightMemoryReadResult(normalizedName, params);
        if (preflightMemoryRead) {
          logDebug(
            `[tools] ${normalizedName} skipped guessed daily memory file path; returning empty result`,
          );
          return preflightMemoryRead;
        }
        try {
          return await tool.execute(toolCallId, params, signal, onUpdate);
        } catch (err) {
          if (signal?.aborted) {
            throw err;
          }
          const name =
            err && typeof err === "object" && "name" in err
              ? String((err as { name?: unknown }).name)
              : "";
          if (name === "AbortError") {
            throw err;
          }
          const described = describeToolExecutionError(err);
          const optionalMemoryMiss = buildOptionalMemoryReadMissResult(
            normalizedName,
            params,
            described.message,
          );
          if (optionalMemoryMiss) {
            logDebug(
              `[tools] ${normalizedName} optional memory file missing; returning empty result`,
            );
            return optionalMemoryMiss;
          }
          if (described.stack && described.stack !== described.message) {
            logDebug(`tools: ${normalizedName} failed stack:\n${described.stack}`);
          }
          logError(`[tools] ${normalizedName} failed: ${described.message}`);
          return jsonResult({
            status: "error",
            tool: normalizedName,
            error: described.message,
          });
        }
      },
    } satisfies ToolDefinition;
  });
}

// Convert client tools (OpenResponses hosted tools) to ToolDefinition format
// These tools are intercepted to return a "pending" result instead of executing
export function toClientToolDefinitions(
  tools: ClientToolDefinition[],
  onClientToolCall?: (toolName: string, params: Record<string, unknown>) => void,
  hookContext?: { agentId?: string; sessionKey?: string },
): ToolDefinition[] {
  return tools.map((tool) => {
    const func = tool.function;
    return {
      name: func.name,
      label: func.name,
      description: func.description ?? "",
      // oxlint-disable-next-line typescript/no-explicit-any
      parameters: func.parameters as any,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params } = splitToolExecuteArgs(args);
        const outcome = await runBeforeToolCallHook({
          toolName: func.name,
          params,
          toolCallId,
          ctx: hookContext,
        });
        if (outcome.blocked) {
          throw new Error(outcome.reason);
        }
        const adjustedParams = outcome.params;
        const paramsRecord = isPlainObject(adjustedParams) ? adjustedParams : {};
        // Notify handler that a client tool was called
        if (onClientToolCall) {
          onClientToolCall(func.name, paramsRecord);
        }
        // Return a pending result - the client will execute this tool
        return jsonResult({
          status: "pending",
          tool: func.name,
          message: "Tool execution delegated to client",
        });
      },
    } satisfies ToolDefinition;
  });
}
