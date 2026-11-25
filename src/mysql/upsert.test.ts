import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { Effect, Redacted } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import mysql from "mysql2/promise"
import { describe, expect, it } from "vitest"
import * as Db from "../database"
import * as MySQL from "../mysql"
import * as PG from "../postgres"
import * as SQLite from "../sqlite"

const Counters = MySQL.table("counters", {
	columns: { id: MySQL.bigint, key: MySQL.varchar(32), count: MySQL.int, note: MySQL.text },
	primaryKey: ["id"],
})
const rows = MySQL.insertInto(Counters).values([
	{ id: 1, key: "a", count: 1, note: "x" },
	{ id: 2, key: "b", count: MySQL.param.int("n"), note: "y" },
])
const mariadb = { dialect: MySQL.mariadbDialect }

describe("onDuplicateKeyUpdate", () => {
	it("names the proposed row with a row alias on MySQL", () => {
		const compiled = MySQL.compileUnsafe(
			rows.onDuplicateKeyUpdate({ set: ($, excluded) => ({ count: $.count.add(excluded.count), note: "z" }) }),
			{ n: 5 },
		)
		expect(compiled.sql).toBe(
			"INSERT INTO `counters` (`id`, `key`, `count`, `note`)\nVALUES (?, ?, ?, ?), (?, ?, ?, ?) AS `excluded`\n" +
				"ON DUPLICATE KEY UPDATE `count` = `counters`.`count` + `excluded`.`count`, `note` = ?",
		)
		expect(compiled.parameters).toEqual([1, "a", 1, "x", 2, "b", 5, "y", "z"])
	})

	it("reads the proposed row with VALUES(col) on MariaDB", () => {
		const compiled = MySQL.compileUnsafe(
			rows.onDuplicateKeyUpdate({ set: ($, excluded) => ({ count: $.count.add(excluded.count), note: "z" }) }),
			{ n: 5 },
			mariadb,
		)
		expect(compiled.sql).toBe(
			"INSERT INTO `counters` (`id`, `key`, `count`, `note`)\nVALUES (?, ?, ?, ?), (?, ?, ?, ?)\n" +
				"ON DUPLICATE KEY UPDATE `count` = `counters`.`count` + VALUES(`count`), `note` = ?",
		)
	})

	it("copies the proposed row with excluded, and excludedAll leaves out the declared primary key", () => {
		const sql = (set: Parameters<typeof rows.onDuplicateKeyUpdate>[0]["set"], options = {}) =>
			MySQL.compileUnsafe(rows.onDuplicateKeyUpdate({ set }), { n: 5 }, options).sql.split("\n").at(-1)
		expect(sql(MySQL.excluded(["note"]))).toBe("ON DUPLICATE KEY UPDATE `note` = `excluded`.`note`")
		expect(sql(MySQL.excludedAll())).toBe(
			"ON DUPLICATE KEY UPDATE `key` = `excluded`.`key`, `count` = `excluded`.`count`, `note` = `excluded`.`note`",
		)
		expect(sql(MySQL.excludedAll(["count"]), mariadb)).toBe("ON DUPLICATE KEY UPDATE `key` = VALUES(`key`), `note` = VALUES(`note`)")
		// An external table declares no key: excludedAll copies every written column but those excepted.
		const External = MySQL.table("counters", { external: true, columns: Counters.columns })
		const external = MySQL.insertInto(External).values({ id: 1, key: "a", count: 1, note: "x" })
		expect(MySQL.compileUnsafe(external.onDuplicateKeyUpdate({ set: MySQL.excludedAll(["id"]) })).sql).toMatch(
			/UPDATE `key` = `excluded`\.`key`, `count` = `excluded`\.`count`, `note` = `excluded`\.`note`$/,
		)
	})

	it("writes a record of values and params, and the last call wins", () => {
		const compiled = MySQL.compileUnsafe(
			rows
				.onDuplicateKeyUpdate({ set: { note: "first" } })
				.onDuplicateKeyUpdate({ set: { count: MySQL.param.int("m"), note: "second" } }),
			{ n: 5, m: 7 },
		)
		expect(compiled.sql).toMatch(/ON DUPLICATE KEY UPDATE `count` = \?, `note` = \?$/)
		expect(compiled.parameters.slice(-2)).toEqual([7, "second"])
	})

	it("refuses what MySQL cannot write, before sending SQL", () => {
		// A column the insert does not write is not in the row alias, and VALUES() of it is NULL on MariaDB.
		const partial = MySQL.insertInto(Counters).values({ id: 1, key: "a", count: 1, note: "x" })
		const noNote = MySQL.insertInto(MySQL.table("t", { id: MySQL.int, note: MySQL.nullable(MySQL.text) })).values({ id: 1 })
		expect(() => MySQL.compileUnsafe(noNote.onDuplicateKeyUpdate({ set: MySQL.excluded(["note"]) }))).toThrow(/does not write/)
		expect(() => MySQL.compileUnsafe(noNote.onDuplicateKeyUpdate({ set: (_, excluded) => ({ note: excluded.note }) }), {}, mariadb)).toThrow(
			/does not write/,
		)
		expect(() => MySQL.compileUnsafe(partial.onDuplicateKeyUpdate({ set: {} }))).toThrow(/sets no columns/)
		// INSERT ... SELECT has no row alias.
		const fromSelect = MySQL.insertInto(Counters).select(MySQL.from(Counters).select("id", "key", "count", "note"))
		expect(() => MySQL.compileUnsafe(fromSelect.onDuplicateKeyUpdate({ set: { count: 0 } }))).toThrow(/not select\(\)/)
		// A table named like the row alias would make `excluded`.`col` ambiguous.
		const Excluded = MySQL.table("Excluded", { id: MySQL.int, n: MySQL.int })
		const named = MySQL.insertInto(Excluded).values({ id: 1, n: 1 }).onDuplicateKeyUpdate({ set: MySQL.excluded(["n"]) })
		expect(() => MySQL.compileUnsafe(named)).toThrow(/also this table's name/)
		expect(MySQL.compileUnsafe(named, {}, mariadb).sql).toMatch(/`n` = VALUES\(`n`\)$/)
		// ON CONFLICT stays refused, and points at the MySQL form.
		expect(() => MySQL.compileUnsafe(partial.onConflictDoUpdate({ target: ["id"], set: { count: 0 } }))).toThrow(/use onDuplicateKeyUpdate/)
	})

	it("skips a duplicate with an update that changes nothing, not INSERT IGNORE", () => {
		for (const options of [{}, mariadb]) {
			const compiled = MySQL.compileUnsafe(rows.onDuplicateKeyDoNothing(), { n: 5 }, options)
			expect(compiled.sql).toBe(
				"INSERT INTO `counters` (`id`, `key`, `count`, `note`)\nVALUES (?, ?, ?, ?), (?, ?, ?, ?)\nON DUPLICATE KEY UPDATE `id` = `counters`.`id`",
			)
		}
		// The last call wins, either way round.
		expect(MySQL.compileUnsafe(rows.onDuplicateKeyUpdate({ set: { note: "z" } }).onDuplicateKeyDoNothing(), { n: 5 }).sql).toMatch(/`id` = `counters`.`id`$/)
		expect(MySQL.compileUnsafe(rows.onDuplicateKeyDoNothing().onDuplicateKeyUpdate({ set: { note: "z" } }), { n: 5 }).sql).toMatch(/`note` = \?$/)
		// No row alias, so a table named excluded is fine.
		const Excluded = MySQL.table("excluded", { id: MySQL.int })
		expect(MySQL.compileUnsafe(MySQL.insertInto(Excluded).values({ id: 1 }).onDuplicateKeyDoNothing()).sql).toMatch(/`id` = `excluded`.`id`$/)
		const fromSelect = MySQL.insertInto(Counters).select(MySQL.from(Counters).select("id", "key", "count", "note"))
		expect(() => MySQL.compileUnsafe(fromSelect.onDuplicateKeyDoNothing())).toThrow(/onDuplicateKeyDoNothing takes values\(\) rows/)
		const P = PG.table("counters", { columns: { id: PG.int8 } })
		expect(() => PG.compileUnsafe(PG.insertInto(P).values({ id: 1 }).onDuplicateKeyDoNothing())).toThrow(
			/onDuplicateKeyDoNothing has no meaning for the postgres dialect/,
		)
	})

	it("is refused on dialects without ON DUPLICATE KEY UPDATE", () => {
		const P = PG.table("counters", { columns: { id: PG.int8, count: PG.int4 } })
		expect(() => PG.compileUnsafe(PG.insertInto(P).values({ id: 1, count: 1 }).onDuplicateKeyUpdate({ set: { count: 2 } }))).toThrow(
			/no ON DUPLICATE KEY UPDATE clause; use onConflictDoUpdate/,
		)
		const S = SQLite.table("counters", { columns: { id: SQLite.integer, count: SQLite.integer } })
		expect(() =>
			SQLite.compileUnsafe(SQLite.insertInto(S).values({ id: 1, count: 1 }).onDuplicateKeyUpdate({ set: { count: 2 } })),
		).toThrow(/ON DUPLICATE KEY UPDATE/)
	})

	it("is cross-tenant: any unique key can match another tenant's row", () => {
		const Tenanted = MySQL.table("rows", {
			columns: { id: MySQL.varchar(36), org: MySQL.varchar(36), value: MySQL.text },
			primaryKey: ["org", "id"],
			tenantColumn: "org",
		})
		const insert = MySQL.insertInto(Tenanted).values({ id: "same", org: MySQL.param.string("org"), value: "new" })
		expect(MySQL.compileUnsafe(insert, { org: "a" }).tenantScope).toBe("single-tenant")
		expect(MySQL.compileUnsafe(insert.onDuplicateKeyUpdate({ set: { value: "new" } }), { org: "a" }).tenantScope).toBe("cross-tenant")
		const declared = MySQL.compileUnsafe(insert.onDuplicateKeyUpdate({ set: { value: "new" } }).crossTenant(), { org: "a" })
		expect(declared.crossTenantDeclared).toBe(true)
	})

	it("keeps the rows' tenant scope when it does nothing: it writes no existing row", () => {
		const Tenanted = MySQL.table("rows", { columns: { id: MySQL.varchar(36), org: MySQL.varchar(36) }, primaryKey: ["id"], tenantColumn: "org" })
		const pinned = MySQL.insertInto(Tenanted).values({ id: "same", org: MySQL.param.string("org") })
		expect(MySQL.compileUnsafe(pinned.onDuplicateKeyDoNothing(), { org: "a" }).tenantScope).toBe("single-tenant")
		const mixed = MySQL.insertInto(Tenanted).values([{ id: "1", org: "a" }, { id: "2", org: "b" }])
		expect(MySQL.compileUnsafe(mixed.onDuplicateKeyDoNothing()).tenantScope).toBe("cross-tenant")
	})
})

// Live: each form against MySQL 8.4 and MariaDB 11.4, over prepared statements and the text protocol.
const servers = [
	["mysql", process.env.EFFECT_ORM_MYSQL_URL, MySQL.mysqlDialect],
	["mariadb", process.env.EFFECT_ORM_MARIADB_URL, MySQL.mariadbDialect],
] as const

for (const [name, url, dialect] of servers) {
	describe.skipIf(url === undefined)(`onDuplicateKeyUpdate on ${name}`, () => {
		for (const prepared of [true, false]) {
			it(`updates on the primary key and on another unique key (${prepared ? "prepared" : "text protocol"})`, async () => {
				const table = `upsert_${name}_${prepared ? "p" : "t"}_${process.pid}`
				const T = MySQL.table(table, {
					columns: { id: MySQL.bigint, key: MySQL.varchar(32), count: MySQL.int, note: MySQL.text },
					primaryKey: ["id"],
				})
				const layer = MysqlClient.layer({
					url: Redacted.make(`${url}${url?.includes("?") ? "&" : "?"}timezone=Z`),
					disablePreparedStatements: !prepared,
				})
				const seen = await Effect.runPromise(
					Effect.gen(function* () {
						const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect })
						yield* db.execute({ sql: `DROP TABLE IF EXISTS \`${table}\`` })
						yield* db.execute({
							sql: `CREATE TABLE \`${table}\` (id BIGINT PRIMARY KEY, \`key\` VARCHAR(32) NOT NULL UNIQUE, count INT NOT NULL, note TEXT NOT NULL)`,
						})
						const body = Effect.gen(function* () {
							yield* db.run(MySQL.insertInto(T).values([
								{ id: 1, key: "a", count: 1, note: "x" },
								{ id: 2, key: "b", count: 1, note: "y" },
							]))
							// The primary key conflicts: the callback adds to the existing count.
							yield* db.run(
								MySQL.insertInto(T)
									.values({ id: 1, key: "a2", count: 5, note: "x2" })
									.onDuplicateKeyUpdate({ set: ($, excluded) => ({ count: $.count.add(excluded.count), note: "z" }) }),
							)
							// `key` conflicts, not the primary key: excludedAll copies the row but keeps id 2.
							yield* db.run(MySQL.insertInto(T).values({ id: 99, key: "b", count: 3, note: "y2" }).onDuplicateKeyUpdate({ set: MySQL.excludedAll() }))
							// Several rows with params: one new, one conflicting.
							yield* db.run(
								MySQL.insertInto(T)
									.values([
										{ id: 3, key: "c", count: MySQL.param.int("n"), note: "new" },
										{ id: 1, key: "a", count: MySQL.param.int("n"), note: "q" },
									])
									.onDuplicateKeyUpdate({ set: MySQL.excluded(["note"]) }),
								{ n: 7 },
							)
							// A record of values.
							yield* db.run(MySQL.insertInto(T).values({ id: 2, key: "b", count: 0, note: "" }).onDuplicateKeyUpdate({ set: { count: 100 } }))
							return yield* db.run(MySQL.from(T).select().orderBy(["id", "asc"]))
						})
						return yield* body.pipe(Effect.ensuring(Effect.orDie(db.execute({ sql: `DROP TABLE IF EXISTS \`${table}\`` }))))
					}).pipe(Effect.provide(layer)),
				)
				expect(seen).toEqual([
					{ id: 1, key: "a", count: 6, note: "q" },
					{ id: 2, key: "b", count: 100, note: "y2" },
					{ id: 3, key: "c", count: 7, note: "new" },
				])
			})
		}

		// mysql2 connects with CLIENT_FOUND_ROWS by default: a row matched but not changed then counts.
		for (const foundRows of [true, false]) {
			it(`runs assignments left to right, and skips a duplicate (${foundRows ? "CLIENT_FOUND_ROWS" : "changed rows"})`, async () => {
				const table = `upsert_order_${name}_${foundRows ? "f" : "c"}_${process.pid}`
				const T = MySQL.table(table, { columns: { id: MySQL.int, a: MySQL.int, b: MySQL.int, note: MySQL.text }, primaryKey: ["id"] })
				const connection = await mysql.createConnection({ uri: url!, timezone: "Z", ...(foundRows ? {} : { flags: ["-FOUND_ROWS"] }) })
				const affected = async (compiled: { readonly sql: string; readonly parameters: ReadonlyArray<unknown> }) => {
					const [header] = await connection.execute(compiled.sql, compiled.parameters as Array<any>)
					return (header as mysql.ResultSetHeader).affectedRows
				}
				const options = { dialect }
				try {
					await connection.query(`DROP TABLE IF EXISTS \`${table}\``)
					await connection.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY, a INT NOT NULL, b INT NOT NULL, note VARCHAR(4) NOT NULL)`)
					const insert = MySQL.insertInto(T).values({ id: 1, a: 1, b: 0, note: "x" })
					const inserted = await affected(MySQL.compileUnsafe(insert.onDuplicateKeyDoNothing(), {}, options))
					// `b` reads `a` as the assignment before it left it.
					const updated = await affected(
						MySQL.compileUnsafe(insert.onDuplicateKeyUpdate({ set: ($) => ({ a: $.a.add(1), b: $.a }) }), {}, options),
					)
					const skipped = await affected(MySQL.compileUnsafe(MySQL.insertInto(T).values({ id: 1, a: 9, b: 9, note: "y" }).onDuplicateKeyDoNothing(), {}, options))
					// Unlike INSERT IGNORE, a value too long for its column still fails.
					const tooLong = await affected(
						MySQL.compileUnsafe(MySQL.insertInto(T).values({ id: 1, a: 9, b: 9, note: "too long" }).onDuplicateKeyDoNothing(), {}, options),
					).then(() => "inserted", (error: Error) => error.message)
					const [rows] = await connection.query(`SELECT id, a, b, note FROM \`${table}\``)
					expect({ inserted, updated, skipped, tooLong, rows }).toEqual({
						inserted: 1,
						updated: 2,
						skipped: foundRows ? 1 : 0,
						tooLong: expect.stringMatching(/Data too long/),
						rows: [{ id: 1, a: 2, b: 2, note: "x" }],
					})
				} finally {
					await connection.query(`DROP TABLE IF EXISTS \`${table}\``)
					await connection.end()
				}
			})
		}
	})
}
