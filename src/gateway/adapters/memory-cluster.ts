/**
 * MemoryClusterAdapter - Default in-memory implementation of ClusterStateAdapter.
 *
 * This adapter stores all cluster state in local Maps. It is suitable for
 * single-node deployments and development. For multi-node HA deployments,
 * use the Redis adapter from openclaw-enterprise.
 */

import type { ChatRunEntry, ClusterStateAdapter } from "../interfaces/cluster-state.js";

export class MemoryClusterAdapter implements ClusterStateAdapter {
  private chatRunQueues = new Map<string, { queue: ChatRunEntry[]; expiresAt: number }>();
  private subscriptions = new Map<string, Set<(message: unknown) => void>>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodically clean up expired entries
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  async setChatRunQueue(sessionId: string, queue: ChatRunEntry[], ttlMs: number): Promise<void> {
    this.chatRunQueues.set(sessionId, {
      queue,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async getChatRunQueue(sessionId: string): Promise<ChatRunEntry[] | null> {
    const record = this.chatRunQueues.get(sessionId);
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
      this.chatRunQueues.delete(sessionId);
      return null;
    }
    return record.queue;
  }

  async deleteChatRunQueue(sessionId: string): Promise<void> {
    this.chatRunQueues.delete(sessionId);
  }

  async publish(channel: string, message: unknown): Promise<void> {
    const handlers = this.subscriptions.get(channel);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(message);
        } catch {
          // Ignore handler errors
        }
      }
    }
  }

  async subscribe(channel: string, handler: (message: unknown) => void): Promise<void> {
    let handlers = this.subscriptions.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(channel, handlers);
    }
    handlers.add(handler);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subscriptions.delete(channel);
  }

  async getNodes(): Promise<{ id: string; status: "active" | "draining"; lastSeen: number }[]> {
    // Memory adapter only knows about self
    return [{ id: "local", status: "active", lastSeen: Date.now() }];
  }

  async drainNode(nodeId: string, drain: boolean): Promise<void> {
    // No-op for memory adapter
  }

  async registerNode(
    nodeId: string,
    metadata: { hostname: string; version: string },
    ttlMs: number,
  ): Promise<void> {
    // Memory adapter assumes single node, no need to register
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [sessionId, record] of this.chatRunQueues) {
      if (now > record.expiresAt) {
        this.chatRunQueues.delete(sessionId);
      }
    }
  }

  /**
   * Dispose of resources (for graceful shutdown).
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.chatRunQueues.clear();
    this.subscriptions.clear();
  }
}
