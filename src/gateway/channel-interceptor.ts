/**
 * Channel Interceptor
 *
 * Enterprise hook to intercept channel messages before they reach the LLM.
 * Allows blocking messages or returning a direct response without calling the model.
 */

/**
 * Result of a channel interceptor call.
 * - `true` - Allow the message to proceed to the LLM
 * - `false` - Block the message silently (no response)
 * - `{ blocked: true, response: string }` - Block and send a direct response
 */
export type ChannelInterceptorResult = true | false | { blocked: true; response: string };

/**
 * Payload passed to the channel interceptor.
 */
export interface ChannelInterceptorPayload {
  /** Channel type: "telegram", "discord", "webchat", etc. */
  channel: string;
  /** Session key for this conversation */
  sessionKey: string;
  /** Provider-specific user ID (e.g., Telegram user ID) */
  providerId: string;
  /** The message content */
  message: string;
  /** Optional: account ID within the channel (for multi-account setups) */
  accountId?: string;
}

/**
 * Channel interceptor function signature.
 */
export type ChannelInterceptor = (
  payload: ChannelInterceptorPayload,
) => Promise<ChannelInterceptorResult> | ChannelInterceptorResult;

// Global channel interceptor registry
let globalChannelInterceptor: ChannelInterceptor | null = null;

/**
 * Register a channel interceptor globally.
 * Called by enterprise server during startup.
 */
export function registerChannelInterceptor(interceptor: ChannelInterceptor): void {
  globalChannelInterceptor = interceptor;
}

/**
 * Get the registered channel interceptor.
 */
export function getChannelInterceptor(): ChannelInterceptor | null {
  return globalChannelInterceptor;
}

/**
 * Clear the channel interceptor (for testing).
 */
export function clearChannelInterceptor(): void {
  globalChannelInterceptor = null;
}
