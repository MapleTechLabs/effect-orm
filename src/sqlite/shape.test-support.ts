// Test support: what SQLite reports about a schema, to compare two ways of building it.
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Db from "../database"
import { sqliteDialect } from "./dialect"

/** What SQLite reports about every table and index after running `statements` on an empty database. */
export const shapeAfter = (statements: ReadonlyArray<string>) =>
	Effect.runPromise(Effect.gen(function* () {
		const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: sqliteDialect })
		for (const sql of statements) yield* db.execute({ sql })
		const tables = yield* db.query({ sql: "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name" })
		const shape: Record<string, unknown> = {}
		for (const { name } of tables as ReadonlyArray<{ name: string }>) {
			const columns = yield* db.query({ sql: `SELECT * FROM pragma_table_info('${name}')` })
			const list = yield* db.query({ sql: `SELECT name, "unique", origin, partial FROM pragma_index_list('${name}') ORDER BY name` })
			const indexes = []
			for (const index of list as ReadonlyArray<{ name: string }>) {
				const keys = yield* db.query({ sql: `SELECT seqno, cid, name, "desc", coll, "key" FROM pragma_index_xinfo('${index.name}')` })
				indexes.push({ ...index, keys })
			}
			shape[name] = { columns, indexes }
		}
		return shape
	}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))))


/** The rows `select` returns after running `statements` on an empty database. */
export const rowsAfter = (statements: ReadonlyArray<string>, select: string) =>
	Effect.runPromise(Effect.gen(function* () {
		const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: sqliteDialect })
		for (const sql of statements) yield* db.execute({ sql })
		return yield* db.query({ sql: select })
	}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))))
