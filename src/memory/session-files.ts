import { getSessionStoreBridge } from "../gateway/session-store-bridge.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hashText } from "./internal.js";

const log = createSubsystemLogger("memory");

export type SessionFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
};

function parseSessionIdFromSource(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("session://")) {
    return trimmed.slice("session://".length).trim();
  }
  const withoutQuery = trimmed.split("?")[0]?.split("#")[0] ?? trimmed;
  const tail = withoutQuery.split("/").pop() ?? withoutQuery;
  return tail.replace(/\.jsonl$/i, "").trim();
}

export async function listSessionFilesForAgent(agentId: string): Promise<string[]> {
  const bridge = getSessionStoreBridge();
  const sessions = await bridge.listSessions({ agentId });
  return sessions
    .map(({ entry, key }) => entry.sessionId?.trim() || key.trim())
    .filter((sessionId) => Boolean(sessionId))
    .map((sessionId) => `session://${sessionId}`);
}

export function sessionPathForFile(absPath: string): string {
  const sessionId = parseSessionIdFromSource(absPath);
  return `sessions/${sessionId}`;
}

function normalizeSessionText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = normalizeSessionText(content);
    return normalized ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const normalized = normalizeSessionText(record.text);
    if (normalized) {
      parts.push(normalized);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

export async function buildSessionEntry(absPath: string): Promise<SessionFileEntry | null> {
  try {
    const sessionId = parseSessionIdFromSource(absPath);
    if (!sessionId) {
      return null;
    }

    const bridge = getSessionStoreBridge();
    const meta = await bridge.getSessionMetadata(sessionId);
    if (!meta) {
      return null;
    }

    const raw = await bridge.getSessionContent(sessionId);
    if (raw === null) {
      return null;
    }

    if (meta.size === 0) {
      meta.size = Buffer.byteLength(raw, "utf-8");
    }

    const lines = raw.split("\n");
    const collected: string[] = [];
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !record ||
        typeof record !== "object" ||
        (record as { type?: unknown }).type !== "message"
      ) {
        continue;
      }
      const message = (record as { message?: unknown }).message as
        | { role?: unknown; content?: unknown }
        | undefined;
      if (!message || typeof message.role !== "string") {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text = extractSessionText(message.content);
      if (!text) {
        continue;
      }
      const safe = redactSensitiveText(text, { mode: "tools" });
      const label = message.role === "user" ? "User" : "Assistant";
      collected.push(`${label}: ${safe}`);
    }

    const content = collected.join("\n");
    return {
      path: sessionPathForFile(absPath),
      absPath,
      mtimeMs: meta.mtimeMs,
      size: meta.size,
      hash: hashText(content),
      content,
    };
  } catch (err) {
    log.debug(`Failed reading session transcript ${absPath}: ${String(err)}`);
    return null;
  }
}
