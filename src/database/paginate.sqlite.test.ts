// `paginate` on SQLite and a local D1: the row comparison and the mixed-direction
// seek both walk every row once, timestamps (stored as text) round-trip through
// the cursor, and a nullable key is refused even when the type check is bypassed.

import * as D1Client from "@effect/sql-d1/D1Client"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Cause, DateTime, Effect, Exit, Layer, Option } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { Miniflare } from "miniflare"
import { expect, it } from "vitest"
import * as Db from "../database"
import * as SQLite from "../sqlite"
import type { Dialect } from "../ch/dialect"

const Posts = SQLite.table(
	"posts",
	{ id: SQLite.integer, org: SQLite.text, at: SQLite.timestamp, note: SQLite.nullable(SQLite.text) },
	{ tenantColumn: "org" },
)
const byOrg = SQLite.from(Posts)
	.select("id", "at", "note")
	.where(($) => [$.org.eq(SQLite.param.string("org"))])
type Row = { readonly id: number; readonly at: DateTime.Utc; readonly note: string | null }

const walk = (orderBy: Db.PaginateOptions<Row>["orderBy"]) =>
	Effect.gen(function* () {
		const pages: Array<ReadonlyArray<number>> = []
		let after: string | undefined
		for (;;) {
			const page = yield* Db.paginate(byOrg, { orderBy, limit: 4, after }, { org: "a" })
			pages.push(page.rows.map((row) => row.id))
			if (Option.isNone(page.nextCursor)) return pages
			after = page.nextCursor.value
		}
	})

const pagesOn = (dialect: Dialect, client: Layer.Layer<SqlClient.SqlClient, unknown>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect, requireTenantScope: true })
			yield* db.execute({ sql: "CREATE TABLE posts (id INTEGER PRIMARY KEY, org TEXT NOT NULL, at TEXT NOT NULL, note TEXT)" })
			// Ten posts in org "a" whose timestamps tie in pairs, with NULL notes on
			// the odd ids, and one post in org "b".
			const rows = Array.from({ length: 10 }, (_, i) => ({
				id: i + 1,
				org: "a",
				at: DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, Math.ceil((i + 1) / 2))),
				note: (i + 1) % 2 === 0 ? `n${i + 1}` : null,
			}))
			yield* db.run(SQLite.insertInto(Posts).values([...rows, { id: 11, org: "b", at: rows[0]!.at, note: null }]).crossTenant())
			const run = <A, E>(effect: Effect.Effect<A, E, Db.Database>) => Effect.provideService(effect, Db.Database, db)
			const desc = yield* run(walk([["at", "desc"], ["id", "desc"]]))
			const mixed = yield* run(walk([["at", "asc"], ["id", "desc"]]))
			const nullable = yield* run(Effect.exit(Db.paginate(byOrg, { orderBy: [["note", "asc"]] as any, limit: 4 }, { org: "a" })))
			return { desc, mixed, nullable }
		}).pipe(Effect.provide(client)),
	)

const check = ({ desc, mixed, nullable }: Awaited<ReturnType<typeof pagesOn>>) => {
	expect(desc).toEqual([[10, 9, 8, 7], [6, 5, 4, 3], [2, 1]])
	expect(mixed).toEqual([[2, 1, 4, 3], [6, 5, 8, 7], [10, 9]])
	expect(Exit.isFailure(nullable) && Cause.hasDies(nullable.cause)).toBe(true)
	expect(String(Exit.isFailure(nullable) ? Cause.squash(nullable.cause) : "")).toMatch(/can be NULL/)
}

it("walks keyset pages on SQLite", async () => {
	check(await pagesOn(SQLite.sqliteDialect, SqliteClient.layer({ filename: ":memory:" })))
})

it("walks keyset pages on D1", async () => {
	const mf = new Miniflare({
		modules: true,
		script: "export default { fetch() { return new Response('paginate test') } }",
		compatibilityDate: "2026-07-01",
		d1Databases: ["DB"],
	})
	try {
		check(await pagesOn(SQLite.d1Dialect, D1Client.layer({ db: await mf.getD1Database("DB") })))
	} finally {
		await mf.dispose()
	}
}, 30_000)
