export {
  createDb,
  ensurePostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  type MigrationState,
  type MigrationHistoryReconcileResult,
  migratePostgresIfEmpty,
  type MigrationBootstrapResult,
  type Db,
} from "./client.js";
export {
  runDatabaseBackup,
  formatDatabaseBackupResult,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
} from "./backup-lib.js";
export * from "./schema/index.js";

// Re-export drizzle-orm operators so consumers use the same instance as the schema.
// This prevents type conflicts from multiple drizzle-orm peer-dep resolutions.
export {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
