// @maple-dev/effect-orm/migrate
//
// Applies migrations written by `effect-orm generate` (or by hand) to a
// ClickHouse database through a `MigrationDriver` you provide. Statements are
// journaled one by one, so a failed run resumes where it stopped. See
// docs/migrations.md.

export { MigrationDriver, fromSqlClient, layerSqlClient, type FromSqlClientOptions, type MigrationDriverApi } from "./migrate/driver"
export {
	MigrateHashMismatch,
	MigrateLeaseHeld,
	MigrateSourceError,
	MigrateSqlError,
	MigrateStepChanged,
	MigrateStepFailed,
	type MigrateError,
} from "./migrate/errors"
export { LEDGER_TABLES } from "./migrate/ledger"
export {
	STATEMENT_BREAKPOINT,
	fromFileSystem,
	isStagingName,
	fromRecord,
	orderMigrations,
	stepsOf,
	type LoadedMigration,
	type MigrationInput,
	type MigrationStep,
} from "./migrate/source"
export { run, status, type AppliedMigration, type MigrationState, type MigrationStatus, type RunOptions } from "./migrate/run"
export { verify, type Drift, type VerifyResult } from "./migrate/verify"
