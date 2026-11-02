// `makeRepository` against a real Effect SqlClient: `@effect/sql-pglite`
// (Postgres 17 in WASM). The ClickHouse half is in
// `tests/repository.clickhouse.test.ts`.

import { PgliteClient } from "@effect/sql-pglite"
import { expect, layer } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as PG from "../postgres"
import { postgresDialect } from "../pg/dialect"
import * as Db from "../database"
import { QueryBuilderDefect, QueryBuilderError } from "../ch/errors"

// `requireTenantScope` refuses any statement that is not pinned to one tenant,
// so every test here also checks that the repository pins each one.
const Live = Layer.effect(
	Db.Database,
	Effect.gen(function* () {
		return Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: postgresDialect, requireTenantScope: true })
	}),
).pipe(Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })))

const Tickets = PG.table("tickets", {
	columns: {
		id: PG.column(PG.int4, { identity: "always" }),
		org: PG.text,
		title: PG.text,
		seats: PG.column(PG.int4, { default: 1 }),
		note: PG.nullable(PG.text),
	},
	primaryKey: ["id"],
	tenantColumn: "org",
})

const createTickets = Db.execute(
	Db.sql`CREATE TABLE IF NOT EXISTS tickets (
		id int4 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
		org text NOT NULL,
		title text NOT NULL,
		seats int4 NOT NULL DEFAULT 1,
		note text
	)`,
)

const Tags = PG.table("tags", {
	columns: { name: PG.text, uses: PG.column(PG.int4, { default: 0 }) },
	primaryKey: ["name"],
})

const createTags = Db.execute(Db.sql`CREATE TABLE IF NOT EXISTS tags (name text PRIMARY KEY, uses int4 NOT NULL DEFAULT 0)`)

const tickets = Effect.andThen(createTickets, Db.makeRepository(Tickets, { idColumn: "id", tenantColumn: "org" }))

const defectOf = <A, E>(exit: Exit.Exit<A, E>) =>
	Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

layer(Live, { excludeTestServices: true })("makeRepository on PGlite", (it) => {
	it.effect("insert writes the row into the tenant and returns it with its defaults", () =>
		Effect.gen(function* () {
			yield* createTickets
			const repo = yield* Db.makeRepository(Tickets, { idColumn: "id", tenantColumn: "org" })
			const row = yield* repo.insert("acme", { title: "Board" })
			expect(row).toEqual({ id: row.id, org: "acme", title: "Board", seats: 1, note: null })
		}),
	)

	it.effect("findById reads only the given tenant's row", () =>
		Effect.gen(function* () {
			const repo = yield* tickets
			const row = yield* repo.insert("find-a", { title: "Mine", note: "n" })
			expect(yield* repo.findById("find-a", row.id)).toEqual(Option.some(row))
			expect(yield* repo.findById("find-b", row.id)).toEqual(Option.none())
			expect(yield* repo.findById("find-a", -1)).toEqual(Option.none())
		}),
	)

	it.effect("update changes the tenant's row and returns it; another tenant's row is None and stays as it was", () =>
		Effect.gen(function* () {
			const repo = yield* tickets
			const row = yield* repo.insert("upd-a", { title: "Old", note: "keep" })
			expect(yield* repo.update("upd-a", row.id, { title: "New", seats: 3 })).toEqual(
				Option.some({ ...row, title: "New", seats: 3 }),
			)
			expect(yield* repo.update("upd-b", row.id, { title: "Stolen" })).toEqual(Option.none())
			yield* repo.updateVoid("upd-b", row.id, { title: "Stolen" })
			yield* repo.updateVoid("upd-a", row.id, { note: null })
			expect(yield* repo.findById("upd-a", row.id)).toEqual(Option.some({ ...row, title: "New", seats: 3, note: null }))
		}),
	)

	it.effect("delete removes only the tenant's row", () =>
		Effect.gen(function* () {
			const repo = yield* tickets
			const row = yield* repo.insert("del-a", { title: "Gone" })
			yield* repo.delete("del-b", row.id)
			expect(Option.isSome(yield* repo.findById("del-a", row.id))).toBe(true)
			yield* repo.delete("del-a", row.id)
			expect(yield* repo.findById("del-a", row.id)).toEqual(Option.none())
		}),
	)

	it.effect("a patch with no keys is a QueryBuilderError, and the row stays as it was", () =>
		Effect.gen(function* () {
			const repo = yield* tickets
			const row = yield* repo.insert("empty-a", { title: "Same" })
			expect(yield* Effect.flip(repo.update("empty-a", row.id, {}))).toBeInstanceOf(QueryBuilderError)
			expect(yield* Effect.flip(repo.updateVoid("empty-a", row.id, { title: undefined }))).toBeInstanceOf(QueryBuilderError)
			expect(yield* repo.findById("empty-a", row.id)).toEqual(Option.some(row))
		}),
	)

	it.effect("the tenant argument wins over a tenant column smuggled into a row or a patch", () =>
		Effect.gen(function* () {
			const repo = yield* tickets
			const smuggled = { title: "T", org: "other" } as { title: string }
			yield* repo.insertVoid("own-a", smuggled)
			const row = yield* repo.insert("own-a", smuggled)
			expect(row.org).toBe("own-a")
			const moved = yield* repo.update("own-a", row.id, { title: "U", org: "other" } as { title: string })
			expect(Option.map(moved, (r) => r.org)).toEqual(Option.some("own-a"))
			expect(yield* repo.findById("other", row.id)).toEqual(Option.none())
		}),
	)

	it.effect("a table without a tenant column gets a repository without a tenant argument", () =>
		Effect.gen(function* () {
			yield* createTags
			const repo = yield* Db.makeRepository(Tags, { idColumn: "name" })
			expect(yield* repo.insert({ name: "urgent" })).toEqual({ name: "urgent", uses: 0 })
			expect(yield* repo.update("urgent", { uses: 2 })).toEqual(Option.some({ name: "urgent", uses: 2 }))
			yield* repo.delete("urgent")
			expect(yield* repo.findById("urgent")).toEqual(Option.none())
		}),
	)

	it.effect("a repository over a tenant table that is not pinned to its tenant column is a defect", () =>
		Effect.gen(function* () {
			// @ts-expect-error -- not a column of the table
			const wrong = yield* Effect.exit(Db.makeRepository(Tickets, { idColumn: "id", tenantColumn: "tenant" }))
			const missing = yield* Effect.exit(Db.makeRepository(Tickets, { idColumn: "id" }))
			const extra = yield* Effect.exit(Db.makeRepository(Tags, { idColumn: "name", tenantColumn: "uses" }))
			for (const exit of [wrong, missing, extra] as Array<Exit.Exit<unknown, never>>) expect(defectOf(exit)).toBeInstanceOf(QueryBuilderDefect)
			expect(String(defectOf(missing))).toMatch(/tenant column is "org"/)
		}),
	)
})
