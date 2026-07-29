/**
 * Persistence Module Exports
 *
 * Central export point for the Thoughtbox persistence layer.
 * Uses in-memory storage for simplicity.
 */

// Types
export type {
  Config,
  Session,
  Run,
  CreateSessionParams,
  CreateRunParams,
  SessionFilter,
  ThoughtData,
  ThoughtInput,
  SessionManifest,
  ThoughtboxStorage,
  IntegrityValidationResult,
  TimePartitionGranularity,
  // Linked node types
  ThoughtNodeId,
  ThoughtNode,
  ThoughtIndexes,
  SessionExport,
  ExportOptions,
  AuditManifest,
} from './types.js';

// Storage implementations
export { InMemoryStorage, LinkedThoughtStore } from './storage.js';
export { FileSystemStorage, StorageNotScopedError } from './filesystem-storage.js';

// Session exporter
export { SessionExporter } from './export.js';
