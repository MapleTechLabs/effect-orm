// `asBoolean` on MySQL 8.4 and MariaDB 11.4, live when EFFECT_ORM_MYSQL_URL /
// EFFECT_ORM_MARIADB_URL are set: a condition read back as a boolean, a NULL one as false.
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
	describe.skipIf(url === undefined)(`asBoolean on ${name}`, () => {
		const table = `as_boolean_${name}_${process.pid}`
		const T = MySQL.table(table, { id: MySQL.int, secret: MySQL.nullable(MySQL.varchar(32)) })

		for (const prepared of [true, false]) {
			it(`reads a condition as true or false, never NULL (${prepared ? "prepared" : "text protocol"})`, async () => {
				const rows = await Effect.runPromise(
					Effect.gen(function* () {
						const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect })
						const drop = Effect.orDie(db.execute({ sql: `DROP TABLE IF EXISTS \`${table}\`` }))
						yield* drop
						yield* db.execute({ sql: `CREATE TABLE \`${table}\` (id INT PRIMARY KEY, secret VARCHAR(32) NULL)` })
						return yield* Effect.gen(function* () {
							yield* db.runWrite(MySQL.insertInto(T).values([{ id: 1, secret: "k" }, { id: 2, secret: "" }, { id: 3, secret: null }]))
							return yield* db.run(
								MySQL.from(T)
									.select(($) => ({
										id: $.id,
										stored: MySQL.asBoolean($.secret.isNotNull().and($.secret.neq(""))),
										// `secret != ''` alone is NULL for the NULL row: it reads as false.
										unknown: MySQL.asBoolean($.secret.neq("")),
									}))
									.orderBy(["id", "asc"]),
							)
						}).pipe(Effect.ensuring(drop))
					}).pipe(Effect.provide(MysqlClient.layer({ url: Redacted.make(url!), disablePreparedStatements: !prepared }))),
				)
				expect(rows).toEqual([
					{ id: 1, stored: true, unknown: true },
					{ id: 2, stored: false, unknown: false },
					{ id: 3, stored: false, unknown: false },
				])
			})
		}
	})
}
