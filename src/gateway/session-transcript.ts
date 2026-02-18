import { randomUUID } from "node:crypto";
import type { ChatImageContent } from "./chat-attachments.js";
import { getSessionStoreBridge } from "./session-store-bridge.js";

export interface TranscriptAppendResult {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
}

export async function appendUserTranscriptMessage(params: {
  message: string;
  images?: ChatImageContent[];
  sessionId: string;
  storePath: string | undefined;
  agentId?: string;
  sessionFile?: string;
  createIfMissing?: boolean;
}): Promise<TranscriptAppendResult> {
  const now = Date.now();
  const messageId = randomUUID().slice(0, 8);

  const content: unknown[] = [{ type: "text", text: params.message }];
  if (params.images && params.images.length > 0) {
    for (const img of params.images) {
      content.push({
        type: "image",
        data: img.data,
        mimeType: img.mimeType,
      });
    }
  }

  const messageBody: Record<string, unknown> = {
    role: "user",
    content,
    timestamp: now,
  };

  const transcriptEntry = {
    type: "message",
    id: messageId,
    timestamp: new Date(now).toISOString(),
    message: messageBody,
  } satisfies Record<string, unknown>;

  try {
    console.log(`[Transcript] Appending user message: sessionId=${params.sessionId}`);
    await getSessionStoreBridge().appendTranscriptEvent({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      storePath: params.storePath,
      agentId: params.agentId,
      event: transcriptEntry,
      createIfMissing: params.createIfMissing,
    });
  } catch (err) {
    console.error(`[Transcript] appendUserTranscriptMessage failed: ${String(err)}`);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, messageId, message: transcriptEntry.message };
}

export async function appendAssistantTranscriptMessage(params: {
  message: string;
  label?: string;
  sessionId: string;
  storePath: string | undefined;
  agentId?: string;
  sessionFile?: string;
  createIfMissing?: boolean;
}): Promise<TranscriptAppendResult> {
  const now = Date.now();
  const messageId = randomUUID().slice(0, 8);

  const messageBody: Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text: params.message }],
    api: "openai-responses",
    provider: "openclaw",
    model: "delivery-mirror",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: now,
    label: params.label,
  };

  const transcriptEntry = {
    type: "message",
    id: messageId,
    timestamp: new Date(now).toISOString(),
    message: messageBody,
  } satisfies Record<string, unknown>;

  try {
    await getSessionStoreBridge().appendTranscriptEvent({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      storePath: params.storePath,
      agentId: params.agentId,
      event: transcriptEntry,
      createIfMissing: params.createIfMissing,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, messageId, message: transcriptEntry.message };
}
