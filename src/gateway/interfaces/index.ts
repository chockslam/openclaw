/**
 * Gateway Interfaces - Extension points for enterprise adapters.
 *
 * These interfaces define the contracts that can be implemented by
 * enterprise adapters to provide Redis clustering, PostgreSQL storage,
 * SSO authentication, and enterprise secrets management.
 */

export type { ClusterStateAdapter, ChatRunEntry } from "./cluster-state.js";
export type {
  StorageAdapter,
  SessionEntry,
  SessionFilter,
  AuditEvent,
  TranscriptSortOrder,
  TranscriptPreviewItem,
  TranscriptLocation,
  TranscriptAppendInput,
  TranscriptAppendManyInput,
  TranscriptAppendManyResult,
  TranscriptReadInput,
  TranscriptReadEventsInput,
  TranscriptEventRecord,
  TranscriptPreviewInput,
  TranscriptCompactInput,
  TranscriptReplaceInput,
  TranscriptReplaceResult,
  TranscriptCloneInput,
  TranscriptCloneResult,
  TranscriptCompactResult,
  TranscriptDeleteResult,
  SessionLockInput,
} from "./storage.js";
export type { AuthProvider, UserPrincipal } from "./auth.js";
export type { SecretsProvider } from "./secrets.js";
