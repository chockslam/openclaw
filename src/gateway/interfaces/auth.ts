/**
 * AuthProvider - Interface for authentication providers.
 *
 * This interface abstracts how the Gateway authenticates requests.
 * The default implementation validates against a shared token.
 * Enterprise implementations can integrate with OIDC/SAML providers
 * like Okta, Azure AD, or Auth0.
 */

import type { IncomingMessage } from "node:http";

export interface UserPrincipal {
  id: string;
  email?: string;
  roles: string[];
  metadata?: Record<string, unknown>;
}

export interface AuthProvider {
  /**
   * Validate an incoming request and return the user principal if valid.
   * Returns null if authentication fails.
   */
  validate(req: IncomingMessage): Promise<UserPrincipal | null>;

  /**
   * Get the login URL for browser-based auth flows (e.g., OIDC redirect).
   * Returns null if not applicable (e.g., token-based auth).
   */
  getLoginUrl?(): string | null;

  /**
   * Handle the auth callback (e.g., OIDC code exchange).
   * Returns the user principal if successful.
   */
  handleCallback?(req: IncomingMessage): Promise<UserPrincipal | null>;
}
