// The Postgres migration ledger.
//
// One table, `_effect_orm_migrations`, with a row per applied migration. A
// Postgres migration runs in one transaction together with its ledger row, so
// the ClickHouse ledger's step journal and lease have nothing to do here: a
// migration is applied or it is not. Concurrent runs are serialized with a
// transaction-scoped advisory lock, which a pooled connection cannot leak.

import { Effect } from "effect"
import { MigrationDriver } from "./driver"
import { MigrateSourceError, type MigrateSqlError } from "./errors"
import { LEDGER_TABLES, type AppliedRow } from "./ledger"

/** The advisory lock every effect-orm migration run takes. Arbitrary, fixed. */
export const PG_MIGRATION_LOCK = 7_243_567_198

const table = `"${LEDGER_TABLES.migrations}"`
const q = (value: string): string => `'${value.replace(/'/g, "''")}'`

/** The driver's transaction, which Postgres migrations cannot run without. */
export const transactionOf = (driver: typeof MigrationDriver.Service, migration: string) =>
	driver.transaction === undefined
		? Effect.fail(
				new MigrateSourceError({
					migration,
					message: "Postgres migrations run in a transaction, and this MigrationDriver has none; build it with fromSqlClient",
				}),
			)
		: Effect.succeed(driver.transaction)

/** Wait for the migration lock, inside the current transaction. */
export const lockPg = Effect.gen(function* () {
	const driver = yield* MigrationDriver
	yield* driver.query(`SELECT pg_advisory_xact_lock(${PG_MIGRATION_LOCK})`)
})

export const ensurePgLedger: Effect.Effect<void, MigrateSqlError | MigrateSourceError, MigrationDriver> = Effect.gen(function* () {
	const driver = yield* MigrationDriver
	const transaction = yield* transactionOf(driver, LEDGER_TABLES.migrations)
	// Under the lock: two runs creating the table at once would collide in pg_type.
	yield* transaction(
		Effect.gen(function* () {
			yield* lockPg
			yield* driver.execute(
				`CREATE TABLE IF NOT EXISTS ${table} (name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
			)
		}),
	)
})

export const readPgApplied = Effect.gen(function* () {
	const driver = yield* MigrationDriver
	const rows = yield* driver.query(`SELECT name, hash, applied_at::text AS applied FROM ${table} ORDER BY applied_at, name`)
	return rows.map((row): AppliedRow => ({ name: String(row.name), hash: String(row.hash), appliedAt: String(row.applied) }))
})

export const isPgApplied = (name: string) =>
	Effect.gen(function* () {
		const driver = yield* MigrationDriver
		const rows = yield* driver.query(`SELECT 1 AS applied FROM ${table} WHERE name = ${q(name)}`)
		return rows.length > 0
	})

export const recordPgMigration = (name: string, hash: string) =>
	Effect.gen(function* () {
		const driver = yield* MigrationDriver
		yield* driver.execute(`INSERT INTO ${table} (name, hash) VALUES (${q(name)}, ${q(hash)}) ON CONFLICT (name) DO NOTHING`)
	})
