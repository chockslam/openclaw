/**
 * LLM-based slug generator for session memory filenames
 */

import type { OpenClawConfig } from "../config/config.js";
import {
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  resolveAgentDir,
} from "../agents/agent-scope.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";

/**
 * Generate a short 1-2 word filename slug from session content using LLM
 */
export async function generateSlugViaLLM(params: {
  sessionContent: string;
  cfg: OpenClawConfig;
}): Promise<string | null> {
  try {
    const agentId = resolveDefaultAgentId(params.cfg);
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    const agentDir = resolveAgentDir(params.cfg, agentId);
    const tempSessionFile = `session://slug-generator-${Date.now()}`;

    const prompt = `Based on this conversation, generate a short 1-2 word filename slug (lowercase, hyphen-separated, no file extension).

Conversation summary:
${params.sessionContent.slice(0, 2000)}

Reply with ONLY the slug, nothing else. Examples: "vendor-pitch", "api-design", "bug-fix"`;

    const result = await runEmbeddedPiAgent({
      sessionId: `slug-generator-${Date.now()}`,
      sessionKey: "temp:slug-generator",
      sessionFile: tempSessionFile,
      workspaceDir,
      agentDir,
      config: params.cfg,
      prompt,
      timeoutMs: 15_000, // 15 second timeout
      runId: `slug-gen-${Date.now()}`,
    });

    // Extract text from payloads
    if (result.payloads && result.payloads.length > 0) {
      const text = result.payloads[0]?.text;
      if (text) {
        // Clean up the response - extract just the slug
        const slug = text
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 30); // Max 30 chars

        return slug || null;
      }
    }

    return null;
  } catch (err) {
    console.error("[llm-slug-generator] Failed to generate slug:", err);
    return null;
  }
}
