// Client-side defaults on SQLite: `defaultFn` and `onUpdate` on `SQLite.column`
// run in `Database.run` as on Postgres, against node:sqlite. They write no DDL,
// so the rendered schema and the migrations `generate` writes carry none.

import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { assert, describe, expect, it } from "@effect/vitest"
import { Cause, Context, DateTime, Effect, Exit, Layer, Ref, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as SqlClient from "effect/sql/SqlClient"
import * as Db from "../database"
import * as S from "../schema"
import * as SQLite from "../sqlite"

class IdGen extends Context.Service<IdGen, { readonly next: Effect.Effect<string> }>()("test/sqlite/IdGen") {}

const IdGenLive = Layer.effect(
	IdGen,
	Effect.map(Ref.make(0), (counter) => ({ next: Effect.map(Ref.updateAndGet(counter, (n) => n + 1), (n) => `id-${n}`) })),
)

const Notes = SQLite.table("notes", {
	columns: {
		id: SQLite.column(SQLite.text, { defaultFn: Effect.flatMap(Effect.service(IdGen), (gen) => gen.next) }),
		body: SQLite.text,
		createdAt: SQLite.column(SQLite.timestamp, { name: "created_at", defaultFn: DateTime.now }),
		updatedAt: SQLite.column(SQLite.timestamp, { name: "updated_at", onUpdate: DateTime.now }),
		touchedAt: SQLite.column(SQLite.timestamp, { name: "touched_at", defaultExpr: "(strftime('%Y-%m-%d %H:%M:%f', 'now'))", onUpdate: DateTime.now }),
	},
	primaryKey: ["id"],
})

const at = (millis: number) => DateTime.makeUnsafe(millis)

const Live = Layer.effect(
	Db.Database,
	Effect.map(Effect.service(SqlClient.SqlClient), (sql) => Db.fromSqlClient(sql, { dialect: SQLite.sqliteDialect })),
).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))

describe("client-side defaults on SQLite", () => {
	it.effect("write no DDL: only the database default reaches CREATE TABLE", () =>
		Effect.gen(function* () {
			const ddl = (yield* Effect.map(S.sqliteEntitiesOf([Notes]), S.renderSqliteSchema)).join("\n")
			expect(ddl).toContain(`"id" text PRIMARY KEY NOT NULL`)
			expect(ddl).toContain(`"created_at" text NOT NULL,`)
			expect(ddl).toContain(`"updated_at" text NOT NULL,`)
			expect(ddl).toContain(`"touched_at" text NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))`)
			expect(ddl.match(/DEFAULT/g)).toHaveLength(1)
		}),
	)

	it.effect("fill inserts and updates through Database.run, and keep values the write gives", () =>
		Effect.gen(function* () {
			for (const sql of yield* Effect.map(S.sqliteEntitiesOf([Notes]), S.renderSqliteSchema)) yield* Db.execute({ sql })
			yield* TestClock.setTime(1_000)
			const inserted = yield* Db.run(
				SQLite.insertInto(Notes)
					.values([{ body: "a" }, { id: "given", body: "b", updatedAt: at(5) }])
					.returning("id", "body", "createdAt", "updatedAt"),
			)
			expect(inserted).toEqual([
				{ id: "id-1", body: "a", createdAt: at(1_000), updatedAt: at(1_000) },
				{ id: "given", body: "b", createdAt: at(1_000), updatedAt: at(5) },
			])
			yield* TestClock.setTime(2_000)
			const updated = yield* Db.run(
				SQLite.update(Notes).set({ body: "c" }).where(($) => [$.id.eq("id-1")]).returning("body", "updatedAt", "touchedAt"),
			)
			expect(updated).toEqual([{ body: "c", updatedAt: at(2_000), touchedAt: at(2_000) }])
		}).pipe(Effect.provide(Layer.merge(Live, IdGenLive))),
	)

	it.effect("fill a write sent through Database.stream", () =>
		Effect.gen(function* () {
			for (const sql of yield* Effect.map(S.sqliteEntitiesOf([Notes]), S.renderSqliteSchema)) yield* Db.execute({ sql })
			yield* TestClock.setTime(3_000)
			const rows = yield* Stream.runCollect(Db.stream(SQLite.insertInto(Notes).values({ body: "s" }).returning("id", "createdAt")))
			expect(rows).toEqual([{ id: "id-1", createdAt: at(3_000) }])
		}).pipe(Effect.provide(Layer.merge(Live, IdGenLive))),
	)

	it.effect("refuse a write compiled without fillDefaults, and an INSERT ... SELECT that leaves one out", () =>
		Effect.gen(function* () {
			const insert = SQLite.insertInto(Notes).values({ body: "a" })
			const exit = yield* Effect.exit(SQLite.compile(insert))
			assert(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
			expect(String((Cause.squash(exit.cause) as Error).message)).toContain("fillDefaults")
			const filled = yield* SQLite.fillDefaults(insert)
			expect((yield* SQLite.compile(filled)).sql).toContain(`"created_at"`)

			const Drafts = SQLite.table("drafts", { columns: { id: SQLite.text, body: SQLite.text }, primaryKey: ["id"] })
			const copy = SQLite.insertInto(Notes).select(SQLite.from(Drafts).select("id", "body"))
			const refused = yield* Effect.exit(SQLite.compile(copy))
			assert(Exit.isFailure(refused) && Cause.hasDies(refused.cause))
			expect(String((Cause.squash(refused.cause) as Error).message)).toMatch(/does not select createdAt, updatedAt.*INSERT \.\.\. SELECT/)
		}).pipe(Effect.provide(IdGenLive)),
	)
})
