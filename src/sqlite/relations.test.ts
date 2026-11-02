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
