// Running migrations.
//
// ClickHouse and Postgres differ here more than anywhere else. Postgres DDL is
// transactional, so a Postgres migration runs whole or not at all (`runPg`).
// ClickHouse's is not, which is what the rest of this comment is about.
//
// Unlike Drizzle's migrator (one transaction, apply by name) and Effect's
// (insert the ledger rows first, then run, inside a transaction), this one
// assumes nothing is atomic. Each statement is journaled after it finishes and
// the migration row is written last, so a failure leaves an honest ledger and a
// rerun resumes at the statement that failed.

import { Effect, Option } from "effect"
import { sha256Hex, type SchemaDialect } from "../schema/entities"
import type { RenderOptions } from "../schema/render"
import { MigrationDriver } from "./driver"
import { MigrateHashMismatch, MigrateLeaseHeld, MigrateSourceError, MigrateStepChanged, MigrateStepFailed, MigrateStepUncertain, type MigrateError } from "./errors"
import {
	ensureLedger,
	readApplied,
	readSteps,
	readLiveLeases,
	recordMigration,
	recordStep,
	writeLease,
	type AppliedRow,
} from "./ledger"
import { ensurePgLedger, isPgApplied, lockPg, readPgApplied, recordPgMigration, transactionOf } from "./pg-ledger"
import { dialectOf, stepsOf, type LoadedMigration } from "./source"

export interface RunOptions {
	readonly migrations: ReadonlyArray<LoadedMigration>
	/**
	 * The database being migrated. Read from the migrations' snapshots when
	 * omitted; a folder of hand-written SQL alone needs it said. Default
	 * `clickhouse`.
	 */
	readonly dialect?: SchemaDialect
	readonly render?: RenderOptions
	/** Fail when an applied migration's file has changed. Otherwise log a warning. */
	readonly strict?: boolean
	/** Names this run in the lease. Defaults to a random id. */
	readonly owner?: string
	/** How long the lease lasts without renewal. Each finished statement renews it. ClickHouse only. */
	readonly leaseSeconds?: number
}

const resolveDialect = (migrations: ReadonlyArray<LoadedMigration>, dialect: SchemaDialect | undefined): SchemaDialect =>
	dialect ?? dialectOf(migrations) ?? "clickhouse"

export interface AppliedMigration {
	readonly name: string
	readonly steps: number
	/** Steps skipped because an earlier run had finished them. */
	readonly resumedSteps: number
}

/** `uncertain`: a statement started and never reported back; see `resolveStep`. */
export type MigrationState = "applied" | "pending" | "partial" | "uncertain" | "changed"

export interface MigrationStatus {
	readonly name: string
	readonly state: MigrationState
	readonly appliedAt: string | undefined
}

const checkHash = (migration: LoadedMigration, applied: AppliedRow, strict: boolean) => {
	if (applied.hash === migration.hash) return Effect.void
	const error = new MigrateHashMismatch({
		migration: migration.name,
		appliedHash: applied.hash,
		currentHash: migration.hash,
		message: `${migration.name} changed after it was applied; write a new migration instead of editing this one`,
	})
	return strict ? Effect.fail(error) : Effect.logWarning(error.message)
}

const acquireLease = (owner: string, seconds: number) =>
	Effect.gen(function* () {
		const others = (yield* readLiveLeases).filter((lease) => lease.owner !== owner)
		const held = others[0]
		if (held !== undefined) {
			return yield* new MigrateLeaseHeld({
				owner: held.owner,
				expiresAt: held.expiresAt,
				message: `migrations are running as ${held.owner} until ${held.expiresAt}`,
			})
		}
		yield* writeLease(owner, seconds)
		// Two runs that both saw no lease: the older write wins, the other backs off.
		const first = (yield* readLiveLeases)[0]
		if (first !== undefined && first.owner !== owner) {
			yield* writeLease(owner, 0)
			return yield* new MigrateLeaseHeld({
				owner: first.owner,
				expiresAt: first.expiresAt,
				message: `migrations are running as ${first.owner} until ${first.expiresAt}`,
			})
		}
	})

const applyOne = (migration: LoadedMigration, render: RenderOptions, renew: Effect.Effect<void, MigrateError, MigrationDriver>) =>
	Effect.gen(function* () {
		const driver = yield* MigrationDriver
		const steps = stepsOf(migration, render)
		const journal = yield* readSteps(migration.name)
		let resumed = 0
		for (const step of steps) {
			const sqlHash = yield* Effect.promise(() => sha256Hex(step.sql))
			const previous = journal.get(step.id)
			if (previous?.state === "started") {
				return yield* new MigrateStepUncertain({
					migration: migration.name,
					step: step.id,
					sql: step.sql,
					message: `${migration.name} step ${step.id} started and never reported back, so it may or may not have run. Check the database, then record the outcome with resolveStep (effect-orm resolve)`,
				})
			}
			if (previous?.state === "done" && previous.sqlHash === sqlHash) {
				resumed += 1
				continue
			}
			// A finished step whose SQL is now different: the partial migration was
			// edited above the failure, or rendered with other options. Skipping it
			// would leave a statement unrun; rerunning it could repeat one.
			if (previous?.state === "done") {
				return yield* new MigrateStepChanged({
					migration: migration.name,
					step: step.id,
					message: `${migration.name} step ${step.id} already ran with different SQL. Edit only the failed statement and those after it, or keep the render options of the first run`,
				})
			}
			// Journal the attempt first: if the statement runs but the `done` row is
			// never written, the next run stops at this step instead of repeating it.
			yield* recordStep(migration.name, step.id, sqlHash, "started")
			yield* driver.execute(step.sql).pipe(
				Effect.tapError(() => recordStep(migration.name, step.id, sqlHash, "failed").pipe(Effect.ignore)),
				Effect.mapError(
					(cause) =>
						new MigrateStepFailed({
							migration: migration.name,
							step: step.id,
							sql: step.sql,
							message: `${migration.name} step ${step.id} failed: ${cause.message}`,
							cause,
						}),
				),
				Effect.withSpan("effect_orm.migrate.step", { attributes: { "effect_orm.migration.step": step.id } }),
			)
			yield* recordStep(migration.name, step.id, sqlHash, "done")
			yield* renew
		}
		yield* recordMigration(migration.name, migration.hash)
		const result: AppliedMigration = { name: migration.name, steps: steps.length, resumedSteps: resumed }
		return result
	}).pipe(
		Effect.withSpan("effect_orm.migrate.migration", { attributes: { "effect_orm.migration.name": migration.name } }),
	)

/**
 * Apply every migration not yet in the ledger, in order. Already-applied ones
 * have their hash checked. Returns what ran.
 */
export const run = (options: RunOptions): Effect.Effect<ReadonlyArray<AppliedMigration>, MigrateError, MigrationDriver> =>
	resolveDialect(options.migrations, options.dialect) === "postgres" ? runPg(options) : runClickHouse(options)

const runClickHouse = (options: RunOptions): Effect.Effect<ReadonlyArray<AppliedMigration>, MigrateError, MigrationDriver> =>
	Effect.gen(function* () {
		const render = options.render ?? {}
		const owner = options.owner ?? `effect-orm-${globalThis.crypto.randomUUID()}`
		const leaseSeconds = options.leaseSeconds ?? 600
		yield* ensureLedger(render)
		yield* acquireLease(owner, leaseSeconds)
		const work = Effect.gen(function* () {
			const applied = new Map((yield* readApplied).map((row) => [row.name, row]))
			const ran: Array<AppliedMigration> = []
			for (const migration of options.migrations) {
				const row = applied.get(migration.name)
				if (row !== undefined) {
					yield* checkHash(migration, row, options.strict ?? false)
					continue
				}
				ran.push(yield* applyOne(migration, render, writeLease(owner, leaseSeconds)))
			}
			return ran
		})
		return yield* work.pipe(Effect.ensuring(writeLease(owner, 0).pipe(Effect.ignore)))
	}).pipe(Effect.withSpan("effect_orm.migrate"))

/**
 * Postgres: each migration runs in its own transaction, with its ledger row,
 * under an advisory lock. A failed statement rolls the whole migration back;
 * the next run starts it again from the top. A migration another run applied
 * while this one waited for the lock is skipped.
 */
const runPg = (options: RunOptions): Effect.Effect<ReadonlyArray<AppliedMigration>, MigrateError, MigrationDriver> =>
	Effect.gen(function* () {
		const driver = yield* MigrationDriver
		yield* ensurePgLedger
		const applied = new Map((yield* readPgApplied).map((row) => [row.name, row]))
		const ran: Array<AppliedMigration> = []
		for (const migration of options.migrations) {
			const row = applied.get(migration.name)
			if (row !== undefined) {
				yield* checkHash(migration, row, options.strict ?? false)
				continue
			}
			const transaction = yield* transactionOf(driver, migration.name)
			const steps = stepsOf(migration)
			const result = yield* transaction(
				Effect.gen(function* () {
					yield* lockPg
					if (yield* isPgApplied(migration.name)) return undefined
					for (const step of steps) {
						yield* driver.execute(step.sql).pipe(
							Effect.mapError(
								(cause) =>
									new MigrateStepFailed({
										migration: migration.name,
										step: step.id,
										sql: step.sql,
										message: `${migration.name} step ${step.id} failed, and the migration was rolled back: ${cause.message}`,
										cause,
									}),
							),
							Effect.withSpan("effect_orm.migrate.step", { attributes: { "effect_orm.migration.step": step.id } }),
						)
					}
					yield* recordPgMigration(migration.name, migration.hash)
					const done: AppliedMigration = { name: migration.name, steps: steps.length, resumedSteps: 0 }
					return done
				}),
			).pipe(Effect.withSpan("effect_orm.migrate.migration", { attributes: { "effect_orm.migration.name": migration.name } }))
			if (result !== undefined) ran.push(result)
		}
		return ran
	}).pipe(Effect.withSpan("effect_orm.migrate"))

export interface BaselineOptions {
	readonly migrations: ReadonlyArray<LoadedMigration>
	/** The last migration the database already has. It and every migration before it are recorded as applied. */
	readonly upTo: string
	readonly dialect?: SchemaDialect
	readonly render?: RenderOptions
}

/**
 * Record migrations as applied without running them, for a database whose
 * schema another tool (drizzle-kit, a deploy pipeline) already built. Returns
 * the names it recorded; ones already in the ledger are left alone.
 */
export const baseline = (options: BaselineOptions): Effect.Effect<ReadonlyArray<string>, MigrateError, MigrationDriver> =>
	Effect.gen(function* () {
		const index = options.migrations.findIndex((m) => m.name === options.upTo)
		if (index === -1) return yield* new MigrateSourceError({ migration: options.upTo, message: "is not one of the migrations" })
		const postgres = resolveDialect(options.migrations, options.dialect) === "postgres"
		if (postgres) yield* ensurePgLedger
		else yield* ensureLedger(options.render ?? {})
		const applied = new Set((yield* postgres ? readPgApplied : readApplied).map((row) => row.name))
		const recorded: Array<string> = []
		for (const migration of options.migrations.slice(0, index + 1)) {
			if (applied.has(migration.name)) continue
			yield* postgres ? recordPgMigration(migration.name, migration.hash) : recordMigration(migration.name, migration.hash)
			recorded.push(migration.name)
		}
		return recorded
	})

/** Where each migration stands, without running anything. */
export const status = (
	migrations: ReadonlyArray<LoadedMigration>,
	render: RenderOptions = {},
	dialect?: SchemaDialect,
): Effect.Effect<ReadonlyArray<MigrationStatus>, MigrateError, MigrationDriver> =>
	Effect.gen(function* () {
		if (resolveDialect(migrations, dialect) === "postgres") {
			yield* ensurePgLedger
			const applied = new Map((yield* readPgApplied).map((row) => [row.name, row]))
			return migrations.map((migration): MigrationStatus => {
				const row = applied.get(migration.name)
				if (row === undefined) return { name: migration.name, state: "pending", appliedAt: undefined }
				return { name: migration.name, state: row.hash === migration.hash ? "applied" : "changed", appliedAt: row.appliedAt }
			})
		}
		yield* ensureLedger(render)
		const applied = new Map((yield* readApplied).map((row) => [row.name, row]))
		return yield* Effect.forEach(migrations, (migration) =>
			Effect.gen(function* () {
				const row = Option.fromNullishOr(applied.get(migration.name))
				if (Option.isSome(row)) {
					const state: MigrationState = row.value.hash === migration.hash ? "applied" : "changed"
					return { name: migration.name, state, appliedAt: row.value.appliedAt }
				}
				const journal = [...(yield* readSteps(migration.name)).values()]
				const state: MigrationState = journal.some((step) => step.state === "started")
					? "uncertain"
					: journal.some((step) => step.state === "done")
						? "partial"
						: "pending"
				return { name: migration.name, state, appliedAt: undefined }
			}),
		)
	})

export interface ResolveStepOptions {
	readonly migration: LoadedMigration
	/** The step id from `MigrateStepUncertain`. */
	readonly step: string
	/** What checking the database showed: the statement took effect, or it did not. */
	readonly outcome: "ran" | "not-ran"
	readonly render?: RenderOptions
	readonly dialect?: SchemaDialect
}

/**
 * Record the outcome of a step left uncertain, after checking the database.
 * `ran` marks it done so the next run skips it; `not-ran` marks it failed so
 * the next run executes it.
 */
export const resolveStep = (options: ResolveStepOptions): Effect.Effect<void, MigrateError, MigrationDriver> =>
	Effect.gen(function* () {
		const { migration } = options
		if (resolveDialect([migration], options.dialect) === "postgres") {
			return yield* new MigrateSourceError({
				migration: migration.name,
				message: "a Postgres migration runs in one transaction, so no step of it is ever uncertain",
			})
		}
		const step = stepsOf(migration, options.render ?? {}).find((s) => s.id === options.step)
		if (step === undefined) {
			return yield* new MigrateSourceError({ migration: migration.name, message: `has no step ${options.step}` })
		}
		yield* ensureLedger(options.render ?? {})
		const sqlHash = yield* Effect.promise(() => sha256Hex(step.sql))
		yield* recordStep(migration.name, step.id, sqlHash, options.outcome === "ran" ? "done" : "failed")
	})
