/**
 * TokenAuthProvider - Default token-based implementation of AuthProvider.
 *
 * This adapter validates requests against a shared token from config or env.
 * For enterprise SSO/OIDC integration, use the OIDC adapter from openclaw-enterprise.
 */

import type { IncomingMessage } from "node:http";
import type { AuthProvider, UserPrincipal } from "../interfaces/auth.js";

export interface TokenAuthConfig {
  /**
   * The shared token to validate against.
   */
  token?: string;
  /**
   * If true, authentication is disabled (allow all requests).
   */
  disabled?: boolean;
}

export class TokenAuthProvider implements AuthProvider {
  private token: string | null;
  private disabled: boolean;

  constructor(config: TokenAuthConfig = {}) {
    this.token = config.token ?? process.env.OPENCLAW_AUTH_TOKEN ?? null;
    this.disabled = config.disabled ?? false;
  }

  async validate(req: IncomingMessage): Promise<UserPrincipal | null> {
    if (this.disabled || !this.token) {
      // Auth disabled - return anonymous user
      return {
        id: "anonymous",
        roles: ["user"],
      };
    }

    // Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const [scheme, token] = authHeader.split(" ");
      if (scheme?.toLowerCase() === "bearer" && token === this.token) {
        return {
          id: "token-user",
          roles: ["user", "admin"],
        };
      }
    }

    // Check query parameter (for WebSocket connections)
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const queryToken = url.searchParams.get("token");
    if (queryToken === this.token) {
      return {
        id: "token-user",
        roles: ["user", "admin"],
      };
    }

    return null;
  }

  getLoginUrl(): string | null {
    // Token auth doesn't have a login URL
    return null;
  }
}
