// A value given as `Redacted` is marked in `CompiledQuery.sensitiveParameters`,
// so a tracer or a log can leave it out. The driver still gets the plain value.
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Redacted, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Db from "../database"
import * as PG from "../postgres"
import * as SQLite from "../sqlite"

const doorCode = PG.brand(PG.text, Schema.RedactedFromValue(Schema.String))
const Codes = PG.table("door_codes", { columns: { id: PG.int4, code: doorCode }, primaryKey: ["id"] })

describe("sensitiveParameters", () => {
	it("marks a Redacted value compared with a column", () => {
		const compiled = PG.compileUnsafe(
			PG.from(Codes)
				.select(($) => ({ id: $.id }))
				.where(($) => [$.id.eq(5), $.code.eq(Redacted.make("1234"))]),
		)
		expect(compiled.parameters).toEqual([5, "1234"])
		expect(compiled.sensitiveParameters).toEqual([1])
	})

	it("marks a Redacted param value", () => {
		const compiled = PG.compileUnsafe(
			PG.from(Codes)
				.select(($) => ({ id: $.id }))
				.where(($) => [$.code.eq(PG.param.of(doorCode, "code"))]),
			{ code: Redacted.make("9") },
		)
		expect(compiled.parameters).toEqual(["9"])
		expect(compiled.sensitiveParameters).toEqual([0])
	})

	it("marks a Redacted value an insert or update writes", () => {
		const insert = PG.compileUnsafe(PG.insertInto(Codes).values({ id: 2, code: Redacted.make("777") }))
		expect(insert.parameters).toEqual([2, "777"])
		expect(insert.sensitiveParameters).toEqual([1])
		const update = PG.compileUnsafe(PG.update(Codes).set({ code: Redacted.make("888") }).where(($) => [$.id.eq(1)]))
		expect(update.parameters).toEqual(["888", 1])
		expect(update.sensitiveParameters).toEqual([0])
	})

	it("marks a Redacted value inside a union branch", () => {
		const branch = (code: string) =>
			PG.from(Codes)
				.select(($) => ({ id: $.id }))
				.where(($) => [$.code.eq(Redacted.make(code))])
		const compiled = PG.compileUnionUnsafe(PG.unionAll(branch("a"), branch("b")))
		expect(compiled.sensitiveParameters).toEqual([0, 1])
	})

	it("is absent when no value is Redacted", () => {
		const compiled = PG.compileUnsafe(PG.from(Codes).select(($) => ({ id: $.id })).where(($) => [$.id.eq(5)]))
		expect(compiled.sensitiveParameters).toBeUndefined()
	})
})

// SQLite and D1 bind `?` values, so they mark Redacted values as Postgres does.
const sqliteDoorCode = SQLite.brand(SQLite.text, Schema.RedactedFromValue(Schema.String))
const SqliteCodes = SQLite.table("door_codes", { columns: { id: SQLite.integer, code: sqliteDoorCode }, primaryKey: ["id"] })

describe("sensitiveParameters on SQLite", () => {
	it("marks compared and written Redacted values on SQLite and D1", () => {
		for (const dialect of [SQLite.sqliteDialect, SQLite.d1Dialect]) {
			const select = SQLite.compileUnsafe(
				SQLite.from(SqliteCodes)
					.select(($) => ({ id: $.id }))
					.where(($) => [$.id.eq(5), $.code.eq(Redacted.make("1234"))]),
				{},
				{ dialect },
			)
			expect(select.parameters).toEqual([5, "1234"])
			expect(select.sensitiveParameters).toEqual([1])
			const insert = SQLite.compileUnsafe(SQLite.insertInto(SqliteCodes).values({ id: 2, code: Redacted.make("777") }), {}, { dialect })
			expect(insert.parameters).toEqual([2, "777"])
			expect(insert.sensitiveParameters).toEqual([1])
		}
	})

	it.effect("binds the plain value, and observeExit and span parameters keep it redacted", () =>
		Effect.gen(function* () {
			const seen: Array<Db.StatementObservation> = []
			const db = Db.fromSqlClient(yield* SqlClient.SqlClient, {
				dialect: SQLite.sqliteDialect,
				spanParameters: true,
				observeExit: (observation) => Effect.sync(() => void seen.push(observation)),
			})
			yield* db.execute({ sql: "CREATE TABLE door_codes (id INTEGER PRIMARY KEY, code TEXT NOT NULL)" })
			yield* db.run(SQLite.insertInto(SqliteCodes).values({ id: 1, code: Redacted.make("4821") }))
			yield* db.execute(Db.sql`INSERT INTO door_codes VALUES (${2}, ${Redacted.make("5932")})`)
			const stored = yield* db.query({ sql: "SELECT code FROM door_codes ORDER BY id" })
			expect(stored).toEqual([{ code: "4821" }, { code: "5932" }])
			const [, compiled, template] = seen
			assert(compiled !== undefined && template !== undefined)
			expect(compiled.system).toBe("sqlite")
			assert(Redacted.isRedacted(compiled.parameters[1]))
			assert(Redacted.isRedacted(template.parameters[1]))
			expect(JSON.stringify(seen)).not.toMatch(/4821|5932/)
		}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
	)
})
