// `runWrite` on MySQL 8.4 and MariaDB 11.4 through @effect/sql-mysql2, over
// prepared statements and the text protocol (Hyperdrive), live when
// EFFECT_ORM_MYSQL_URL / EFFECT_ORM_MARIADB_URL are set.
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { Effect, Redacted } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Db from "../database"
import * as MySQL from "../mysql"

const servers = [
	["mysql", process.env.EFFECT_ORM_MYSQL_URL, MySQL.mysqlDialect],
	["mariadb", process.env.EFFECT_ORM_MARIADB_URL, MySQL.mariadbDialect],
] as const

for (const [name, url, dialect] of servers) {
	describe.skipIf(url === undefined)(`runWrite on ${name}`, () => {
		const table = `writes_${name}_${process.pid}`
		const T = MySQL.table(table, { id: MySQL.bigint, body: MySQL.text, seen: MySQL.int }, { defaults: ["id", "seen"] })

		for (const prepared of [true, false]) {
			it(`reports the AUTO_INCREMENT key and the rows changed (${prepared ? "prepared" : "text protocol"})`, async () => {
				const seen = await Effect.runPromise(
					Effect.gen(function* () {
						const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect })
						const drop = Effect.orDie(db.execute({ sql: `DROP TABLE IF EXISTS \`${table}\`` }))
						yield* drop
						yield* db.execute({
							sql: `CREATE TABLE \`${table}\` (id BIGINT AUTO_INCREMENT PRIMARY KEY, body TEXT NOT NULL, seen INT NOT NULL DEFAULT 0) AUTO_INCREMENT = 100`,
						})
						return yield* Effect.gen(function* () {
							const one = yield* db.runWrite(MySQL.insertInto(T).values({ body: MySQL.param.string("body") }), { body: "a" })
							// A multi-row insert reports the first row's key.
							const many = yield* db.runWrite(MySQL.insertInto(T).values([{ body: "b" }, { body: "c" }, { body: "d" }]))
							const explicit = yield* db.runWrite(MySQL.insertInto(T).values({ id: 500, body: "e" }))
							const updated = yield* db.runWrite(MySQL.update(T).set({ seen: 1 }).where(($) => [$.id.gte(101)]))
							// mysql2 connects with CLIENT_FOUND_ROWS, so an UPDATE counts the rows it matched,
							// even those it left as they were.
							const unchanged = yield* db.runWrite(MySQL.update(T).set({ seen: 1 }).where(($) => [$.id.gte(101)]))
							const deleted = yield* db.runWrite(MySQL.deleteFrom(T).where(($) => [$.id.eq(500)]))
							// Inside a transaction the result comes back the same way.
							const inTransaction = yield* db.transaction(db.runWrite(MySQL.insertInto(T).values({ body: "f" })))
							return { one, many, explicit, updated, unchanged, deleted, inTransaction }
						}).pipe(Effect.ensuring(drop))
					}).pipe(
						Effect.provide(
							MysqlClient.layer({ url: Redacted.make(`${url}${url?.includes("?") ? "&" : "?"}timezone=Z`), disablePreparedStatements: !prepared }),
						),
					),
				)
				expect(seen).toEqual({
					one: { affectedRows: 1, insertId: 100 },
					many: { affectedRows: 3, insertId: 101 },
					explicit: { affectedRows: 1, insertId: 500 },
					updated: { affectedRows: 4, insertId: undefined },
					unchanged: { affectedRows: 4, insertId: undefined },
					deleted: { affectedRows: 1, insertId: undefined },
					inTransaction: { affectedRows: 1, insertId: 501 },
				})
			})

			it(`deletes a run's rows in LIMIT chunks until a chunk comes back short (${prepared ? "prepared" : "text protocol"})`, async () => {
				const runs = `${table}_runs`
				const Runs = MySQL.table(runs, { id: MySQL.bigint, runId: MySQL.varchar(36) }, { defaults: ["id"] })
				const chunk = 4
				const counts = await Effect.runPromise(
					Effect.gen(function* () {
						const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect })
						const drop = Effect.orDie(db.execute({ sql: `DROP TABLE IF EXISTS \`${runs}\`` }))
						yield* drop
						yield* db.execute({ sql: `CREATE TABLE \`${runs}\` (id BIGINT AUTO_INCREMENT PRIMARY KEY, runId VARCHAR(36) NOT NULL)` })
						return yield* Effect.gen(function* () {
							// 10 rows of run "a" (two full chunks and a short one), 3 of run "b" that must survive.
							yield* db.runWrite(MySQL.insertInto(Runs).values([...Array.from({ length: 10 }, () => ({ runId: "a" })), ...Array.from({ length: 3 }, () => ({ runId: "b" }))]))
							const ofRun = MySQL.deleteFrom(Runs).where(($) => [$.runId.eq(MySQL.param.string("run"))]).orderBy(["id", "asc"]).limit(chunk)
							const deleted: Array<number> = []
							while (deleted.length === 0 || deleted[deleted.length - 1]! === chunk) {
								deleted.push((yield* db.runWrite(ofRun, { run: "a" })).affectedRows)
							}
							// ORDER BY with LIMIT on an UPDATE takes the lowest ids first.
							const updated = yield* db.runWrite(MySQL.update(Runs).set({ runId: "c" }).where(($) => [$.runId.eq("b")]).orderBy(["id", "asc"]).limit(2))
							const left = yield* db.run(MySQL.from(Runs).select("runId").orderBy(["runId", "asc"]))
							return { deleted, updated: updated.affectedRows, left: left.map((row) => row.runId) }
						}).pipe(Effect.ensuring(drop))
					}).pipe(
						Effect.provide(
							MysqlClient.layer({ url: Redacted.make(`${url}${url?.includes("?") ? "&" : "?"}timezone=Z`), disablePreparedStatements: !prepared }),
						),
					),
				)
				expect(counts).toEqual({ deleted: [4, 4, 2], updated: 2, left: ["b", "c", "c"] })
			})
		}
	})
}
