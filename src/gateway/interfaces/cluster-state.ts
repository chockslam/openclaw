/**
 * ClusterStateAdapter - Interface for ephemeral cluster state management.
 *
 * This interface abstracts how the Gateway stores transient runtime state
 * (e.g., active chat runs, connected nodes). The default implementation
 * uses in-memory Maps. Enterprise implementations can use Redis for
 * horizontal scaling across multiple Gateway nodes.
 */

export interface ChatRunEntry {
  sessionKey: string;
  clientRunId: string;
  // Allow additional properties for enterprise extensions
  [key: string]: unknown;
}

export interface GatewayNodeInfo {
  id: string;
  status: "active" | "draining";
  lastSeen: number;
  hostname: string;
  version: string;
}

export interface ClusterStateAdapter {
  /**
   * Store the chat run queue for a session.
   */
  setChatRunQueue(sessionId: string, queue: ChatRunEntry[], ttlMs: number): Promise<void>;

  /**
   * Retrieve the chat run queue for a session.
   */
  getChatRunQueue(sessionId: string): Promise<ChatRunEntry[] | null>;

  /**
   * Remove the chat run queue for a session.
   */
  deleteChatRunQueue(sessionId: string): Promise<void>;

  /**
   * Publish a message to a channel (for cross-node communication).
   */
  publish(channel: string, message: unknown): Promise<void>;

  /**
   * Subscribe to a channel for incoming messages.
   */
  subscribe(channel: string, handler: (message: unknown) => void): Promise<void>;

  /**
   * Unsubscribe from a channel.
   */
  unsubscribe(channel: string): Promise<void>;

  /**
   * Get active Gateway nodes in the cluster.
   * (Admin API)
   */
  getNodes(): Promise<{ id: string; status: "active" | "draining"; lastSeen: number }[]>;

  /**
   * Mark a node for draining or maintenance.
   * (Admin API)
   */
  drainNode(nodeId: string, drain: boolean): Promise<void>;

  /**
   * Register self as an active node (heartbeat).
   */
  registerNode(
    nodeId: string,
    metadata: { hostname: string; version: string },
    ttlMs: number,
  ): Promise<void>;
}
