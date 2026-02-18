type SessionTranscriptUpdate = {
  sessionId: string;
  agentId?: string;
  seq?: number;
  updatedAt?: number;
};

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

export function emitSessionTranscriptUpdate(update: SessionTranscriptUpdate): void {
  const sessionId = update.sessionId.trim();
  if (!sessionId) {
    return;
  }
  const normalized: SessionTranscriptUpdate = {
    sessionId,
    agentId: update.agentId?.trim() || undefined,
    seq: typeof update.seq === "number" ? update.seq : undefined,
    updatedAt: typeof update.updatedAt === "number" ? update.updatedAt : Date.now(),
  };
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    listener(normalized);
  }
}

export type { SessionTranscriptUpdate };

export function emitLegacySessionTranscriptUpdate(sessionIdOrUri: string): void {
  const trimmed = sessionIdOrUri.trim();
  if (!trimmed) {
    return;
  }
  const sessionId = trimmed.startsWith("session://")
    ? trimmed.slice("session://".length).trim()
    : trimmed;
  if (!sessionId) {
    return;
  }
  emitSessionTranscriptUpdate({ sessionId, updatedAt: Date.now() });
}
