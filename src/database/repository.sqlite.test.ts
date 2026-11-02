// `makeRepository` on SQLite and a local D1, both with `requireTenantScope`:
// RETURNING gives `insert` and `update` their rows, and every method stays in
// its tenant.

import * as D1Client from "@effect/sql-d1/D1Client"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Effect, Layer, Option } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { Miniflare } from "miniflare"
import { expect, it } from "vitest"
import * as Db from "../database"
import * as SQLite from "../sqlite"
import type { Dialect } from "../ch/dialect"

const Tickets = SQLite.table(
	"tickets",
	{ id: SQLite.integer, org: SQLite.text, title: SQLite.text, seats: SQLite.integer },
	{ tenantColumn: "org", defaults: ["id", "seats"] },
)

const crud = (dialect: Dialect, client: Layer.Layer<SqlClient.SqlClient, unknown>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect, requireTenantScope: true })
			yield* db.execute({
				sql: "CREATE TABLE tickets (id INTEGER PRIMARY KEY, org TEXT NOT NULL, title TEXT NOT NULL, seats INTEGER NOT NULL DEFAULT 1)",
			})
			return yield* Effect.gen(function* () {
				const tickets = yield* Db.makeRepository(Tickets, { idColumn: "id", tenantColumn: "org" })
				const board = yield* tickets.insert("acme", { title: "Board" })
				yield* tickets.insertVoid("other", { title: "Theirs", seats: 4 })
				const updated = yield* tickets.update("acme", board.id, { seats: 3 })
				const crossUpdate = yield* tickets.update("other", board.id, { seats: 9 })
				const crossFind = yield* tickets.findById("other", board.id)
				yield* tickets.delete("other", board.id)
				const afterCrossDelete = yield* tickets.findById("acme", board.id)
				yield* tickets.delete("acme", board.id)
				const afterDelete = yield* tickets.findById("acme", board.id)
				return { board, updated, crossUpdate, crossFind, afterCrossDelete, afterDelete }
			}).pipe(Effect.provideService(Db.Database, db))
		}).pipe(Effect.provide(client)),
	)

const check = (seen: Awaited<ReturnType<typeof crud>>) => {
	expect(seen.board).toEqual({ id: 1, org: "acme", title: "Board", seats: 1 })
	expect(seen.updated).toEqual(Option.some({ id: 1, org: "acme", title: "Board", seats: 3 }))
	expect(seen.crossUpdate).toEqual(Option.none())
	expect(seen.crossFind).toEqual(Option.none())
	expect(seen.afterCrossDelete).toEqual(Option.some({ id: 1, org: "acme", title: "Board", seats: 3 }))
	expect(seen.afterDelete).toEqual(Option.none())
}

it("runs tenant-pinned CRUD on SQLite", async () => {
	check(await crud(SQLite.sqliteDialect, SqliteClient.layer({ filename: ":memory:" })))
})

it("runs tenant-pinned CRUD on D1", async () => {
	const mf = new Miniflare({
		modules: true,
		script: "export default { fetch() { return new Response('repository test') } }",
		compatibilityDate: "2026-07-01",
		d1Databases: ["DB"],
	})
	try {
		check(await crud(SQLite.d1Dialect, D1Client.layer({ db: await mf.getD1Database("DB") })))
	} finally {
		await mf.dispose()
	}
}, 30_000)
