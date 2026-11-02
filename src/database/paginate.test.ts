// `paginate` against PGlite: pages walked with the cursor each one returns
// cover every row once, in order, and the SQL is a keyset seek, not an OFFSET.

import { PgliteClient } from "@effect/sql-pglite"
import { expect, layer } from "@effect/vitest"
import { Cause, DateTime, Effect, Exit, Layer, Option } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as PG from "../postgres"
import { postgresDialect } from "../pg/dialect"
import * as Db from "../database"

const statements: Array<string> = []

const Live = Layer.effect(
	Db.Database,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		return Db.fromSqlClient(sql, {
			dialect: postgresDialect,
			observe: (statement) => Effect.sync(() => void statements.push(statement.sql)),
		})
	}),
).pipe(Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })))

const Posts = PG.table("posts", {
	columns: { id: PG.int4, org: PG.text, at: PG.timestamptz, title: PG.text, note: PG.nullable(PG.text) },
	primaryKey: ["id"],
	tenantColumn: "org",
})

// Ten posts in org "a", with timestamps that tie in pairs, and one in org "b".
const seed = Effect.gen(function* () {
	yield* Db.execute(Db.sql`CREATE TABLE IF NOT EXISTS posts (id int4 PRIMARY KEY, org text NOT NULL, at timestamptz NOT NULL, title text NOT NULL, note text)`)
	for (let id = 1; id <= 10; id++) {
		const at = new Date(Date.UTC(2026, 0, 1, 0, Math.ceil(id / 2)))
		yield* Db.execute(Db.sql`INSERT INTO posts VALUES (${id}, ${"a"}, ${at.toISOString()}, ${`t${id}`}, NULL) ON CONFLICT DO NOTHING`)
	}
	yield* Db.execute(Db.sql`INSERT INTO posts VALUES (${11}, ${"b"}, ${"2026-01-01T00:03:00Z"}, ${"other"}, NULL) ON CONFLICT DO NOTHING`)
})

const byOrg = PG.from(Posts)
	.select("id", "at", "title")
	.where(($) => [$.org.eq(PG.param.string("org"))])

/** Every page, following `nextCursor` until there is none. */
const walk = <O extends Db.PaginateOptions<{ readonly id: number; readonly at: DateTime.Utc; readonly title: string }>>(
	options: Omit<O, "after">,
) =>
	Effect.gen(function* () {
		const pages: Array<ReadonlyArray<number>> = []
		let after: string | undefined
		for (;;) {
			const page = yield* Db.paginate(byOrg, { ...options, after } as O, { org: "a" })
			pages.push(page.rows.map((row) => row.id))
			if (Option.isNone(page.nextCursor)) return pages
			after = page.nextCursor.value
		}
	})

layer(Live, { excludeTestServices: true })("paginate on PGlite", (it) => {
	it.effect("pages walked by cursor cover every row once, newest first, ties broken by id", () =>
		Effect.gen(function* () {
			yield* seed
			const pages = yield* walk({ orderBy: [["at", "desc"], ["id", "desc"]], limit: 4 })
			expect(pages).toEqual([[10, 9, 8, 7], [6, 5, 4, 3], [2, 1]])
		}),
	)

	it.effect("a page is a seek: a row comparison, ORDER BY the key and LIMIT n + 1, with no OFFSET", () =>
		Effect.gen(function* () {
			yield* seed
			const first = yield* Db.paginate(byOrg, { orderBy: [["at", "desc"], ["id", "desc"]], limit: 4 }, { org: "a" })
			statements.length = 0
			yield* Db.paginate(byOrg, { orderBy: [["at", "desc"], ["id", "desc"]], limit: 4, after: Option.getOrThrow(first.nextCursor) }, { org: "a" })
			const sent = statements[0]!
			expect(sent).toContain(`("posts"."at", "posts"."id") < ($2, $3)`)
			expect(sent).toMatch(/ORDER BY "posts"\."at" DESC, "posts"\."id" DESC\s+LIMIT 5$/)
			expect(sent).not.toContain("OFFSET")
		}),
	)

	it.effect("mixed directions seek with the expanded OR form, bounded on the first key", () =>
		Effect.gen(function* () {
			yield* seed
			const pages = yield* walk({ orderBy: [["at", "asc"], ["id", "desc"]], limit: 3 })
			expect(pages).toEqual([[2, 1, 4], [3, 6, 5], [8, 7, 10], [9]])
			expect(statements.at(-1)).toContain(
				`"posts"."at" >= $2 AND ("posts"."at" > $2 OR ("posts"."at" = $2 AND "posts"."id" < $3))`,
			)
		}),
	)

	it.effect("one key compares on its own, and a page that ends the rows has no next cursor", () =>
		Effect.gen(function* () {
			yield* seed
			expect(yield* walk({ orderBy: [["id", "asc"]], limit: 5 })).toEqual([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]])
			expect(statements.at(-1)).toContain(`"posts"."id" > $2`)
		}),
	)

	it.effect("the query keeps its own where: the tenant filter and params still apply", () =>
		Effect.gen(function* () {
			yield* seed
			const page = yield* Db.paginate(byOrg, { orderBy: [["id", "asc"]], limit: 20 }, { org: "b" })
			expect(page.rows.map((row) => row.title)).toEqual(["other"])
			expect(page.nextCursor).toEqual(Option.none())
		}),
	)

	it.effect("a key value round-trips through its codec: a cursor on a timestamp seeks to the same instant", () =>
		Effect.gen(function* () {
			yield* seed
			const first = yield* Db.paginate(byOrg, { orderBy: [["at", "asc"], ["id", "asc"]], limit: 1 }, { org: "a" })
			expect(DateTime.formatIso(first.rows[0]!.at)).toBe("2026-01-01T00:01:00.000Z")
			const next = yield* Db.paginate(
				byOrg,
				{ orderBy: [["at", "asc"], ["id", "asc"]], limit: 1, after: Option.getOrThrow(first.nextCursor) },
				{ org: "a" },
			)
			expect(next.rows.map((row) => row.id)).toEqual([2])
		}),
	)

	it.effect("a cursor that is not one paginate wrote fails with InvalidCursor", () =>
		Effect.gen(function* () {
			yield* seed
			const orderBy = [["id", "asc"]] as const
			for (const after of ["not a cursor", "eyJrIjoiaWQgYXNjIiwidiI6WyJ4Il19", ""]) {
				const error = yield* Effect.flip(Db.paginate(byOrg, { orderBy, limit: 2, after }, { org: "a" }))
				expect(error).toBeInstanceOf(Db.InvalidCursor)
			}
		}),
	)

	it.effect("a cursor written for another sort key fails with InvalidCursor", () =>
		Effect.gen(function* () {
			yield* seed
			const first = yield* Db.paginate(byOrg, { orderBy: [["id", "asc"]], limit: 2 }, { org: "a" })
			const error = yield* Effect.flip(
				Db.paginate(byOrg, { orderBy: [["id", "desc"]], limit: 2, after: Option.getOrThrow(first.nextCursor) }, { org: "a" }),
			)
			expect(error._tag).toBe("@maple-dev/effect-orm/InvalidCursor")
		}),
	)

	it.effect("a limit that is not a positive integer is a QueryBuilderError", () =>
		Effect.gen(function* () {
			for (const limit of [0, -1, 2.5, Number.NaN]) {
				const error = yield* Effect.flip(Db.paginate(byOrg, { orderBy: [["id", "asc"]], limit }, { org: "a" }))
				expect(error).toBeInstanceOf(PG.QueryBuilderError)
			}
		}),
	)

	it.effect("a query paginate cannot seek is a defect: offset, groupBy, a key not selected", () =>
		Effect.gen(function* () {
			const defects: Array<Effect.Effect<unknown, unknown, Db.Database>> = [
				Db.paginate(byOrg.offset(10), { orderBy: [["id", "asc"]], limit: 2 }, { org: "a" }),
				Db.paginate(
					PG.from(Posts).select(($) => ({ org: $.org, n: PG.count() })).groupBy("org"),
					{ orderBy: [["org", "asc"]], limit: 2 },
				),
				// @ts-expect-error -- "org" is not selected
				Db.paginate(byOrg, { orderBy: [["org", "asc"]], limit: 2 }, { org: "a" }),
			]
			for (const effect of defects) {
				const exit = yield* Effect.exit(effect)
				expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
			}
		}),
	)
})
