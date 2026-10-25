// `Database.stream` on PGlite: rows come out one at a time, each decoded by
// the query's row Schema. PGlite has no cursor, so its driver reads the whole
// result and emits it as a stream; the contract checked here does not depend
// on that.

import { PgliteClient } from "@effect/sql-pglite"
import { assert, expect, layer } from "@effect/vitest"
import { DateTime, Effect, Layer, Option, Stream, Tracer } from "effect"
import * as CH from "../ch/index"
import * as SqlClient from "effect/sql/SqlClient"
import * as PG from "../postgres"
import { postgresDialect } from "../pg/dialect"
import * as Db from "../database"

const Live = Layer.effect(
	Db.Database,
	Effect.gen(function* () {
		return Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: postgresDialect })
	}),
).pipe(Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })))

const Events = PG.table("stream_events", {
	columns: { id: PG.int4, at: PG.timestamptz, note: PG.nullable(PG.text) },
	primaryKey: ["id"],
})

const at = (id: number) => DateTime.makeUnsafe(`2026-01-0${id}T00:00:00.000Z`)

layer(Live, { excludeTestServices: true })("Database.stream on PGlite", (it) => {
	it.effect("creates and fills the table", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`CREATE TABLE stream_events (id int4 PRIMARY KEY, at timestamptz NOT NULL, note text)`)
			yield* Db.run(
				PG.insertInto(Events).values([
					{ id: 1, at: at(1), note: "a" },
					{ id: 2, at: at(2), note: null },
					{ id: 3, at: at(3), note: "c" },
				]),
			)
		}),
	)

	it.effect("streams the rows of a query, each decoded by its row schema", () =>
		Effect.gen(function* () {
			const rows = yield* Stream.runCollect(
				Db.stream(PG.from(Events).select("id", "at", "note").orderBy(["id", "asc"])),
			)
			expect(rows).toEqual([
				{ id: 1, at: at(1), note: "a" },
				{ id: 2, at: at(2), note: null },
				{ id: 3, at: at(3), note: "c" },
			])
			expect(DateTime.isDateTime(rows[0]!.at)).toBe(true)
		}),
	)

	it.effect("a row that does not match fails the stream with its index, after the rows before it", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`CREATE TABLE stream_flags (id int4 PRIMARY KEY, flag text)`)
			yield* Db.execute(Db.sql`INSERT INTO stream_flags VALUES (1, NULL), (2, 'x'), (3, NULL)`)
			// The table says boolean; the column holds text.
			const Flags = PG.table("stream_flags", { columns: { id: PG.int4, flag: PG.nullable(PG.bool) }, primaryKey: ["id"] })
			const seen: Array<number> = []
			const error = yield* Effect.flip(
				Stream.runForEach(Db.stream(PG.from(Flags).select("id", "flag").orderBy(["id", "asc"])), (row) =>
					Effect.sync(() => void seen.push(row.id)),
				),
			)
			expect(seen).toEqual([1])
			expect(error).toBeInstanceOf(CH.CompiledQueryDecodeError)
			expect(error).toMatchObject({ rowIndex: 1 })
		}),
	)

	it.effect("runs on the transaction's connection inside a transaction", () =>
		Effect.gen(function* () {
			const ids = Db.stream(PG.from(Events).select("id").orderBy(["id", "asc"])).pipe(
				Stream.map((row) => row.id),
				Stream.runCollect,
			)
			// The body fails with what the stream saw, so the transaction rolls back.
			const inside = yield* Db.transaction(
				Db.run(PG.insertInto(Events).values({ id: 4, at: at(4), note: null })).pipe(
					Effect.andThen(ids),
					Effect.flatMap((seen) => Effect.fail(seen)),
				),
			).pipe(Effect.flip)
			expect(inside).toEqual([1, 2, 3, 4])
			// The failure rolled the insert back.
			expect(yield* ids).toEqual([1, 2, 3])
		}),
	)

	it.effect("fills params, and streams the RETURNING rows of a write", () =>
		Effect.gen(function* () {
			const byId = PG.from(Events)
				.select("id", "note")
				.where(($) => [$.id.eq(PG.param.int("id"))])
			expect(yield* Stream.runCollect(Db.stream(byId, { id: 3 }))).toEqual([{ id: 3, note: "c" }])
			const renamed = PG.update(Events)
				.set({ note: "z" })
				.where(($) => [$.id.lte(2)])
				.returning(($) => ({ id: $.id, note: $.note }))
			const rows = yield* Stream.runCollect(Db.stream(renamed))
			expect([...rows].sort((a, b) => a.id - b.id)).toEqual([
				{ id: 1, note: "z" },
				{ id: 2, note: "z" },
			])
			// A write without RETURNING runs and emits nothing.
			const reset = PG.update(Events).set({ note: null }).where(($) => [$.id.lte(2)])
			expect(yield* Stream.runCollect(Db.stream(reset))).toEqual([])
			expect(yield* Db.run(PG.from(Events).select("note").where(($) => [$.id.eq(1)]))).toEqual([{ note: null }])
		}),
	)

	it.effect("runs in one client span that counts the rows it emitted", () =>
		Effect.gen(function* () {
			const spans: Array<Tracer.NativeSpan> = []
			const recording = Tracer.make({
				span(options) {
					const span = new Tracer.NativeSpan({ ...options, sampled: true })
					spans.push(span)
					return span
				},
			})
			const rows = yield* Stream.runCollect(Db.stream(PG.from(Events).select("id"))).pipe(Effect.withTracer(recording))
			expect(rows).toHaveLength(3)
			const span = spans.find((s) => s.name === "SELECT stream_events")
			assert(span !== undefined, `no statement span among ${spans.map((s) => s.name).join(", ")}`)
			expect(span.kind).toBe("client")
			expect(span.status._tag).toBe("Ended")
			expect(Object.fromEntries(span.attributes)).toMatchObject({
				"db.system.name": "postgresql",
				"db.operation.name": "SELECT",
				"db.collection.name": "stream_events",
				"db.response.returned_rows": 3,
			})
			const execute = spans.find((s) => s.name === "sql.execute")
			assert(execute !== undefined)
			expect(Option.getOrUndefined(execute.parent)).toBe(span)
		}),
	)

	it.effect("a failed statement fails the stream with DatabaseError", () =>
		Effect.gen(function* () {
			const Missing = PG.table("stream_missing", { columns: { id: PG.int4 }, primaryKey: ["id"] })
			const error = yield* Effect.flip(Stream.runCollect(Db.stream(PG.from(Missing).select("id"))))
			expect(error).toBeInstanceOf(Db.DatabaseError)
			expect(error).toMatchObject({ sqlState: "42P01" })
		}),
	)
})
