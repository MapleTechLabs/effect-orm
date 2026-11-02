// `findMany` on SQLite (node:sqlite) and on a local D1 binding. D1 binds at
// most 100 values per statement, so a level with more keys than that is split
// into several `IN (...)` statements.
import * as D1Client from "@effect/sql-d1/D1Client"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { Miniflare } from "miniflare"
import { expect, it } from "vitest"
import * as Db from "../database"
import * as SQLite from "../sqlite"

const Units = SQLite.table("units", { id: SQLite.integer, org_id: SQLite.text, name: SQLite.text }, { tenantColumn: "org_id" })
const Locks = SQLite.table("locks", { id: SQLite.integer, org_id: SQLite.text, unit_id: SQLite.integer }, { tenantColumn: "org_id" })
const schema = Db.defineRelations({ units: Units, locks: Locks }, (r) => ({
	units: { locks: r.many("locks", { from: "id", to: "unit_id" }) },
	locks: { unit: r.one("units", { from: "unit_id", to: "id" }) },
}))

const setup = (db: Db.DatabaseApi, units: number) =>
	Effect.gen(function* () {
		yield* db.execute({ sql: "CREATE TABLE units (id INTEGER PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL)" })
		yield* db.execute({ sql: "CREATE TABLE locks (id INTEGER PRIMARY KEY, org_id TEXT NOT NULL, unit_id INTEGER NOT NULL)" })
		const values = Array.from({ length: units }, (_, i) => `(${i + 1}, 'a', 'u${i + 1}')`).join(", ")
		yield* db.execute({ sql: `INSERT INTO units VALUES ${values}, (${units + 1}, 'b', 'other')` })
		// Two locks per unit of org a, and one lock of org b pointing at unit 1.
		const locks = Array.from({ length: units }, (_, i) => `(${2 * i + 1}, 'a', ${i + 1}), (${2 * i + 2}, 'a', ${i + 1})`).join(", ")
		yield* db.execute({ sql: `INSERT INTO locks VALUES ${locks}, (${2 * units + 1}, 'b', 1)` })
	})

const read = Db.findMany(schema.units, {
	where: ($) => [$.org_id.eq("a")],
	orderBy: ($) => [[$.id, "asc"]],
	with: { locks: { orderBy: ($) => [[$.id, "desc"]], with: { unit: true } } },
})

it("loads nested relations on SQLite, pinned to the tenant, one statement per level", async () => {
	const { units, statements } = await Effect.runPromise(
		Effect.gen(function* () {
			const statements: Array<string> = []
			const db = Db.fromSqlClient(yield* SqlClient.SqlClient, {
				dialect: SQLite.sqliteDialect,
				requireTenantScope: true,
				observe: (statement) => Effect.sync(() => void statements.push(statement.sql)),
			})
			yield* setup(db, 2)
			statements.length = 0
			const units = yield* read.pipe(Effect.provideService(Db.Database, db))
			return { units, statements }
		}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
	)
	expect(units).toEqual([
		{
			id: 1,
			org_id: "a",
			name: "u1",
			locks: [
				{ id: 2, org_id: "a", unit_id: 1, unit: { id: 1, org_id: "a", name: "u1" } },
				{ id: 1, org_id: "a", unit_id: 1, unit: { id: 1, org_id: "a", name: "u1" } },
			],
		},
		{
			id: 2,
			org_id: "a",
			name: "u2",
			locks: [
				{ id: 4, org_id: "a", unit_id: 2, unit: { id: 2, org_id: "a", name: "u2" } },
				{ id: 3, org_id: "a", unit_id: 2, unit: { id: 2, org_id: "a", name: "u2" } },
			],
		},
	])
	expect(statements).toHaveLength(3)
	expect(statements[1]).toMatch(/"unit_id" IN \(/)
	expect(statements[1]).toMatch(/"org_id" = \?/)
})

it("splits a level's IN list to fit D1's 100 bound values", async () => {
	const mf = new Miniflare({
		modules: true,
		script: "export default { fetch() { return new Response('D1 relations test') } }",
		compatibilityDate: "2026-07-01",
		d1Databases: ["DB"],
	})
	try {
		const binding = await mf.getD1Database("DB")
		const { units, statements } = await Effect.runPromise(
			Effect.gen(function* () {
				const statements: Array<string> = []
				const db = Db.fromSqlClient(yield* SqlClient.SqlClient, {
					dialect: SQLite.d1Dialect,
					requireTenantScope: true,
					observe: (statement) => Effect.sync(() => void statements.push(statement.sql)),
				})
				yield* setup(db, 250)
				statements.length = 0
				const units = yield* read.pipe(Effect.provideService(Db.Database, db))
				return { units, statements }
			}).pipe(Effect.provide(D1Client.layer({ db: binding }))),
		)
		expect(units).toHaveLength(250)
		expect(units.every((unit) => unit.locks.length === 2 && unit.locks.every((lock) => lock.unit?.id === unit.id))).toBe(true)
		expect(units[0]!.locks.map((lock) => lock.id)).toEqual([2, 1])
		// 250 unit keys: 99 per statement next to the tenant pin is 3 statements;
		// the 250 distinct unit_id keys of the locks level split the same way.
		expect(statements).toHaveLength(7)
		for (const statement of statements) expect((statement.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100)
	} finally {
		await mf.dispose()
	}
}, 60_000)

// Relation filters and counts: correlated EXISTS and count(*) are plain SQL, so
// SQLite runs them as Postgres does. `_count` is a grouped level, split on D1
// like a loaded one.
const withSqlite = <A, E>(units: number, body: (db: Db.DatabaseApi) => Effect.Effect<A, E, Db.Database>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: SQLite.sqliteDialect, requireTenantScope: true })
			yield* setup(db, units)
			yield* db.execute({ sql: "DELETE FROM locks WHERE unit_id = 2" })
			return yield* body(db).pipe(Effect.provideService(Db.Database, db))
		}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
	)

it("filters by related rows and counts them on SQLite, inside the outer tenant", async () => {
	const seen = await withSqlite(3, (db) =>
		Effect.gen(function* () {
			const some = yield* Db.findMany(schema.units, {
				where: ($, r) => [$.org_id.eq("a"), r.locks.some()],
				orderBy: ($) => [[$.id, "asc"]],
			})
			const none = yield* Db.findMany(schema.units, { where: ($, r) => [$.org_id.eq("a"), r.locks.none()] })
			const every = yield* Db.findMany(schema.units, {
				where: ($, r) => [$.org_id.eq("a"), r.locks.every(($) => [$.id.lt(4)])],
				orderBy: ($) => [[$.id, "asc"]],
			})
			const counted = yield* Db.findMany(schema.units, {
				where: ($) => [$.org_id.eq("a")],
				orderBy: ($) => [[$.id, "asc"]],
				_count: { locks: true },
			})
			const selected = yield* db.run(
				SQLite.from(Units)
					.select(($) => ({ id: $.id, org_id: $.org_id, locks: Db.related(schema.units, $).locks.count() }))
					.where(($) => [$.org_id.eq("a")])
					.orderBy(["id", "asc"]),
			)
			return {
				some: some.map((unit) => unit.id),
				none: none.map((unit) => unit.id),
				every: every.map((unit) => unit.id),
				counted: counted.map((unit) => [unit.id, unit._count.locks]),
				selected: selected.map((row) => [row.id, row.locks]),
			}
		}),
	)
	// Unit 1 also has a lock of org b: the tenant pin keeps it out of every filter and count.
	expect(seen).toEqual({
		some: [1, 3],
		none: [2],
		every: [1, 2],
		counted: [[1, 2], [2, 0], [3, 2]],
		selected: [[1, 2], [2, 0], [3, 2]],
	})
})

it("splits a _count level to fit D1's 100 bound values", async () => {
	const mf = new Miniflare({
		modules: true,
		script: "export default { fetch() { return new Response('D1 relation counts test') } }",
		compatibilityDate: "2026-07-01",
		d1Databases: ["DB"],
	})
	try {
		const binding = await mf.getD1Database("DB")
		const { units, statements } = await Effect.runPromise(
			Effect.gen(function* () {
				const statements: Array<string> = []
				const db = Db.fromSqlClient(yield* SqlClient.SqlClient, {
					dialect: SQLite.d1Dialect,
					requireTenantScope: true,
					observe: (statement) => Effect.sync(() => void statements.push(statement.sql)),
				})
				yield* setup(db, 250)
				statements.length = 0
				const units = yield* Db.findMany(schema.units, {
					where: ($, r) => [$.org_id.eq("a"), r.locks.some(($) => [$.id.gt(0)])],
					_count: { locks: true },
				}).pipe(Effect.provideService(Db.Database, db))
				return { units, statements }
			}).pipe(Effect.provide(D1Client.layer({ db: binding }))),
		)
		expect(units).toHaveLength(250)
		expect(units.every((unit) => unit._count.locks === 2)).toBe(true)
		// The top level, then 3 grouped count statements of at most 99 keys.
		expect(statements).toHaveLength(4)
		for (const statement of statements) expect((statement.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100)
	} finally {
		await mf.dispose()
	}
}, 60_000)
