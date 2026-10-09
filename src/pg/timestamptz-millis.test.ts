import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, layer } from "@effect/vitest"
import { DateTime, Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Db from "../database"
import * as PG from "../postgres"

const Jobs = PG.table("jobs", {
	columns: {
		id: PG.text,
		runAt: PG.column(PG.timestamptzMillis, { name: "run_at" }),
		doneAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "done_at" }),
	},
	primaryKey: ["id"],
})

const Live = Layer.effect(
	Db.Database,
	Effect.gen(function* () {
		return Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: PG.postgresDialect })
	}),
).pipe(Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })))

const t0 = Date.parse("2026-01-01T00:00:00.250Z")

describe("timestamptzMillis", () => {
	layer(Live)((it) => {
		it.effect("writes and reads epoch milliseconds, and compares against every timestamp form", () =>
			Effect.gen(function* () {
				yield* Db.execute(Db.sql`CREATE TABLE jobs (id text PRIMARY KEY, run_at timestamptz NOT NULL, done_at timestamptz)`)
				yield* Db.run(
					PG.insertInto(Jobs).values([
						{ id: "a", runAt: t0 },
						{ id: "b", runAt: new Date(t0 + 1000), doneAt: DateTime.makeUnsafe(t0 + 2000) },
					]),
				)
				const rows = yield* Db.run(PG.from(Jobs).select().orderBy(["id", "asc"]))
				expect(rows).toEqual([
					{ id: "a", runAt: t0, doneAt: null },
					{ id: "b", runAt: t0 + 1000, doneAt: t0 + 2000 },
				])

				const since = (value: unknown) =>
					Db.run(PG.from(Jobs).select("id").where(($) => [$.runAt.gt(value as number)]))
				for (const value of [t0, new Date(t0), DateTime.makeUnsafe(t0), "2026-01-01T00:00:00.250Z"]) {
					expect(yield* since(value)).toEqual([{ id: "b" }])
				}
				expect(
					yield* Db.run(PG.from(Jobs).select("id").where(($) => [$.runAt.lte(PG.param.dateTime("at"))]), {
						at: new Date(t0),
					}),
				).toEqual([{ id: "a" }])

				// The text form some drivers send decodes to the same instant.
				const text = yield* Db.query(Db.sql`SELECT run_at::text AS run_at FROM jobs WHERE id = 'a'`)
				expect(Schema.decodeUnknownSync(PG.timestamptzMillis.schema)(text[0]!.run_at)).toBe(t0)
			}),
		)
	})
})
