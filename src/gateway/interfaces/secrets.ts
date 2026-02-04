/**
 * SecretsProvider - Interface for secrets management.
 *
 * This interface abstracts how the Gateway retrieves sensitive credentials.
 * The default implementation reads from process.env. Enterprise
 * implementations can integrate with HashiCorp Vault, AWS Secrets Manager,
 * or other secret stores.
 */

export interface SecretsProvider {
  /**
   * Retrieve a secret by its logical key name.
   * Returns null if the secret is not found.
   */
  getSecret(key: string): Promise<string | null>;

  /**
   * Check if the secrets provider is available and configured.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Refresh cached secrets (if applicable).
   * No-op for providers that don't cache.
   */
  refresh?(): Promise<void>;
}
