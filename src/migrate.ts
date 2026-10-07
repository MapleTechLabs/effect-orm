// @maple-dev/effect-orm/migrate
//
// Applies migrations written by `effect-orm generate` (or by hand) to a
// ClickHouse or Postgres database through a `MigrationDriver` you provide. On
// ClickHouse statements are journaled one by one, so a failed run resumes
// where it stopped; on Postgres each migration is one transaction. See
// docs/migrations.md.

export { MigrationDriver, fromSqlClient, layerSqlClient, type FromSqlClientOptions, type MigrationDriverApi } from "./migrate/driver"
export {
	MigrateHashMismatch,
	MigrateLeaseHeld,
	MigrateSourceError,
	MigrateSqlError,
	MigrateStepChanged,
	MigrateStepFailed,
	MigrateStepUncertain,
	type MigrateError,
} from "./migrate/errors"
export { LEDGER_TABLES } from "./migrate/ledger"
export {
	STATEMENT_BREAKPOINT,
	dialectOf,
	fromFileSystem,
	isStagingName,
	fromRecord,
	orderMigrations,
	stepsOf,
	type LoadedMigration,
	type MigrationInput,
	type MigrationStep,
} from "./migrate/source"
export {
	applyStep,
	baseline,
	completeMigration,
	pendingMigrations,
	planMigration,
	planSteps,
	resolveStep,
	run,
	status,
	type AppliedMigration,
	type MigrationPlan,
	type PlannedStep,
	type BaselineOptions,
	type MigrationState,
	type MigrationStatus,
	type ResolveStepOptions,
	type RunOptions,
} from "./migrate/run"
export { verify, type Drift, type VerifyOptions, type VerifyResult } from "./migrate/verify"
