import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { DateTime, Effect, Redacted, Schema, Stream } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Db from "../database"
import * as MySQL from "../mysql"

const Items = MySQL.table("items", {
	id: MySQL.bigint,
	note: MySQL.text,
	enabled: MySQL.boolean,
	score: MySQL.nullable(MySQL.double),
	at: MySQL.datetime,
})

describe("the MySQL dialect", () => {
	it("writes backtick identifiers and positional placeholders", () => {
		const compiled = MySQL.compileUnsafe(
			MySQL.from(Items).select("id", "note").where(($) => [$.note.eq(MySQL.param.string("note")), $.id.gt(MySQL.param.int("id"))]),
			{ note: "a", id: 1 },
		)
		expect(compiled.sql).toContain("FROM `items`")
		expect(compiled.sql).toContain("`items`.`note` = ?")
		expect(compiled.parameters).toEqual(["a", 1])
	})

	it("escapes backslashes in literals and keeps the param marker out of the SQL text", () => {
		const compiled = MySQL.compileUnsafe(MySQL.from(Items).select(() => ({ v: MySQL.lit("a\\b'\n__PARAM_x") })))
		expect(compiled.sql).toContain(`CONCAT('a\\\\b\\'\\n', '__PA', 'RAM_', 'x')`)
		expect(compiled.sql).not.toContain("__PARAM_")
	})

	it("casts a selected small integer, or a numeric param, so ORDER BY cannot read it as a position", () => {
		const sql = MySQL.compileUnsafe(
			MySQL.from(Items).select(() => ({ one: MySQL.lit(1), big: MySQL.lit(1e20), n: MySQL.param.int("n"), f: MySQL.param.float("f"), s: MySQL.param.string("s") })),
			{ n: 1, f: 1, s: "1" },
		).sql
		expect(sql).toContain("CAST(1 AS SIGNED) AS `one`")
		// Past 2^63 a literal is a DECIMAL to MySQL, and no position: a cast would overflow it.
		expect(sql).toContain("100000000000000000000 AS `big`")
		expect(sql).toContain("CAST(? AS SIGNED) AS `n`")
		expect(sql).toContain("CAST(? AS DOUBLE) AS `f`")
		expect(sql).toContain("? AS `s`")
	})

	it("compares a JSON column with CAST(? AS JSON) on MySQL, and as text on MariaDB", () => {
		const Docs = MySQL.table("docs", { id: MySQL.int, body: MySQL.json(Schema.Struct({ a: Schema.Number })) })
		const query = MySQL.from(Docs).select("id").where(($) => [$.body.eq({ a: 1 })])
		expect(MySQL.compileUnsafe(query).sql).toContain("`docs`.`body` = CAST(? AS JSON)")
		expect(MySQL.compileUnsafe(query, {}, { dialect: MySQL.mariadbDialect }).sql).toContain("`docs`.`body` = ?")
	})

	it("writes OFFSET with the largest LIMIT", () => {
		const compiled = MySQL.compileUnsafe(MySQL.from(Items).select("id").where(($) => [$.score.gt(MySQL.lit(0.5))]).offset(2))
		expect(compiled.sql).toContain("`items`.`score` > 0.5")
		expect(compiled.sql).toContain("LIMIT 18446744073709551615")
	})

	it("casts a selected param to MySQL's CAST types, and JSON to CHAR on MariaDB", () => {
		const Docs = MySQL.table("docs", { id: MySQL.int, body: MySQL.json(Schema.Struct({ a: Schema.Number })) })
		const query = MySQL.from(Docs).select(() => ({ n: MySQL.param.of(MySQL.bigint, "n"), body: MySQL.param.of(Docs.columns.body, "body") }))
		expect(MySQL.compileUnsafe(query, { n: 1, body: { a: 1 } }).sql).toMatch(/CAST\(\? AS SIGNED\)[\s\S]*CAST\(\? AS JSON\)/)
		expect(MySQL.compileUnsafe(query, { n: 1, body: { a: 1 } }, { dialect: MySQL.mariadbDialect }).sql).toMatch(/CAST\(\? AS CHAR\) AS `body`/)
	})

	it("writes text matches that do not depend on the collation", () => {
		const sql = MySQL.compileUnsafe(MySQL.from(Items).select("id").where(($) => [$.note.contains("50%"), $.note.startsWith("a", { insensitive: true })])).sql
		expect(sql).toContain("CAST(`items`.`note` AS BINARY) LIKE CAST(? AS BINARY)")
		expect(sql).toContain("lower(`items`.`note`) LIKE lower(?)")
		const param = MySQL.compileUnsafe(MySQL.from(Items).select("id").where(($) => [$.note.contains(MySQL.param.string("q"))]), { q: "x" }).sql
		expect(param).toContain("CONCAT('%', replace(")
	})

	it("writes MySQL's and MariaDB's row locks, and refuses the Postgres-only ones", () => {
		const base = MySQL.from(Items).select("id")
		expect(MySQL.compileUnsafe(base.forUpdate({ skipLocked: true })).sql).toMatch(/FOR UPDATE SKIP LOCKED$/)
		expect(MySQL.compileUnsafe(base.forShare({ of: ["items"] })).sql).toMatch(/FOR SHARE OF `items`$/)
		expect(MySQL.compileUnsafe(base.forShare({ noWait: true }), {}, { dialect: MySQL.mariadbDialect }).sql).toMatch(/LOCK IN SHARE MODE NOWAIT$/)
		expect(() => MySQL.compileUnsafe(base.forShare({ of: ["items"] }), {}, { dialect: MySQL.mariadbDialect })).toThrow(/no FOR SHARE OF/)
		// @ts-expect-error -- FOR NO KEY UPDATE has no meaning for the mysql dialect
		expect(() => MySQL.compileUnsafe(base.forNoKeyUpdate())).toThrow(/FOR NO KEY UPDATE/)
	})

	it("refuses what MySQL does not have while compiling, before sending SQL", () => {
		expect(() => MySQL.compileUnsafe(MySQL.from(Items).select("id").distinctOn("id"))).toThrow(/DISTINCT ON/)
		expect(() => MySQL.compileUnsafe(MySQL.from(Items).select("id").where(($) => [$.note.ilike("a%")]))).toThrow(/ILIKE/)
		const row = { id: 1, note: "a", enabled: true, score: null, at: DateTime.makeUnsafe(0) }
		expect(() => MySQL.compileUnsafe(MySQL.insertInto(Items).values(row).returning("id"))).toThrow(/RETURNING/)
		expect(() => MySQL.compileUnsafe(MySQL.insertInto(Items).values(row).onConflictDoNothing())).toThrow(/ON CONFLICT/)
	})

	it("starts a transaction with its settings before START TRANSACTION", () => {
		const begin = MySQL.mysqlDialect.transactions!.beginTransaction!
		expect(begin({})).toBeUndefined()
		expect(begin({ accessMode: "read only" })).toBe("START TRANSACTION READ ONLY")
		expect(begin({ isolationLevel: "serializable", accessMode: "read write" })).toBe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; START TRANSACTION READ WRITE")
	})

	it("refuses a DATETIME outside 1000-9999", () => {
		expect(() => MySQL.compileUnsafe(MySQL.from(Items).select("id").where(($) => [$.at.gt(DateTime.makeUnsafe(Date.UTC(999, 0, 1)))]))).toThrow(/1000-9999/)
	})
})

// Live: the Database layer over @effect/sql-mysql2, against each server whose URL is set.
const servers = [
	["mysql", process.env.EFFECT_ORM_MYSQL_URL, MySQL.mysqlDialect],
	["mariadb", process.env.EFFECT_ORM_MARIADB_URL, MySQL.mariadbDialect],
] as const

for (const [name, url, dialect] of servers) {
	describe.skipIf(url === undefined)(`Database on ${name} through @effect/sql-mysql2`, () => {
		const table = `items_${name}_${process.pid}`
		const T = MySQL.table(table, { id: MySQL.bigint, note: MySQL.text, enabled: MySQL.boolean, score: MySQL.nullable(MySQL.double), at: MySQL.datetime })
		const client = (prepared: boolean) =>
			MysqlClient.layer({ url: Redacted.make(`${url}${url?.includes("?") ? "&" : "?"}timezone=Z`), disablePreparedStatements: !prepared })
		const run = <A, E>(prepared: boolean, body: (db: Db.DatabaseApi<"mysql">) => Effect.Effect<A, E>) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect })
					yield* db.execute({ sql: `DROP TABLE IF EXISTS \`${table}\`` })
					yield* db.execute({ sql: `CREATE TABLE \`${table}\` (id BIGINT PRIMARY KEY, note TEXT NOT NULL, enabled BOOLEAN NOT NULL, score DOUBLE, at DATETIME(3) NOT NULL)` })
					return yield* body(db).pipe(Effect.ensuring(Effect.orDie(db.execute({ sql: `DROP TABLE \`${table}\`` }))))
				}).pipe(Effect.provide(client(prepared))),
			)
		const at = DateTime.makeUnsafe("2026-10-01T10:00:00.123Z")

		for (const prepared of [true, false]) {
			it(`runs, streams and aggregates (${prepared ? "prepared" : "text protocol"})`, async () => {
				const seen = await run(prepared, (db) =>
					Effect.gen(function* () {
						yield* db.run(MySQL.insertInto(T).values([
							{ id: 1, note: "O'Reilly\\notes", enabled: true, score: 1.5, at },
							{ id: 2, note: "😀", enabled: false, score: null, at },
						]))
						const rows = yield* db.run(MySQL.from(T).select().where(($) => [$.enabled.eq(MySQL.param.bool("on"))]), { on: true })
						const streamed = yield* Stream.runCollect(db.stream(MySQL.from(T).select("id").orderBy(["id", "asc"])))
						const totals = yield* db.run(MySQL.from(T).select(($) => ({ n: MySQL.count(), total: MySQL.sum($.id), avg: MySQL.avg($.score) })))
						return { rows, streamed: Array.from(streamed), totals }
					}),
				)
				expect(seen).toEqual({
					rows: [{ id: 1, note: "O'Reilly\\notes", enabled: true, score: 1.5, at }],
					streamed: [{ id: 1 }, { id: 2 }],
					totals: [{ n: 2, total: 3, avg: 1.5 }],
				})
			})
		}

		for (const prepared of [true, false]) {
			it(`orders by a selected number and compares JSON (${prepared ? "prepared" : "text protocol"})`, async () => {
				const seen = await run(prepared, (db) =>
					Effect.gen(function* () {
						yield* db.run(MySQL.insertInto(T).values([1, 2].map((id) => ({ id, note: `${id}`, enabled: true, score: null, at }))))
						// The text protocol writes the param into the SQL: MySQL would read a bare `10` in the merged
						// derived table's ORDER BY as column position 10 (an error), and `1` as the first column.
						const inner = MySQL.from(T).select(($) => ({ id: $.id, n: MySQL.param.int("n") })).orderBy(["n", "asc"], ["id", "desc"])
						const rows = yield* db.run(MySQL.fromQuery(inner, "w").select("id", "n"), { n: 10 })
						// A derived table's order is not the outer query's (MariaDB drops it), so compare the rows.
						const ordered = [...rows].sort((a, b) => a.id - b.id)
						const Docs = MySQL.table(`${table}_docs`, { id: MySQL.int, body: MySQL.json(Schema.Struct({ a: Schema.Number })) })
						yield* db.execute({ sql: `CREATE TABLE \`${table}_docs\` (id INT, body JSON)` })
						yield* db.run(MySQL.insertInto(Docs).values({ id: 1, body: { a: 1 } }))
						const found = yield* db.run(MySQL.from(Docs).select("id").where(($) => [$.body.eq({ a: 1 })]))
						yield* db.execute({ sql: `DROP TABLE \`${table}_docs\`` })
						// A literal holding the reserved marker is a CONCAT; MariaDB's replace() misreads adjacent literals.
						yield* db.run(MySQL.insertInto(T).values({ id: 3, note: "a__PARAM_b", enabled: true, score: null, at }))
						const marker = yield* db.run(MySQL.from(T).select("id").where(($) => [$.note.contains(MySQL.lit("__PARAM_")), $.note.startsWith(MySQL.lit("A__param_"), { insensitive: true })]))
						return { ordered, found, marker }
					}),
				)
				expect(seen).toEqual({ ordered: [{ id: 1, n: 10 }, { id: 2, n: 10 }], found: [{ id: 1 }], marker: [{ id: 3 }] })
			})
		}

		// SET TRANSACTION and START TRANSACTION go as one statement: a READ ONLY insert failing proves both ran.
		it("starts a transaction with its settings and rolls back a failed one", async () => {
			const seen = await run(true, (db) =>
				Effect.gen(function* () {
					const readOnly = yield* db
						.transaction(db.run(MySQL.insertInto(T).values({ id: 4, note: "no", enabled: true, score: null, at })), { isolationLevel: "serializable", accessMode: "read only" })
						.pipe(Effect.flip, Effect.map((error) => String(error)))
					const aborted = yield* db
						.transaction(Effect.andThen(db.run(MySQL.insertInto(T).values({ id: 3, note: "gone", enabled: true, score: null, at })), Effect.fail("abort" as const)))
						.pipe(Effect.flip)
					const left = yield* db.run(MySQL.from(T).select("id"))
					return { readOnly: readOnly.includes("Cannot execute statement in a READ ONLY transaction"), aborted, left }
				}),
			)
			expect(seen).toEqual({ readOnly: true, aborted: "abort", left: [] })
		})
	})
}
