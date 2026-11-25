// `runWrite`: what each driver reports of a write, read into one `WriteResult`.
// MySQL and MariaDB run live in src/mysql/write-result.test.ts.

import * as D1Client from "@effect/sql-d1/D1Client"
import { PgliteClient } from "@effect/sql-pglite"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { Miniflare } from "miniflare"
import * as CH from "../clickhouse"
import * as Db from "../database"
import * as MySQL from "../mysql"
import * as PG from "../postgres"
import * as SQLite from "../sqlite"
import { writeResultOf } from "./database"

const Notes = SQLite.table("notes", { id: SQLite.integer, body: SQLite.text }, { defaults: ["id"] })

// An insert with a generated key, a two-row insert, an update and a delete that
// match nothing: the same program on node:sqlite and D1.
const sqliteWrites = (db: Db.DatabaseApi) =>
	Effect.gen(function* () {
		yield* db.execute({ sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)" })
		const one = yield* db.runWrite(SQLite.insertInto(Notes).values({ body: "a" }))
		const two = yield* db.runWrite(SQLite.insertInto(Notes).values([{ body: "b" }, { body: "c" }]))
		const updated = yield* db.runWrite(SQLite.update(Notes).set({ body: "z" }).where(($) => [$.id.gt(1)]))
		const none = yield* db.runWrite(SQLite.deleteFrom(Notes).where(($) => [$.id.eq(99)]))
		// An upsert that updates row 1 leaves the connection's last rowid at 3: not its key.
		const upserted = yield* db.runWrite(
			SQLite.insertInto(Notes).values({ id: 1, body: "again" }).onConflictDoUpdate({ target: ["id"], set: SQLite.excluded(["body"]) }),
		)
		return { one, two, updated, none, upserted }
	})

const expectSqliteWrites = (seen: Effect.Success<ReturnType<typeof sqliteWrites>>) =>
	// SQLite's rowid is the last row's, and an update keeps none.
	expect(seen).toEqual({
		one: { affectedRows: 1, insertId: 1 },
		two: { affectedRows: 2, insertId: 3 },
		updated: { affectedRows: 2, insertId: undefined },
		none: { affectedRows: 0, insertId: undefined },
		upserted: { affectedRows: 1, insertId: undefined },
	})

describe("runWrite", () => {
	it.effect("node:sqlite: the changes and the last rowid", () =>
		Effect.gen(function* () {
			expectSqliteWrites(yield* sqliteWrites(Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: SQLite.sqliteDialect })))
		}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
	)

	it("D1: the changes and last_row_id from the result's meta", async () => {
		const mf = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('write test') } }",
			compatibilityDate: "2026-07-01",
			d1Databases: ["DB"],
		})
		try {
			const binding = await mf.getD1Database("DB")
			const seen = await Effect.runPromise(
				Effect.gen(function* () {
					return yield* sqliteWrites(Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: SQLite.d1Dialect }))
				}).pipe(Effect.provide(D1Client.layer({ db: binding }))),
			)
			expectSqliteWrites(seen)
		} finally {
			await mf.dispose()
		}
	}, 30_000)

	it.effect("PGlite: the affected rows, and no insert id (Postgres reads it with returning)", () =>
		Effect.gen(function* () {
			const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: PG.postgresDialect })
			yield* db.execute({ sql: "CREATE TABLE notes_pg (id serial PRIMARY KEY, body text NOT NULL)" })
			const T = PG.table("notes_pg", { columns: { id: PG.int4, body: PG.text }, primaryKey: ["id"] })
			const inserted = yield* db.runWrite(PG.insertInto(T).values([{ id: 1, body: "a" }, { id: 2, body: "b" }]))
			const updated = yield* db.runWrite(PG.update(T).set({ body: "z" }).where(($) => [$.id.eq(PG.param.int("id"))]), { id: 2 })
			expect({ inserted, updated }).toEqual({
				inserted: { affectedRows: 2, insertId: undefined },
				updated: { affectedRows: 1, insertId: undefined },
			})
		}).pipe(Effect.provide(PgliteClient.layer())),
	)

	it.effect("layerTest: a queued write reply, and no rows as a write that changed nothing", () =>
		Effect.gen(function* () {
			const test = yield* Db.TestDatabase
			const T = MySQL.table("notes", { id: MySQL.int, body: MySQL.text }, { defaults: ["id"] })
			yield* test.reply({ affectedRows: 1, insertId: 41 })
			const inserted = yield* Db.runWrite(MySQL.insertInto(T).values({ body: "a" }))
			const nothing = yield* Db.runWrite(MySQL.deleteFrom(T).where(($) => [$.id.eq(1)]))
			// `run` reads the same reply as no rows.
			yield* test.reply({ affectedRows: 1 })
			const rows = yield* Db.run(MySQL.insertInto(T).values({ body: "b" }))
			expect({ inserted, nothing, rows }).toEqual({
				inserted: { affectedRows: 1, insertId: 41 },
				nothing: { affectedRows: 0, insertId: undefined },
				rows: [],
			})
			expect((yield* test.statements).map((statement) => statement.sql)).toEqual([
				"INSERT INTO `notes` (`body`)\nVALUES (?)",
				"DELETE FROM `notes`\nWHERE `id` = ?",
				"INSERT INTO `notes` (`body`)\nVALUES (?)",
			])
		}).pipe(Effect.provide(Db.layerTest({ dialect: MySQL.mysqlDialect }))),
	)

	it.effect("layerTest: no insert id on Postgres, and rows queued for runWrite are a test bug", () =>
		Effect.gen(function* () {
			const test = yield* Db.TestDatabase
			const T = PG.table("notes", { columns: { id: PG.int4, body: PG.text }, primaryKey: ["id"] })
			yield* test.reply({ affectedRows: 1, insertId: 41 })
			expect(yield* Db.runWrite(PG.insertInto(T).values({ id: 1, body: "a" }))).toEqual({ affectedRows: 1, insertId: undefined })
			yield* test.reply([{ id: 1 }])
			const exit = yield* Effect.exit(Db.runWrite(PG.insertInto(T).values({ id: 2, body: "b" })))
			expect(Exit.isFailure(exit) && String(exit.cause)).toMatch(/queue a TestWriteReply/)
		}).pipe(Effect.provide(Db.layerTest({ dialect: PG.postgresDialect }))),
	)

	it.effect("refuses a ClickHouse write before sending it", () =>
		Effect.gen(function* () {
			const test = yield* Db.TestDatabase
			const T = CH.table("events", { columns: { id: CH.uint32 }, engine: CH.engine.mergeTree(), orderBy: ["id"] })
			const exit = yield* Effect.exit(Db.runWrite(CH.insertInto(T).values({ id: 1 })))
			expect(Exit.isFailure(exit) && String(exit.cause)).toMatch(/ClickHouse reports no affected rows/)
			expect(yield* test.statements).toEqual([])
		}).pipe(Effect.provide(Db.layerTest({ dialect: CH.clickhouseDialect }))),
	)

	it.effect("reads each driver's shape, and fails on a key past 2^53 instead of rounding it", () =>
		Effect.gen(function* () {
			const read = (raw: unknown, insert = true) => writeResultOf(raw, insert, "INSERT ...")
			expect(yield* read({ affectedRows: 2, insertId: 7 })).toEqual({ affectedRows: 2, insertId: 7 })
			expect(yield* read({ affectedRows: 1, insertId: 0 })).toEqual({ affectedRows: 1, insertId: undefined })
			expect(yield* read({ rowCount: 3, rows: [] })).toEqual({ affectedRows: 3, insertId: undefined })
			expect(yield* read({ changes: 1, lastInsertRowid: 5n })).toEqual({ affectedRows: 1, insertId: 5 })
			expect(yield* read({ meta: { changes: 1, last_row_id: 6 } })).toEqual({ affectedRows: 1, insertId: 6 })
			// node:sqlite's rowid outlives its insert: an update does not report it.
			expect(yield* read({ changes: 1, lastInsertRowid: 5 }, false)).toEqual({ affectedRows: 1, insertId: undefined })
			const big = yield* Effect.flip(read({ affectedRows: 1, insertId: "9007199254740993" }))
			expect(big).toMatchObject({ reason: "UnsafeInteger" })
			// The write already ran, so an unknown shape is an error in the channel, not a defect.
			const unknown = yield* Effect.flip(read({ rows: [] }))
			expect(unknown).toMatchObject({ reason: "WriteResultUnsupported" })
		}),
	)
})
