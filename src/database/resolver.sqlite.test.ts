// Batched lookups on SQLite and D1. D1 binds at most 100 values per statement,
// so a large batch goes in chunks that each fit, with room for the query's own
// params; SQLite's limit is far above any batch here, so it sends one.

import * as D1Client from "@effect/sql-d1/D1Client"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { Miniflare } from "miniflare"
import { expect, it } from "vitest"
import * as Db from "../database"
import * as SQLite from "../sqlite"
import type { Dialect } from "../ch/dialect"

const Users = SQLite.table("users", { id: SQLite.integer, org: SQLite.text, name: SQLite.text }, { tenantColumn: "org" })
const ids = Array.from({ length: 250 }, (_, i) => i + 1)

const lookups = (dialect: Dialect, client: Layer.Layer<SqlClient.SqlClient, unknown>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const statements: Array<string> = []
			const db = Db.fromSqlClient(yield* SqlClient.SqlClient, {
				dialect,
				requireTenantScope: true,
				observe: (statement) => Effect.sync(() => void statements.push(statement.sql)),
			})
			yield* db.execute({ sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, org TEXT NOT NULL, name TEXT NOT NULL)" })
			for (const id of ids) yield* db.execute({ sql: "INSERT INTO users VALUES (?, ?, ?)", parameters: [id, id % 2 === 0 ? "a" : "b", `u${id}`] })
			statements.length = 0
			const userById = Db.findById(
				SQLite.from(Users)
					.select("id", "name")
					.where(($) => [$.org.eq(SQLite.param.string("org"))]),
				{ key: "id" },
			)
			const evens = ids.filter((id) => id % 2 === 0)
			const found = yield* Effect.forEach(evens, (id) => userById.with({ org: "a" })(id), { concurrency: "unbounded" }).pipe(
				Effect.provideService(Db.Database, db),
			)
			return { found, statements }
		}).pipe(Effect.provide(client)),
	)

it("splits a D1 batch over the 100-binding limit into statements that each fit", async () => {
	const mf = new Miniflare({
		modules: true,
		script: "export default { fetch() { return new Response('resolver test') } }",
		compatibilityDate: "2026-07-01",
		d1Databases: ["DB"],
	})
	try {
		const binding = await mf.getD1Database("DB")
		const { found, statements } = await lookups(SQLite.d1Dialect, D1Client.layer({ db: binding }))
		expect(found).toEqual(ids.filter((id) => id % 2 === 0).map((id) => ({ id, name: `u${id}` })))
		// 125 keys plus the tenant param: 99 keys per statement.
		expect(statements).toHaveLength(2)
		for (const sql of statements) expect(sql.split("?").length - 1).toBeLessThanOrEqual(100)
	} finally {
		await mf.dispose()
	}
}, 30_000)

it("sends one statement for the same batch on SQLite", async () => {
	const { found, statements } = await lookups(SQLite.sqliteDialect, SqliteClient.layer({ filename: ":memory:" }))
	expect(found).toHaveLength(125)
	expect(statements).toHaveLength(1)
})
