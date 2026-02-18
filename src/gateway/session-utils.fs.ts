import { getSessionStoreBridge } from "./session-store-bridge.js";

export function readFirstUserMessageFromTranscript(
  sessionId: string,
  storePath: string,
  sessionFile?: string,
): string | null {
  try {
    const bridge = getSessionStoreBridge();
    const cached = bridge.readFirstUserMessageFromTranscriptSync(sessionId);
    if (cached !== null) {
      return cached;
    }
    bridge.primeTranscriptSummary({
      sessionId,
      storePath,
      sessionFile,
    });
    return bridge.readFirstUserMessageFromTranscriptSync(sessionId);
  } catch {
    return null;
  }
}

export function readLastMessagePreviewFromTranscript(
  sessionId: string,
  storePath: string,
  sessionFile?: string,
): string | null {
  try {
    const bridge = getSessionStoreBridge();
    const cached = bridge.readLastMessagePreviewFromTranscriptSync(sessionId);
    if (cached !== null) {
      return cached;
    }
    bridge.primeTranscriptSummary({
      sessionId,
      storePath,
      sessionFile,
    });
    return bridge.readLastMessagePreviewFromTranscriptSync(sessionId);
  } catch {
    return null;
  }
}

export async function readSessionMessages(
  sessionId: string,
  storePath: string,
  sessionFile?: string,
): Promise<unknown[]> {
  return getSessionStoreBridge().readTranscriptMessages({
    sessionId,
    storePath,
    sessionFile,
  });
}

export async function readSessionPreviewItemsFromTranscript(
  sessionId: string,
  storePath: string,
  sessionFile?: string,
  opts?: { maxItems?: number; maxChars?: number },
): Promise<any[]> {
  // Use bridge preview if available, or just read messages
  return getSessionStoreBridge().readTranscriptPreview({
    sessionId,
    storePath,
    sessionFile,
    maxItems: opts?.maxItems ?? 20,
    maxChars: opts?.maxChars ?? 1000,
  });
}

export async function resolveSessionTranscriptCandidates(
  sessionId: string,
  storePath: string,
  sessionFile?: string,
): Promise<unknown[]> {
  return readSessionMessages(sessionId, storePath, sessionFile);
}

export function archiveFileOnDisk(filePath: string): string | null {
  void filePath;
  // No-op in adapter mode
  return null;
}

export function capArrayByJsonBytes(arr: unknown[], maxBytes: number): { items: unknown[] } {
  if (!Array.isArray(arr) || arr.length === 0) {
    return { items: [] };
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { items: [] };
  }
  const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf-8");
  let items = [...arr];
  while (items.length > 0 && sizeOf(items) > maxBytes) {
    items = items.slice(1);
  }
  return { items };
}
