import type { OpenClawConfig } from "../config/config.js";
import type { MemorySearchManager } from "./types.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";

export type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
};

export async function getMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<MemorySearchManagerResult> {
  try {
    const manager = await getBuiltinMemoryManager(params);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manager: null, error: message };
  }
}

async function getBuiltinMemoryManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<MemorySearchManager | null> {
  const settings = resolveMemorySearchConfig(params.cfg, params.agentId);
  if (!settings) {
    return null;
  }

  if (settings.store.driver === "postgres") {
    const { PostgresMemoryIndexManager } = await import("./manager-postgres.js");
    return await PostgresMemoryIndexManager.get(params);
  }

  const { MemoryIndexManager } = await import("./manager.js");
  return await MemoryIndexManager.get(params);
}
