/**
 * Gateway Adapters - Default implementations for open source deployments.
 *
 * These adapters provide in-memory, file-based, and environment-based
 * implementations suitable for single-node deployments. Enterprise
 * adapters (Redis, PostgreSQL, OIDC, Vault) are available separately.
 */

export { MemoryClusterAdapter } from "./memory-cluster.js";
export { PostgresStorageAdapter } from "./postgres-storage.js";
export {
  closeRuntimeStorageAdapter,
  createRuntimeStorageAdapter,
  type RuntimeStorageAdapterOptions,
} from "./runtime-storage.js";

export { TokenAuthProvider, type TokenAuthConfig } from "./token-auth.js";
export { EnvSecretsProvider } from "./env-secrets.js";
