import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Cause, DateTime, Effect, Exit, Schema } from "effect"
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

it("keeps query and union pagination when OFFSET has no LIMIT and branches have local limits", async () => {
	const rows = await withDatabase((db) => Effect.gen(function* () {
		yield* db.run(SQLite.insertInto(Items).values([1, 2, 3].map((id) => ({ id, note: `${id}`, enabled: false, score: null }))))
		const offset = yield* db.run(SQLite.from(Items).select("id").orderBy(["id", "asc"]).offset(1))
		const branch = (direction: "asc" | "desc") => SQLite.from(Items).select("id").orderBy(["id", direction]).limit(1)
		const union = yield* db.run(SQLite.unionAll(branch("asc"), branch("desc")).orderBy(["id", "asc"]).offset(1))
		return { offset, union }
	}))
	expect(rows).toEqual({ offset: [{ id: 2 }, { id: 3 }], union: [{ id: 3 }] })
})

it("refuses unsupported SQLite syntax while compiling, before sending SQL", () => {
	const defaulted = SQLite.table("items", { id: SQLite.integer, note: SQLite.text }, { defaults: ["note"] })
	expect(() => SQLite.compileUnsafe(SQLite.insertInto(defaulted).values([{ id: 1, note: "a" }, { id: 2 }]))).toThrow(/DEFAULT/)
	expect(() => SQLite.compileUnsafe(SQLite.insertInto(Items)
		.values({ id: 1, note: "a", enabled: true, score: null })
		.onConflictDoNothing({ target: { constraint: "items_pkey" } }))).toThrow(/ON CONSTRAINT/)
	expect(() => SQLite.compileUnsafe(SQLite.from(Items).select("id").distinctOn("id"))).toThrow(/DISTINCT ON/)
	expect(() => SQLite.compileUnsafe(SQLite.from(Items).select("id").where(($) => [$.note.ilike("a%")]))).toThrow(/ILIKE/)
	expect(() => SQLite.compileUnsafe(SQLite.from(Items).select("id").forUpdate())).toThrow(/row locks/)
})

it("runs INSERT SELECT with ON CONFLICT even when the source has no WHERE", async () => {
	const rows = await withDatabase((db) => Effect.gen(function* () {
		yield* db.run(SQLite.insertInto(Items).values({ id: 1, note: "first", enabled: true, score: null }))
		yield* db.run(SQLite.insertInto(Items).select(SQLite.from(Items).select()).onConflictDoNothing())
		return yield* db.run(SQLite.from(Items).select("id"))
	}))
	expect(rows).toEqual([{ id: 1 }])
})

it("decodes SQLite aggregates, including SQL NULL for an empty aggregate", async () => {
	const rows = await withDatabase((db) => Effect.gen(function* () {
		yield* db.run(SQLite.insertInto(Items).values([
			{ id: 1, note: "A", enabled: true, score: 2 },
			{ id: 2, note: "B", enabled: false, score: 4 },
		]))
		const totals = yield* db.run(SQLite.from(Items).select(($) => ({ n: SQLite.count(), enabled: SQLite.countIf($.enabled.eq(true)), total: SQLite.sum($.score), avg: SQLite.avg($.score), min: SQLite.min($.score), max: SQLite.max($.score) })))
		const empty = yield* db.run(SQLite.from(Items).select(($) => ({ n: SQLite.count(), sum: SQLite.sum($.score) })).where(($) => [$.id.eq(99)]))
		return { totals, empty }
	}))
	expect(rows).toEqual({ totals: [{ n: 2, enabled: 1, total: 6, avg: 3, min: 2, max: 4 }], empty: [{ n: 0, sum: null }] })
})

it("round-trips JSON, blobs and zoned timestamps, and runs SQLite scalar functions", async () => {
	const Payloads = SQLite.table("payloads", { id: SQLite.integer, value: SQLite.json(Schema.Struct({ message: Schema.String })), bytes: SQLite.blob, at: SQLite.timestamp })
	const seen = await withDatabase((db) => Effect.gen(function* () {
		yield* db.execute({ sql: "CREATE TABLE payloads (id INTEGER, value TEXT, bytes BLOB, at TEXT)" })
		const returned = yield* db.run(SQLite.insertInto(Payloads).values({ id: 1, value: { message: "__PARAM_id__\0😀" }, bytes: new Uint8Array([0, 127, 255]), at: DateTime.makeUnsafe("2026-10-01T10:00:00+02:00") }).returning())
		yield* db.run(SQLite.insertInto(Items).values({ id: 1, note: "HELLO", enabled: true, score: null }))
		const scalar = yield* db.run(SQLite.from(Items).select(($) => ({ lower: SQLite.lower($.note), upper: SQLite.upper($.note), length: SQLite.length($.note), fallback: SQLite.coalesce($.score, SQLite.lit(9)) })))
		return { returned, scalar }
	}))
	expect(seen.returned[0]?.value).toEqual({ message: "__PARAM_id__\0😀" })
	expect(seen.returned[0]?.bytes).toEqual(new Uint8Array([0, 127, 255]))
	expect(seen.returned.map((row) => DateTime.formatIso(row.at))).toEqual(["2026-10-01T08:00:00.000Z"])
	expect(seen.scalar).toEqual([{ lower: "hello", upper: "HELLO", length: 5, fallback: 9 }])
})

it("binds repeated positional params independently and quotes reserved-marker literals safely", async () => {
	const result = await withDatabase((db) => Effect.gen(function* () {
		const note = "' OR 1=1 -- __PARAM_note__😀"
		yield* db.run(SQLite.insertInto(Items).values({ id: 1, note, enabled: false, score: null }))
		const query = SQLite.from(Items).select("id").where(($) => [$.note.eq(SQLite.param.string("note")), $.note.eq(SQLite.param.string("note"))])
		const compiled = yield* SQLite.compile(query, { note })
		const rows = yield* db.run(compiled)
		const literal = yield* db.query({ sql: `SELECT ${SQLite.sqliteDialect.quoteString(note)} AS note` })
		return { parameters: compiled.parameters, rows, literal }
	}))
	expect(result.parameters).toEqual(["' OR 1=1 -- __PARAM_note__😀", "' OR 1=1 -- __PARAM_note__😀"])
	expect(result.rows).toEqual([{ id: 1 }])
	expect(result.literal).toEqual([{ note: "' OR 1=1 -- __PARAM_note__😀" }])
})

it("refuses U+0000 in text, which SQLite drivers would cut short", () => {
	// node:sqlite returns `SELECT 'a' || char(0) || 'b'` as "a": the value would be silently truncated.
	const refused = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) && /U\+0000/.test(String(Cause.squash(exit.cause)))
	const where = SQLite.from(Items).select("id").where(($) => [$.note.eq(SQLite.param.string("note"))])
	expect(refused(Effect.runSyncExit(SQLite.compile(where, { note: "a\0b" })))).toBe(true)
	expect(refused(Effect.runSyncExit(SQLite.compile(SQLite.insertInto(Items).values({ id: 1, note: "a\0b", enabled: true, score: null }))))).toBe(true)
	expect(refused(Effect.runSyncExit(SQLite.compile(SQLite.from(Items).select(() => ({ v: SQLite.lit("a\0b") })))))).toBe(true)
})

it("binds a fraction instead of writing decimal text SQLite would read as another double", async () => {
	const value = 1.23456789e-95
	const rows = await withDatabase((db) => db.run(SQLite.from(Items).select(() => ({ v: SQLite.lit(value) })).limit(1).crossTenant()))
	const compiled = SQLite.compileUnsafe(SQLite.from(Items).select(() => ({ v: SQLite.lit(value) })))
	expect(compiled.sql).not.toContain("e-95")
	expect(compiled.parameters).toEqual([value])
	expect(rows).toEqual([])
})

it("rejects a stored value that does not match the derived row schema", async () => {
	const exit = await withDatabase((db) => Effect.gen(function* () {
		yield* db.execute({ sql: "INSERT INTO items VALUES (1, 'bad boolean', 2, NULL)" })
		return yield* Effect.exit(db.run(SQLite.from(Items).select()))
	}))
	if (!Exit.isFailure(exit)) throw new Error("invalid database row was accepted")
	expect(Cause.findError(exit.cause)).toMatchObject({ success: { _tag: "@maple-dev/effect-orm/CompiledQueryDecodeError" } })
})

it("rolls back failed SQLite transactions and nested savepoints", async () => {
	const ids = await withDatabase((db) => Effect.gen(function* () {
		const insert = (id: number) => db.run(SQLite.insertInto(Items).values({ id, note: `${id}`, enabled: true, score: null }))
		yield* db.transaction(Effect.gen(function* () {
			yield* insert(1)
			yield* Effect.result(db.transaction(Effect.andThen(insert(2), Effect.fail("inner"))))
			yield* insert(3)
		}))
		yield* Effect.result(db.transaction(Effect.andThen(insert(4), Effect.fail("outer"))))
		return yield* db.run(SQLite.from(Items).select("id").orderBy(["id", "asc"]))
	}))
	expect(ids).toEqual([{ id: 1 }, { id: 3 }])
})

it("executes SQLite upserts, updates and deletes with RETURNING", async () => {
	const rows = await withDatabase((db) => Effect.gen(function* () {
		yield* db.run(SQLite.insertInto(Items).values([{ id: 1, note: "first", enabled: true, score: 2 }, { id: 2, note: "second", enabled: false, score: null }]))
		const upsert = yield* db.run(SQLite.insertInto(Items).values({ id: 1, note: "replacement", enabled: true, score: 3 })
			.onConflictDoUpdate({ target: ["id"], set: { note: "updated" } }).returning("id", "note"))
		const update = yield* db.run(SQLite.update(Items).set({ note: "changed" }).where(($) => [$.id.eq(2)]).returning("note"))
		const deleted = yield* db.run(SQLite.deleteFrom(Items).where(($) => [$.id.eq(2)]).returning("id"))
		return { upsert, update, deleted }
	}))
	expect(rows).toEqual({ upsert: [{ id: 1, note: "updated" }], update: [{ note: "changed" }], deleted: [{ id: 2 }] })
})

it("runs scoped CTEs, joins and derived-table queries with the same row decoder", async () => {
	const rows = await withDatabase((db) => Effect.gen(function* () {
		yield* db.run(SQLite.insertInto(Items).values({ id: 1, note: "one", enabled: true, score: null }))
		const filtered = SQLite.from(Items).select("id", "note").where(($) => [$.id.eq(SQLite.param.int("id"))])
		const Recent = SQLite.table("recent", { id: SQLite.integer, note: SQLite.text })
		const cte = yield* db.run(SQLite.from(Recent).withCTE("recent", filtered).select(), { id: 1 })
		const joined = yield* db.run(SQLite.fromQuery(filtered, "filtered").innerJoin(Items, "i", (a, b) => a.id.eq(b.id)).select(($) => ({ id: $.id, note: $.i.note })), { id: 1 })
		return { cte, joined }
	}))
	expect(rows).toEqual({ cte: [{ id: 1, note: "one" }], joined: [{ id: 1, note: "one" }] })
})

it("builds an external table from its columns, not from the definition's keys", () => {
	const External = SQLite.table("ext", { external: true, columns: { id: SQLite.integer, org_id: SQLite.text }, tenantColumn: "org_id" })
	expect(Object.keys(External.columns)).toEqual(["id", "org_id"])
	expect(External.tenantColumn).toBe("org_id")
	expect(SQLite.compileUnsafe(SQLite.from(External).select("id").where(($) => [$.org_id.eq("o")])).sql).toContain('"ext"."org_id" = ?')
})
