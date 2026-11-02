// Seeding SQLite tables: every built-in SQLite type gets values that
// node:sqlite and a local D1 binding store and read back as seeded, in a table
// created from its own DDL.

import * as D1Client from "@effect/sql-d1/D1Client"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { Miniflare } from "miniflare"
import * as Db from "../database"
import * as S from "../schema"
import * as Seed from "../seed"
import * as SQLite from "../sqlite"

const Every = SQLite.table("every", {
	columns: {
		id: SQLite.integer,
		code: SQLite.column(SQLite.text, { unique: true }),
		note: SQLite.nullable(SQLite.text),
		ratio: SQLite.real,
		ok: SQLite.boolean,
		at: SQLite.timestamp,
		seen: SQLite.nullable(SQLite.timestamp),
		bytes: SQLite.blob,
		doc: SQLite.json(Schema.Struct({ tag: Schema.String, n: Schema.Number.check(Schema.isFinite()) })),
		created: SQLite.column(SQLite.timestamp, { defaultExpr: "(strftime('%Y-%m-%d %H:%M:%f', 'now'))" }),
	},
	primaryKey: ["id"],
})

const MIN = DateTime.toEpochMillis(DateTime.makeUnsafe("0000-01-01T00:00:00.000Z"))
const MAX = DateTime.toEpochMillis(DateTime.makeUnsafe("9999-12-31T23:59:59.999Z"))

const Live = Layer.effect(
	Db.Database,
	Effect.map(Effect.service(SqlClient.SqlClient), (sql) => Db.fromSqlClient(sql, { dialect: SQLite.sqliteDialect })),
).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))

describe("Seed on SQLite", () => {
	it.effect("integers stay safe, timestamps stay in 0000-9999, and the primary key and unique column are distinct", () =>
		Effect.gen(function* () {
			const rows = yield* Seed.rows(Every, { count: 200, seed: 1 })
			expect(new Set(rows.map((row) => row.id)).size).toBe(200)
			expect(new Set(rows.map((row) => row.code)).size).toBe(200)
			for (const row of rows) {
				expect(Number.isSafeInteger(row.id)).toBe(true)
				expect(typeof row.ok).toBe("boolean")
				for (const at of [row.at, row.seen]) {
					if (at === null) continue
					const millis = DateTime.toEpochMillis(at)
					expect(millis).toBeGreaterThanOrEqual(MIN)
					expect(millis).toBeLessThanOrEqual(MAX)
				}
				expect("created" in row).toBe(false)
			}
			// The range is used, not only the years near 1970.
			expect(rows.some((row) => DateTime.toEpochMillis(row.at) < Date.UTC(1000, 0, 1))).toBe(true)
			expect(rows.some((row) => DateTime.toEpochMillis(row.at) > Date.UTC(5000, 0, 1))).toBe(true)
		}),
	)

	for (const seed of [1, 2, 3, 4, 5]) {
		it.effect(`every built-in SQLite type stores and reads back as seeded (seed ${seed})`, () =>
			Effect.gen(function* () {
				for (const sql of yield* Effect.map(S.sqliteEntitiesOf([Every]), S.renderSqliteSchema)) yield* Db.execute({ sql })
				const seeded = yield* Seed.insert(Every, { count: 60, seed, batchSize: 25 })
				const read = yield* Db.run(SQLite.from(Every).select("id", "code", "note", "ratio", "ok", "at", "seen", "bytes", "doc"))
				const byId = new Map(read.map((row) => [row.id, row]))
				expect(byId.size).toBe(60)
				for (const row of seeded) expect(byId.get(row.id)).toEqual(row)
			}).pipe(Effect.provide(Live)),
		)
	}

	it("every built-in SQLite type stores and reads back as seeded on a local D1 binding", async () => {
		const mf = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('seed test') } }",
			compatibilityDate: "2026-07-01",
			d1Databases: ["DB"],
		})
		try {
			const binding = await mf.getD1Database("DB")
			const D1Live = Layer.effect(
				Db.Database,
				Effect.map(Effect.service(SqlClient.SqlClient), (sql) => Db.fromSqlClient(sql, { dialect: SQLite.d1Dialect })),
			).pipe(Layer.provideMerge(D1Client.layer({ db: binding })))
			await Effect.runPromise(
				Effect.gen(function* () {
					for (const sql of yield* Effect.map(S.sqliteEntitiesOf([Every]), S.renderSqliteSchema)) yield* Db.execute({ sql })
					const seeded = yield* Seed.insert(Every, { count: 40, seed: 6, batchSize: 10 })
					const read = yield* Db.run(SQLite.from(Every).select("id", "code", "note", "ratio", "ok", "at", "seen", "bytes", "doc"))
					const byId = new Map(read.map((row) => [row.id, row]))
					expect(byId.size).toBe(40)
					for (const row of seeded) expect(byId.get(row.id)).toEqual(row)
				}).pipe(Effect.provide(D1Live)),
			)
		} finally {
			await mf.dispose()
		}
	})
})
