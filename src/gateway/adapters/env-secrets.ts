/**
 * EnvSecretsProvider - Default environment-based implementation of SecretsProvider.
 *
 * This adapter reads secrets from process.env. For enterprise secrets management
 * with HashiCorp Vault or AWS Secrets Manager, use the appropriate adapter
 * from openclaw-enterprise.
 */

import type { SecretsProvider } from "../interfaces/secrets.js";

export class EnvSecretsProvider implements SecretsProvider {
  async getSecret(key: string): Promise<string | null> {
    return process.env[key] ?? null;
  }

  async isAvailable(): Promise<boolean> {
    // Environment variables are always available
    return true;
  }

  async refresh(): Promise<void> {
    // No-op - env vars don't need refreshing
  }
}
