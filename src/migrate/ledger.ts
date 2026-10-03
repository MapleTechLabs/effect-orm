// The migration ledger, kept in the database being migrated.
//
// ClickHouse has no transactions and no unique keys, so the ledger is
// append-only and read with FINAL:
//
// - `_effect_orm_migrations`: one row per applied migration, written only
//   after every statement in it finished. Never written first.
// - `_effect_orm_migration_steps`: the latest state of each statement:
//   `started` is written before it runs, then `done` or `failed`. A run that
//   stopped halfway resumes after the last `done`. A statement left at
//   `started` may or may not have run (the process died, or the `done` row was
//   never written), so it is never re-run automatically; see `resolveStep`.
// - `_effect_orm_migration_lease`: who is migrating, until when. Best effort:
//   two runs that start within the same instant can both see an empty lease.
//   Callers that need a hard guarantee serialize runs themselves.

import { Effect } from "effect"
import { quoteClickHouseString } from "../sql/sql-fragment"
import { ident, type RenderOptions } from "../schema/render"
import { MigrationDriver } from "./driver"
import type { MigrateSqlError } from "./errors"

export const LEDGER_TABLES = {
	migrations: "_effect_orm_migrations",
	steps: "_effect_orm_migration_steps",
	lease: "_effect_orm_migration_lease",
} as const

const q = quoteClickHouseString

const ledgerEngine = (options: RenderOptions, version: string): string =>
	options.replicated === undefined
		? `ReplacingMergeTree(${version})`
		: `ReplicatedReplacingMergeTree(${q(options.replicated.path ?? "/clickhouse/tables/{shard}/{database}/{table}")}, ${q(options.replicated.replica ?? "{replica}")}, ${version})`

const cluster = (options: RenderOptions): string =>
	options.cluster === undefined ? "" : ` ON CLUSTER ${ident(options.cluster)}`

export const ensureLedger = (options: RenderOptions): Effect.Effect<void, MigrateSqlError, MigrationDriver> =>
	Effect.gen(function* () {
		const driver = yield* MigrationDriver
		yield* driver.execute(
			`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLES.migrations}${cluster(options)} (name String, hash String, applied_at DateTime64(3) DEFAULT now64(3)) ENGINE = ${ledgerEngine(options, "applied_at")} ORDER BY name`,
		)
		yield* driver.execute(
			`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLES.steps}${cluster(options)} (name String, step String, sql_hash String, state LowCardinality(String), seq UInt64, finished_at DateTime64(3) DEFAULT now64(3)) ENGINE = ${ledgerEngine(options, "seq")} ORDER BY (name, step)`,
		)
		yield* driver.execute(
			`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLES.lease}${cluster(options)} (owner String, expires_at DateTime64(3), written_at DateTime64(3) DEFAULT now64(3)) ENGINE = ${ledgerEngine(options, "written_at")} ORDER BY owner`,
		)
	})

export interface AppliedRow {
	readonly name: string
	readonly hash: string
	readonly appliedAt: string
}

export const readApplied = Effect.gen(function* () {
	const driver = yield* MigrationDriver
	const rows = yield* driver.query(
		`SELECT name, hash, toString(applied_at) AS applied FROM ${LEDGER_TABLES.migrations} FINAL ORDER BY applied_at, name`,
	)
	return rows.map((row): AppliedRow => ({ name: String(row.name), hash: String(row.hash), appliedAt: String(row.applied) }))
})

export type StepState = "started" | "done" | "failed"

export interface StepRow {
	readonly sqlHash: string
	readonly state: StepState
}

/** The latest state of each statement of a migration. */
export const readSteps = (name: string) =>
	Effect.gen(function* () {
		const driver = yield* MigrationDriver
		const rows = yield* driver.query(`SELECT step, sql_hash, state FROM ${LEDGER_TABLES.steps} FINAL WHERE name = ${q(name)}`)
		return new Map(
			rows.map((row) => {
				const state = String(row.state)
				const parsed: StepState = state === "started" || state === "failed" ? state : "done"
				return [String(row.step), { sqlHash: String(row.sql_hash), state: parsed }] as const
			}),
		)
	})

// The ReplacingMergeTree version: strictly increasing within a process, so a
// state written after another always wins even inside one millisecond.
let lastSeq = 0
const nextSeq = (): number => {
	lastSeq = Math.max(lastSeq + 1, Date.now() * 1000)
	return lastSeq
}

export const recordStep = (name: string, step: string, sqlHash: string, state: StepState) =>
	Effect.gen(function* () {
		const driver = yield* MigrationDriver
		yield* driver.execute(
			`INSERT INTO ${LEDGER_TABLES.steps} (name, step, sql_hash, state, seq) VALUES (${q(name)}, ${q(step)}, ${q(sqlHash)}, ${q(state)}, ${nextSeq()})`,
		)
	})

export const recordMigration = (name: string, hash: string) =>
	Effect.gen(function* () {
		const driver = yield* MigrationDriver
		yield* driver.execute(`INSERT INTO ${LEDGER_TABLES.migrations} (name, hash) VALUES (${q(name)}, ${q(hash)})`)
	})

export interface LeaseRow {
	readonly owner: string
	readonly expiresAt: string
}

/** Leases that have not expired, oldest first. */
export const readLiveLeases = Effect.gen(function* () {
	const driver = yield* MigrationDriver
	const rows = yield* driver.query(
		`SELECT owner, toString(expires_at) AS expires FROM ${LEDGER_TABLES.lease} FINAL WHERE expires_at > now64(3) ORDER BY written_at, owner`,
	)
	return rows.map((row): LeaseRow => ({ owner: String(row.owner), expiresAt: String(row.expires) }))
})

export const writeLease = (owner: string, seconds: number) =>
	Effect.gen(function* () {
		const driver = yield* MigrationDriver
		yield* driver.execute(
			`INSERT INTO ${LEDGER_TABLES.lease} (owner, expires_at) VALUES (${q(owner)}, now64(3) + toIntervalSecond(${Math.max(0, Math.trunc(seconds))}))`,
		)
	})
