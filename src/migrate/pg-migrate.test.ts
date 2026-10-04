import { PgliteClient } from "@effect/sql-pglite"
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as CH from "../ch/index"
import * as Migrate from "../migrate"
import * as PG from "../postgres"
import * as S from "../schema"

const Dashboards = PG.table("dashboards", {
	columns: {
		org_id: PG.text,
		id: PG.text,
		status: PG.column(PG.text, { default: "open" }),
		tags: PG.column(PG.array(PG.text), { default: [] }),
		layout: PG.column(PG.jsonb(), { default: {} }),
		archived: PG.column(PG.bool, { default: false }),
		created_at: PG.column(PG.timestamptz, { defaultExpr: "now()" }),
		archived_at: PG.nullable(PG.timestamptz),
		embedding: PG.nullable(PG.array(PG.float4)),
	},
	primaryKey: { columns: ["org_id", "id"], name: "dashboards_org_id_id_pk" },
	indexes: [
		PG.index("dashboards_open_idx", ["org_id"], { where: ($) => $.status.in_("open", "waiting") }),
		PG.index("dashboards_created_idx", ($) => [$.org_id, `"created_at" DESC`]),
	],
})

const Shares = PG.table("dashboard_shares", {
	columns: {
		org_id: PG.text,
		id: PG.text,
		dashboard_id: PG.text,
		widget_id: PG.nullable(PG.text),
		revoked_at: PG.nullable(PG.timestamptz),
	},
	primaryKey: ["org_id", "id"],
	indexes: [
		PG.uniqueIndex("dashboard_shares_live_unq", ($) => [$.org_id, $.dashboard_id, CH.coalesce($.widget_id, CH.lit(""))], {
			where: "revoked_at is null",
		}),
	],
	foreignKeys: [
		PG.foreignKey({ columns: ["org_id", "dashboard_id"], references: Dashboards, foreignColumns: ["org_id", "id"], onDelete: "cascade" }),
	],
})

/** A generated migration from `prev` to `next`, as `generate` would write it. */
const generated = (prev: ReadonlyArray<S.PgSchemaEntity>, next: ReadonlyArray<S.PgSchemaEntity>, prevIds: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const { ops, missingHints } = S.diffPgSchemas(prev, next)
		assert.deepStrictEqual(missingHints, [])
		const snapshot = yield* S.makeSnapshot(next, prevIds, "postgres")
		return {
			snapshot,
			input: {
				kind: "ops" as const,
				migration: JSON.stringify({ version: "1", dialect: "postgres", ops }),
				snapshot: S.serializeSnapshot(snapshot),
			},
		}
	})

const Live = Migrate.layerSqlClient().pipe(Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })))

const tables = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const rows = yield* sql.unsafe<{ name: string }>(
		"SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename",
	)
	return rows.map((r) => r.name)
})

describe("Postgres migrations", () => {
	it.effect("apply generated migrations once, record them, and verify with no drift", () =>
		Effect.gen(function* () {
			const v1 = S.pgEntitiesOf([Dashboards])
			const v2 = S.pgEntitiesOf([Dashboards, Shares])
			const first = yield* generated([], v1, [S.ORIGIN_ID])
			const second = yield* generated(v1, v2, [first.snapshot.id])
			const migrations = yield* Migrate.fromRecord({ "20261004000000_init": first.input, "20261004000001_shares": second.input })

			const ran = yield* Migrate.run({ migrations })
			expect(ran.map((m) => m.name)).toEqual(["20261004000000_init", "20261004000001_shares"])
			expect(yield* tables).toEqual(["_effect_orm_migrations", "dashboard_shares", "dashboards"])
			expect(yield* Migrate.run({ migrations })).toEqual([])
			expect((yield* Migrate.status(migrations)).map((s) => s.state)).toEqual(["applied", "applied"])

			const result = yield* Migrate.verify(migrations)
			expect(result).toEqual({ against: "20261004000001_shares", drift: [] })

			// The constraints the snapshot describes are the ones the database enforces.
			const sql = yield* SqlClient.SqlClient
			yield* sql.unsafe(`INSERT INTO dashboards (org_id, id) VALUES ('o', 'd')`)
			yield* sql.unsafe(`INSERT INTO dashboard_shares (org_id, id, dashboard_id) VALUES ('o', 's1', 'd')`)
			const duplicate = yield* Effect.exit(sql.unsafe(`INSERT INTO dashboard_shares (org_id, id, dashboard_id) VALUES ('o', 's2', 'd')`))
			expect(Exit.isFailure(duplicate)).toBe(true)
			yield* sql.unsafe(`DELETE FROM dashboards`)
			expect(yield* sql.unsafe(`SELECT * FROM dashboard_shares`)).toEqual([])
		}).pipe(Effect.provide(Live)),
	)

	it.effect("verify reports drift in columns, defaults, indexes, keys, and extra tables", () =>
		Effect.gen(function* () {
			const v1 = S.pgEntitiesOf([Dashboards, Shares])
			const first = yield* generated([], v1, [S.ORIGIN_ID])
			const migrations = yield* Migrate.fromRecord({ "20261004000000_init": first.input })
			yield* Migrate.run({ migrations })

			const sql = yield* SqlClient.SqlClient
			yield* sql.unsafe(`ALTER TABLE dashboards ALTER COLUMN status SET DEFAULT 'closed'`)
			yield* sql.unsafe(`ALTER TABLE dashboards ALTER COLUMN archived_at SET NOT NULL`)
			yield* sql.unsafe(`ALTER TABLE dashboards ADD COLUMN extra int4`)
			yield* sql.unsafe(`DROP INDEX dashboards_open_idx`)
			yield* sql.unsafe(`CREATE INDEX dashboards_open_idx ON dashboards (org_id) WHERE status = 'open'`)
			yield* sql.unsafe(`ALTER TABLE dashboard_shares DROP CONSTRAINT dashboard_shares_org_id_dashboard_id_dashboards_org_id_id_fk`)
			yield* sql.unsafe(`CREATE TABLE stray (a int)`)

			const { drift } = yield* Migrate.verify(migrations)
			expect(drift.map((d) => `${d.problem} ${d.entity}`).sort()).toEqual([
				"default dashboards.status",
				"index dashboards.dashboards_open_idx",
				"missing dashboard_shares.dashboard_shares_org_id_dashboard_id_dashboards_org_id_id_fk",
				"not_null dashboards.archived_at",
				"unexpected dashboards.extra",
				"unexpected stray",
			])
			expect(drift.find((d) => d.problem === "default")).toMatchObject({ expected: "'open'::text", actual: "'closed'::text" })
			expect((yield* Migrate.verify(migrations, { ignoreTables: ["stray"] })).drift).toHaveLength(5)
			// The scratch schema verify builds the expectation in is rolled back.
			const schemas = yield* sql.unsafe<{ n: string }>(`SELECT nspname AS n FROM pg_namespace WHERE nspname LIKE '_effect_orm_verify%'`)
			expect(schemas).toEqual([])
		}).pipe(Effect.provide(Live)),
	)

	it.effect("a failed statement rolls the whole migration back, and the next run starts it again", () =>
		Effect.gen(function* () {
			const broken = { kind: "sql" as const, migration: "CREATE TABLE a (x int)\n--> statement-breakpoint\nCREATE TABLE a (x int)" }
			const failing = yield* Migrate.fromRecord({ "20261004000000_first": broken })
			const exit = yield* Effect.exit(Migrate.run({ migrations: failing, dialect: "postgres" }))
			assert(Exit.isFailure(exit))
			const error = exit.cause.reasons.find((r) => r._tag === "Fail")
			expect(error?._tag === "Fail" && error.error._tag).toBe("@maple-dev/effect-orm/MigrateStepFailed")
			expect(yield* tables).toEqual(["_effect_orm_migrations"])
			expect((yield* Migrate.status(failing, {}, "postgres")).map((s) => s.state)).toEqual(["pending"])

			const fixed = yield* Migrate.fromRecord({ "20261004000000_first": { kind: "sql", migration: "CREATE TABLE a (x int)" } })
			expect((yield* Migrate.run({ migrations: fixed, dialect: "postgres" })).map((m) => m.steps)).toEqual([1])
			expect(yield* tables).toEqual(["_effect_orm_migrations", "a"])
		}).pipe(Effect.provide(Live)),
	)

	it.effect("an applied migration whose file changed fails under strict", () =>
		Effect.gen(function* () {
			const v1 = yield* Migrate.fromRecord({ "20261004000000_a": { kind: "sql", migration: "CREATE TABLE a (x int)" } })
			yield* Migrate.run({ migrations: v1, dialect: "postgres" })
			const edited = yield* Migrate.fromRecord({ "20261004000000_a": { kind: "sql", migration: "CREATE TABLE a (y int)" } })
			const exit = yield* Effect.exit(Migrate.run({ migrations: edited, dialect: "postgres", strict: true }))
			assert(Exit.isFailure(exit))
			expect((yield* Migrate.status(edited, {}, "postgres"))[0]?.state).toBe("changed")
		}).pipe(Effect.provide(Live)),
	)

	it.effect("baseline adopts a database another tool built: legacy SQL is recorded, not run", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			// What drizzle-kit (or a deploy pipeline) already applied.
			yield* sql.unsafe(`CREATE TABLE legacy (id text PRIMARY KEY)`)
			const base = yield* S.makeSnapshot(S.pgEntitiesOf([PG.table("legacy", { columns: { id: PG.text }, primaryKey: ["id"] })]), [S.ORIGIN_ID], "postgres")
			const migrations = yield* Migrate.fromRecord({
				"20260101000000_drizzle_init": {
					kind: "sql",
					migration: `CREATE TABLE "legacy" ("id" text PRIMARY KEY)`,
					snapshot: JSON.stringify({ version: "8", dialect: "postgres", id: "d", prevIds: [], ddl: [], renames: [] }),
				},
				"20261004000000_baseline": { kind: "sql", migration: "-- Baseline: runs nothing.\n", snapshot: S.serializeSnapshot(base) },
				"20261004000001_next": { kind: "sql", migration: "ALTER TABLE legacy ADD COLUMN name text" },
			})
			expect(migrations[0]?.foreignSnapshot?.tool).toBe("drizzle-kit")
			expect(Migrate.dialectOf(migrations)).toBe("postgres")

			expect(yield* Migrate.baseline({ migrations, upTo: "20261004000000_baseline" })).toEqual([
				"20260101000000_drizzle_init",
				"20261004000000_baseline",
			])
			expect((yield* Migrate.run({ migrations })).map((m) => m.name)).toEqual(["20261004000001_next"])
			// Verify compares against the baseline's snapshot, the last applied one with a snapshot.
			const { against, drift } = yield* Migrate.verify(migrations)
			expect(against).toBe("20261004000000_baseline")
			expect(drift).toEqual([{ entity: "legacy.name", problem: "unexpected" }])
		}).pipe(Effect.provide(Live)),
	)

	it.effect("resolveStep has nothing to resolve on Postgres", () =>
		Effect.gen(function* () {
			const [migration] = yield* Migrate.fromRecord({ "20261004000000_a": { kind: "sql", migration: "SELECT 1" } })
			const exit = yield* Effect.exit(Migrate.resolveStep({ migration: migration!, step: "0", outcome: "ran", dialect: "postgres" }))
			expect(Exit.isFailure(exit)).toBe(true)
		}).pipe(Effect.provide(Live)),
	)
})
