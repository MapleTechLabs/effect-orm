import { ClickhouseClient } from "@effect/sql-clickhouse"
import { Effect, Exit, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as Migrate from "@maple-dev/effect-orm/migrate"
import * as S from "@maple-dev/effect-orm/schema"
import { endpoint } from "./clickhouse-support"

const user = process.env.EFFECT_ORM_CLICKHOUSE_USER ?? "default"
const password = process.env.EFFECT_ORM_CLICKHOUSE_PASSWORD ?? ""

const client = (database: string) => ClickhouseClient.layer({ url: endpoint!, username: user, password, database })

/** A fresh database per test, dropped afterwards. */
const withDatabase = <A, E>(body: Effect.Effect<A, E, Migrate.MigrationDriver | ClickhouseClient.ClickhouseClient>) =>
	Effect.gen(function* () {
		const database = `eo_migrate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
		const admin = yield* ClickhouseClient.ClickhouseClient
		yield* admin.asCommand(admin.unsafe(`CREATE DATABASE ${database}`))
		const scoped = Layer.provideMerge(
			Layer.effect(
				Migrate.MigrationDriver,
				Effect.gen(function* () {
					const sql = yield* ClickhouseClient.ClickhouseClient
					return Migrate.fromSqlClient(sql, { command: sql.asCommand })
				}),
			),
			client(database),
		)
		return yield* body.pipe(
			Effect.provide(scoped),
			Effect.ensuring(Effect.orDie(admin.asCommand(admin.unsafe(`DROP DATABASE IF EXISTS ${database} SYNC`)))),
		)
	}).pipe(Effect.provide(client("default")))

const Events = CH.table("events", {
	columns: {
		OrgId: CH.string,
		Timestamp: CH.column(CH.dateTime64, { codec: "Delta, ZSTD(1)" }),
		Name: CH.string,
		Count: CH.column(CH.uint64, { default: 1 }),
	},
	engine: CH.engine.mergeTree(),
	orderBy: ["OrgId", "Timestamp"],
	partitionBy: "toDate(Timestamp)",
	ttl: CH.ttlAfterDays("toDate(Timestamp)", 30),
	indexes: [CH.index("idx_name", ($) => $.Name, "bloom_filter(0.01)")],
})
const Totals = CH.table("totals", {
	columns: { OrgId: CH.string, Name: CH.string, Count: CH.uint64 },
	engine: CH.engine.summingMergeTree(),
	orderBy: ["OrgId", "Name"],
})
const TotalsMv = CH.materializedView("totals_mv", {
	to: Totals,
	as: CH.from(Events)
		.select(($) => ({ OrgId: $.OrgId, Name: $.Name, Count: CH.sum($.Count) }))
		.groupBy("OrgId", "Name"),
})

/** Generate one migration's files from two schemas, the way `effect-orm generate` does. */
const generated = (prevEntities: ReadonlyArray<S.SchemaEntity>, objects: ReadonlyArray<S.SchemaObject>, prevIds: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const entities = yield* S.entitiesOf(objects)
		const { ops, missingHints, unsupported } = S.diffSchemas(prevEntities, entities)
		expect(missingHints).toEqual([])
		expect(unsupported).toEqual([])
		const snapshot = yield* S.makeSnapshot(entities, prevIds)
		return {
			entities,
			snapshot,
			input: {
				kind: "ops" as const,
				migration: JSON.stringify({ version: "1", ops }),
				snapshot: S.serializeSnapshot(snapshot),
			},
		}
	})

describe("migrate", () => {
	describe.skipIf(!endpoint)("live", () => {
		it("applies, verifies clean, and is a no-op the second time", async () => {
			await Effect.runPromise(
				withDatabase(
					Effect.gen(function* () {
						const first = yield* generated([], [Events, Totals, TotalsMv], [S.ORIGIN_ID])
						const migrations = yield* Migrate.fromRecord({ "20261003000000_init": first.input })
						const ran = yield* Migrate.run({ migrations, strict: true })
						expect(ran.map((m) => m.name)).toEqual(["20261003000000_init"])
						expect(yield* Migrate.verify(migrations)).toEqual({ against: "20261003000000_init", drift: [] })
						expect(yield* Migrate.run({ migrations, strict: true })).toEqual([])
						expect((yield* Migrate.status(migrations)).map((s) => s.state)).toEqual(["applied"])
					}),
				),
			)
		})

		it("applies an additive change and recreates the changed view", async () => {
			await Effect.runPromise(
				withDatabase(
					Effect.gen(function* () {
						const first = yield* generated([], [Events, Totals, TotalsMv], [S.ORIGIN_ID])
						const Totals2 = CH.table("totals", {
							columns: { OrgId: CH.string, Name: CH.string, Count: CH.uint64, Events: CH.column(CH.uint64, { default: 0 }) },
							engine: CH.engine.summingMergeTree(),
							orderBy: ["OrgId", "Name"],
						})
						const Mv2 = CH.materializedView("totals_mv", {
							to: Totals2,
							as: CH.from(Events)
								.select(($) => ({ OrgId: $.OrgId, Name: $.Name, Count: CH.sum($.Count), Events: CH.count() }))
								.groupBy("OrgId", "Name"),
						})
						const second = yield* generated(first.entities, [Events, Totals2, Mv2], [first.snapshot.id])
						const migrations = yield* Migrate.fromRecord({
							"20261003000000_init": first.input,
							"20261003000100_events_column": second.input,
						})
						yield* Migrate.run({ migrations })
						expect((yield* Migrate.verify(migrations)).drift).toEqual([])
						const sql = yield* ClickhouseClient.ClickhouseClient
						yield* sql.asCommand(sql.unsafe("INSERT INTO events (OrgId, Timestamp, Name) VALUES ('o', now64(3), 'a'), ('o', now64(3), 'a')"))
						const rows = yield* sql.unsafe<{ Count: string; Events: string }>("SELECT sum(Count) AS Count, sum(Events) AS Events FROM totals")
						expect(rows.map((r) => [Number(r.Count), Number(r.Events)])).toEqual([[2, 2]])
					}),
				),
			)
		})

		it("journals each statement, so a failed run resumes where it stopped", async () => {
			await Effect.runPromise(
				withDatabase(
					Effect.gen(function* () {
						const broken = yield* Migrate.fromRecord({
							"20261003000000_hand": {
								kind: "sql",
								migration: `CREATE TABLE a (x UInt8) ENGINE = MergeTree ORDER BY x\n${Migrate.STATEMENT_BREAKPOINT}\nTHIS IS NOT SQL`,
							},
						})
						const exit = yield* Effect.exit(Migrate.run({ migrations: broken }))
						expect(Exit.isFailure(exit)).toBe(true)
						expect(String(exit)).toContain("MigrateStepFailed")
						expect((yield* Migrate.status(broken)).map((s) => s.state)).toEqual(["partial"])

						// Not applied yet, so fixing the file is allowed. The CREATE (which
						// has no IF NOT EXISTS) must not run again.
						const fixed = yield* Migrate.fromRecord({
							"20261003000000_hand": {
								kind: "sql",
								migration: `CREATE TABLE a (x UInt8) ENGINE = MergeTree ORDER BY x\n${Migrate.STATEMENT_BREAKPOINT}\nCREATE TABLE b (x UInt8) ENGINE = MergeTree ORDER BY x`,
							},
						})
						const ran = yield* Migrate.run({ migrations: fixed })
						expect(ran).toEqual([{ name: "20261003000000_hand", steps: 2, resumedSteps: 1 }])
					}),
				),
			)
		})

		it("refuses to resume a partial migration edited above the failed statement", async () => {
			await Effect.runPromise(
				withDatabase(
					Effect.gen(function* () {
						const source = (...statements: Array<string>) =>
							Migrate.fromRecord({ "20261003000000_hand": { kind: "sql", migration: statements.join(`\n${Migrate.STATEMENT_BREAKPOINT}\n`) } })
						const createA = "CREATE TABLE a (x UInt8) ENGINE = MergeTree ORDER BY x"
						yield* Effect.exit(Migrate.run({ migrations: yield* source(createA, "THIS IS NOT SQL") }))
						const inserted = yield* source("CREATE TABLE z (x UInt8) ENGINE = MergeTree ORDER BY x", createA, "SELECT 1")
						const exit = yield* Effect.exit(Migrate.run({ migrations: inserted }))
						expect(String(exit)).toContain("MigrateStepChanged")
						expect((yield* Migrate.status(inserted)).map((s) => s.state)).toEqual(["partial"])
					}),
				),
			)
		})

		it("stops at a statement that started and never reported back, until it is resolved", async () => {
			await Effect.runPromise(
				withDatabase(
					Effect.gen(function* () {
						const migrations = yield* Migrate.fromRecord({
							"20261003000000_hand": {
								kind: "sql",
								migration: `CREATE TABLE counts (n UInt8) ENGINE = MergeTree ORDER BY n\n${Migrate.STATEMENT_BREAKPOINT}\nINSERT INTO counts VALUES (1)`,
							},
						})
						const sql = yield* ClickhouseClient.ClickhouseClient
						// The INSERT ran but its `done` row was never written: what a crash between the two leaves.
						yield* sql.asCommand(sql.unsafe("CREATE TABLE counts (n UInt8) ENGINE = MergeTree ORDER BY n"))
						yield* Migrate.run({ migrations: yield* Migrate.fromRecord({}) })
						const [migration] = migrations
						const steps = Migrate.stepsOf(migration!)
						yield* Migrate.resolveStep({ migration: migration!, step: "0", outcome: "ran" })
						yield* sql.asCommand(sql.unsafe("INSERT INTO counts VALUES (1)"))
						yield* sql.asCommand(
							sql.unsafe(
								`INSERT INTO ${Migrate.LEDGER_TABLES.steps} (name, step, sql_hash, state, seq) VALUES ('20261003000000_hand', '1', 'x', 'started', ${Date.now() * 1000 + 999})`,
							),
						)
						expect(steps).toHaveLength(2)
						expect((yield* Migrate.status(migrations)).map((s) => s.state)).toEqual(["uncertain"])
						const exit = yield* Effect.exit(Migrate.run({ migrations }))
						expect(String(exit)).toContain("MigrateStepUncertain")

						yield* Migrate.resolveStep({ migration: migration!, step: "1", outcome: "ran" })
						expect(yield* Migrate.run({ migrations })).toEqual([{ name: "20261003000000_hand", steps: 2, resumedSteps: 2 }])
						const rows = yield* sql.unsafe<{ c: string }>("SELECT count() AS c FROM counts")
						expect(Number(rows[0]?.c)).toBe(1)
					}),
				),
			)
		})

		it("rejects an edited migration under strict", async () => {
			await Effect.runPromise(
				withDatabase(
					Effect.gen(function* () {
						const sql = (body: string) =>
							Migrate.fromRecord({ "20261003000000_hand": { kind: "sql", migration: body } })
						yield* Migrate.run({ migrations: yield* sql("CREATE TABLE a (x UInt8) ENGINE = MergeTree ORDER BY x") })
						const edited = yield* sql("CREATE TABLE a (x UInt16) ENGINE = MergeTree ORDER BY x")
						expect((yield* Migrate.status(edited)).map((s) => s.state)).toEqual(["changed"])
						const exit = yield* Effect.exit(Migrate.run({ migrations: edited, strict: true }))
						expect(String(exit)).toContain("MigrateHashMismatch")
						expect(yield* Migrate.run({ migrations: edited })).toEqual([])
					}),
				),
			)
		})

		it("refuses to run while another run holds the lease", async () => {
			await Effect.runPromise(
				withDatabase(
					Effect.gen(function* () {
						const migrations = yield* Migrate.fromRecord({})
						yield* Migrate.run({ migrations, owner: "warmup" })
						const sql = yield* ClickhouseClient.ClickhouseClient
						yield* sql.asCommand(
							sql.unsafe(`INSERT INTO ${Migrate.LEDGER_TABLES.lease} (owner, expires_at) VALUES ('other', now64(3) + toIntervalMinute(5))`),
						)
						const exit = yield* Effect.exit(Migrate.run({ migrations, owner: "me" }))
						expect(String(exit)).toContain("MigrateLeaseHeld")
					}),
				),
			)
		})

		it("backfills in day windows, and an orchestrator resumes at the next window", async () => {
			await Effect.runPromise(
				withDatabase(
					Effect.gen(function* () {
						const first = yield* generated([], [Events, Totals], [S.ORIGIN_ID])
						const sql = yield* ClickhouseClient.ClickhouseClient
						const backfill: S.BackfillSpec = {
							target: "totals",
							columns: ["OrgId", "Name", "Count"],
							from: "events",
							timeColumn: "Timestamp",
							select: "OrgId, Name, sum(Count)",
							groupBy: "OrgId, Name",
						}
						const migrations = yield* Migrate.fromRecord({
							"20261003000000_init": first.input,
							"20261003000100_backfill": {
								kind: "ops",
								migration: JSON.stringify({ version: "1", ops: [{ op: "backfill", backfill }] }),
								snapshot: S.serializeSnapshot(yield* S.makeSnapshot(first.entities, [first.snapshot.id])),
							},
						})
						yield* Migrate.run({ migrations: migrations.slice(0, 1) })
						yield* sql.asCommand(
							sql.unsafe(
								"INSERT INTO events (OrgId, Timestamp, Name) SELECT 'o', toStartOfDay(now64(3)) - toIntervalDay(number) + 3600, 'a' FROM numbers(3)",
							),
						)

						const [pending] = yield* Migrate.pendingMigrations({ migrations })
						const plan = yield* Migrate.planMigration(pending!)
						expect(plan.steps.map((step) => step.id)).toHaveLength(3)
						expect(plan.steps.every((step) => step.id.startsWith("0.") && !step.done)).toBe(true)
						yield* Migrate.applyStep(plan.name, plan.steps[0]!)

						const resumed = yield* Migrate.planMigration(pending!)
						expect(resumed.steps.map((step) => step.done)).toEqual([true, false, false])
						const ran = yield* Migrate.run({ migrations })
						expect(ran).toEqual([{ name: "20261003000100_backfill", steps: 3, resumedSteps: 1 }])
						const rows = yield* sql.unsafe<{ Count: string }>("SELECT sum(Count) AS Count FROM totals")
						expect(Number(rows[0]!.Count)).toBe(3)
					}),
				),
			)
		})

		it("reports drift against the last applied snapshot", async () => {
			await Effect.runPromise(
				withDatabase(
					Effect.gen(function* () {
						const first = yield* generated([], [Events, Totals, TotalsMv], [S.ORIGIN_ID])
						const migrations = yield* Migrate.fromRecord({ "20261003000000_init": first.input })
						yield* Migrate.run({ migrations })
						const sql = yield* ClickhouseClient.ClickhouseClient
						yield* sql.asCommand(sql.unsafe("ALTER TABLE events ADD COLUMN Extra String"))
						yield* sql.asCommand(sql.unsafe("ALTER TABLE totals MODIFY COLUMN Count UInt32"))
						yield* sql.asCommand(sql.unsafe("DROP VIEW totals_mv"))
						const { drift } = yield* Migrate.verify(migrations)
						expect(drift).toEqual(
							expect.arrayContaining([
								{ entity: "totals_mv", problem: "missing" },
								{ entity: "events.Extra", problem: "unexpected" },
								{ entity: "totals.Count", problem: "type", expected: "UInt64", actual: "UInt32" },
							]),
						)
						expect(drift).toHaveLength(3)
					}),
				),
			)
		})
	})
})
