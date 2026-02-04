import { describe, expect, it, vi } from "vitest";

describe("resolveSecretApiKey & resolveModelAuthModeAsync", () => {
  it("prioritizes SecretsProvider over process.env in resolveApiKeyForProvider", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "env-key";

    try {
      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      const secretsProvider = {
        getSecret: async (key: string) => {
          if (key === "OPENAI_API_KEY") return "secret-key";
          return null;
        },
        isAvailable: async () => true,
      };

      const resolved = await resolveApiKeyForProvider({
        provider: "openai",
        secretsProvider,
      });

      expect(resolved.apiKey).toBe("secret-key");
      expect(resolved.source).toContain("secret:OPENAI_API_KEY");
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it("checks precedence: SecretsProvider (OAuth) vs Env (API Key) in resolveModelAuthModeAsync", async () => {
    const previousKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "env-key";

    try {
      vi.resetModules();
      const { resolveModelAuthModeAsync, resolveApiKeyForProvider } =
        await import("./model-auth.js");

      const secretsProvider = {
        getSecret: async (key: string) => {
          if (key === "ANTHROPIC_OAUTH_TOKEN") return "secret-oauth-token";
          return null;
        },
        isAvailable: async () => true,
      };

      // 1. Verify what resolveApiKeyForProvider returns (the source of truth)
      const resolvedAuth = await resolveApiKeyForProvider({
        provider: "anthropic",
        secretsProvider,
      });
      expect(resolvedAuth.mode).toBe("oauth");
      expect(resolvedAuth.apiKey).toBe("secret-oauth-token");

      // 2. Verify what resolveModelAuthModeAsync returns
      const mode = await resolveModelAuthModeAsync(
        "anthropic",
        undefined,
        undefined,
        secretsProvider,
      );

      // Expected behavior: It MUST match the actual auth mode implied by secrets.
      expect(mode).toBe("oauth");
    } finally {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });
});
