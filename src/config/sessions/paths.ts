import type { SessionEntry } from "./types.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";

function resolveAgentStoreId(agentId?: string): string {
  const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
  return `store://agent/${id}`;
}

export function resolveSessionTranscriptsDir(
  _env: NodeJS.ProcessEnv = process.env,
  _homedir: () => string = () => "",
): string {
  return `${resolveAgentStoreId(DEFAULT_AGENT_ID)}/transcripts`;
}

export function resolveSessionTranscriptsDirForAgent(
  agentId?: string,
  _env: NodeJS.ProcessEnv = process.env,
  _homedir: () => string = () => "",
): string {
  return `${resolveAgentStoreId(agentId)}/transcripts`;
}

export function resolveDefaultSessionStorePath(agentId?: string): string {
  return resolveAgentStoreId(agentId);
}

export function resolveSessionTranscriptPath(
  sessionId: string,
  _agentId?: string,
  topicId?: string | number,
): string {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return "session://";
  }
  const safeTopicId =
    typeof topicId === "string"
      ? encodeURIComponent(topicId)
      : typeof topicId === "number"
        ? String(topicId)
        : undefined;
  if (safeTopicId !== undefined) {
    return `session://${normalizedSessionId}?topic=${safeTopicId}`;
  }
  return `session://${normalizedSessionId}`;
}

export function resolveSessionFilePath(
  sessionId: string,
  entry?: SessionEntry,
  opts?: { agentId?: string },
): string {
  void entry;
  void opts;
  // Session runtime is DB-native; keep this as a stable virtual identifier.
  return `session://${sessionId}`;
}

export function resolveStorePath(store?: string, opts?: { agentId?: string }) {
  const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);
  const trimmedStore = store?.trim();
  if (!trimmedStore) {
    return resolveDefaultSessionStorePath(agentId);
  }
  return trimmedStore.replaceAll("{agentId}", agentId);
}
