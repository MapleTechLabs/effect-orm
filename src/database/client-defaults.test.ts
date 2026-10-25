// Client-side defaults: `defaultFn` and `onUpdate` on `PG.column` are Effects,
// run by `Database.run`, against PGlite. The Effects read a service and the
// test clock, so every value they write is known here.

import { PgliteClient } from "@effect/sql-pglite"
import { assert, describe, expect, it, layer } from "@effect/vitest"
import { Cause, Context, DateTime, Effect, Exit, Layer, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as SqlClient from "effect/sql/SqlClient"
import * as PG from "../postgres"
import { postgresDialect } from "../pg/dialect"
import * as Db from "../database"

class IdGen extends Context.Service<IdGen, { readonly next: Effect.Effect<string> }>()("test/IdGen") {}

const nextId = Effect.flatMap(Effect.service(IdGen), (gen) => gen.next)

/** Ids `id-1`, `id-2`, ... in the order they are asked for. */
const IdGenLive = Layer.effect(
	IdGen,
	Effect.map(Ref.make(0), (counter) => ({
		next: Effect.map(Ref.updateAndGet(counter, (n) => n + 1), (n) => `id-${n}`),
	})),
)

const Live = Layer.effect(
	Db.Database,
	Effect.map(Effect.service(SqlClient.SqlClient), (sql) => Db.fromSqlClient(sql, { dialect: postgresDialect })),
).pipe(Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })))

let tables = 0
/** A fresh `notes` table per test: the client is shared across the file. */
const freshNotes = Effect.gen(function* () {
	const name = `notes_${++tables}`
	yield* Db.execute({
		sql: `CREATE TABLE "${name}" (id text PRIMARY KEY, body text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
	})
	return PG.table(name, {
		columns: {
			id: PG.column(PG.text, { defaultFn: nextId }),
			body: PG.text,
			createdAt: PG.column(PG.timestamptz, { name: "created_at", defaultFn: DateTime.now }),
			updatedAt: PG.column(PG.timestamptz, { name: "updated_at", onUpdate: DateTime.now }),
		},
		primaryKey: ["id"],
	})
})

const at = (millis: number) => DateTime.makeUnsafe(millis)

layer(Live)("client-side defaults on PGlite", (it) => {
	describe("insert", () => {
		it.effect("fills a column left out by running its defaultFn, one run per row", () =>
			Effect.gen(function* () {
				const Notes = yield* freshNotes
				yield* TestClock.setTime(1_000)
				const rows = yield* Db.run(
					PG.insertInto(Notes)
						.values([{ body: "a" }, { body: "b" }])
						.returning("id", "body", "createdAt", "updatedAt"),
				)
				expect(rows).toEqual([
					{ id: "id-1", body: "a", createdAt: at(1_000), updatedAt: at(1_000) },
					{ id: "id-2", body: "b", createdAt: at(1_000), updatedAt: at(1_000) },
				])
			}).pipe(Effect.provide(IdGenLive)),
		)

		it.effect("keeps a value the row gives, and does not run that column's Effect", () =>
			Effect.gen(function* () {
				const Notes = yield* freshNotes
				yield* TestClock.setTime(2_000)
				const rows = yield* Db.run(
					PG.insertInto(Notes)
						.values([
							{ id: "mine", body: "a", createdAt: at(5), updatedAt: at(6) },
							{ body: "b" },
						])
						.returning("id", "createdAt", "updatedAt"),
				)
				// The first row asked for no id, so the second gets the first one.
				expect(rows).toEqual([
					{ id: "mine", createdAt: at(5), updatedAt: at(6) },
					{ id: "id-1", createdAt: at(2_000), updatedAt: at(2_000) },
				])
			}).pipe(Effect.provide(IdGenLive)),
		)
	})

	describe("update", () => {
		const seeded = Effect.gen(function* () {
			const Notes = yield* freshNotes
			yield* TestClock.setTime(1_000)
			// The insert type requires IdGen even with the id given; the updates below need nothing.
			yield* Db.run(PG.insertInto(Notes).values({ id: "n", body: "a" })).pipe(Effect.provide(IdGenLive))
			yield* TestClock.setTime(9_000)
			return Notes
		})

		it.effect("sets an onUpdate column the SET leaves out, from a record or a callback", () =>
			Effect.gen(function* () {
				const Notes = yield* seeded
				const record = yield* Db.run(
					PG.update(Notes)
						.set({ body: "b" })
						.where(($) => [$.id.eq("n")])
						.returning("body", "createdAt", "updatedAt"),
				)
				expect(record).toEqual([{ body: "b", createdAt: at(1_000), updatedAt: at(9_000) }])
				yield* TestClock.setTime(10_000)
				const callback = yield* Db.run(
					PG.update(Notes)
						.set(($) => ({ body: $.id }))
						.where(($) => [$.id.eq("n")])
						.returning("body", "updatedAt"),
				)
				expect(callback).toEqual([{ body: "n", updatedAt: at(10_000) }])
			}),
		)

		it.effect("keeps an onUpdate column the SET gives", () =>
			Effect.gen(function* () {
				const Notes = yield* seeded
				const rows = yield* Db.run(
					PG.update(Notes)
						.set(() => ({ body: "b", updatedAt: at(7) }))
						.where(($) => [$.id.eq("n")])
						.returning("updatedAt"),
				)
				expect(rows).toEqual([{ updatedAt: at(7) }])
			}),
		)
	})

	describe("compile", () => {
		it.effect("refuses a write that still lacks a client default; fillDefaults runs them first", () =>
			Effect.gen(function* () {
				const Notes = yield* freshNotes
				const insert = PG.insertInto(Notes).values({ body: "a" })
				const exit = yield* Effect.exit(PG.compile(insert))
				assert(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
				expect(Cause.squash(exit.cause)).toBeInstanceOf(PG.QueryBuilderDefect)
				expect(String((Cause.squash(exit.cause) as Error).message)).toContain("fillDefaults")

				yield* TestClock.setTime(3_000)
				const filled = yield* PG.fillDefaults(insert)
				const compiled = yield* PG.compile(filled)
				expect(compiled.parameters).toEqual(["id-1", "a", "1970-01-01T00:00:03.000Z", "1970-01-01T00:00:03.000Z"])

				const update = PG.update(Notes).set({ body: "b" }).allRows()
				const refused = yield* Effect.exit(PG.compile(update))
				assert(Exit.isFailure(refused) && Cause.hasDies(refused.cause))
				expect((yield* PG.compile(yield* PG.fillDefaults(update))).sql).toContain(`"updated_at" = `)
			}).pipe(Effect.provide(IdGenLive)),
		)

		it.effect("leaves an onUpdate column with a database default to the database on insert", () =>
			Effect.gen(function* () {
				const Stamped = PG.table("stamped", {
					columns: {
						id: PG.text,
						at: PG.column(PG.timestamptz, { defaultExpr: "now()", onUpdate: DateTime.now }),
					},
				})
				const insert = PG.insertInto(Stamped).values({ id: "x" })
				expect((yield* PG.compile(insert)).sql).toBe(`INSERT INTO "stamped" ("id")\nVALUES ($1)`)
				expect(yield* PG.fillDefaults(insert)).toBe(insert)
				const update = yield* PG.fillDefaults(PG.update(Stamped).set({ id: "y" }).allRows())
				expect((yield* PG.compile(update)).sql).toBe(`UPDATE "stamped" SET "id" = $1, "at" = $2`)
			}),
		)
	})
})
