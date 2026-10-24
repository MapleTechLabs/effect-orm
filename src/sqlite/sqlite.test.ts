import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { expect, it } from "vitest"
import * as Db from "../database"
import * as SQLite from "../sqlite"

const Items = SQLite.table("items", {
	id: SQLite.integer,
	note: SQLite.text,
	enabled: SQLite.boolean,
	score: SQLite.nullable(SQLite.real),
})
const withDatabase = <A, E>(body: (db: Db.DatabaseApi) => Effect.Effect<A, E>) =>
	Effect.runPromise(Effect.gen(function* () {
		const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: SQLite.sqliteDialect })
		yield* db.execute({ sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, note TEXT NOT NULL, enabled INTEGER NOT NULL, score REAL DEFAULT 7)" })
		return yield* body(db)
	}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))))

it("runs and decodes SQLite writes and selects through an existing Effect SqlClient", async () => {
	const seen = await withDatabase((db) => Effect.gen(function* () {
		yield* db.run(SQLite.insertInto(Items).values({ id: 1, note: "O'Reilly\\notes", enabled: true, score: null }))
		return yield* db.run(SQLite.from(Items).select().where(($) => [$.enabled.eq(SQLite.param.bool("enabled"))]), { enabled: true })
	}))
	expect(seen).toEqual([{ id: 1, note: "O'Reilly\\notes", enabled: true, score: null }])
})
