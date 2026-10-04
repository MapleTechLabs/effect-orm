// `Database` against a real Effect SqlClient: `@effect/sql-pglite` (Postgres 17
// in WASM). Transactions here are Effect's own `withTransaction`, so these
// tests check the layer on top of it, not a fake. PGlite has one connection, so
// isolation between two transactions is out of reach here.

import { PgliteClient } from "@effect/sql-pglite"
import { assert, describe, expect, it, layer } from "@effect/vitest"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Ref, Schedule, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as CH from "../index"
import * as PG from "../postgres"
import { clickhouseDialect } from "../ch/dialect"
import { postgresDialect } from "../pg/dialect"
import * as Db from "../database"
import { renderTemplate } from "./sql"

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

let tables = 0
/** A fresh table per test: the client is shared across the file. */
const freshTable = Effect.gen(function* () {
	const name = `t_${++tables}`
	yield* Db.execute(Db.sql`CREATE TABLE ${Db.sql.identifier(name)} (id int4 PRIMARY KEY, note text)`)
	return name
})
const insert = (table: string, id: number, note = "") =>
	Db.execute(Db.sql`INSERT INTO ${Db.sql.identifier(table)} VALUES (${id}, ${note})`)
const ids = (table: string) =>
	Db.run(CH.from(CH.table(table, { id: PG.int4 })).select("id").orderBy(["id", "asc"])).pipe(
		Effect.map((rows) => rows.map((row) => row.id)),
	)
// DO blocks take no bound values, so the code is written in. Test-only.
const raiseSqlState = (code: "40001" | "40P01") =>
	Db.execute({ sql: `DO $$ BEGIN RAISE EXCEPTION 'forced' USING ERRCODE = '${code}'; END $$` })

class Domain extends Error {
	readonly _tag = "Domain"
}

layer(Live, { excludeTestServices: true })("Database on PGlite", (it) => {
	it.effect("run compiles a query for the database's dialect, inside and outside a transaction", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			yield* insert(table, 1)
			expect(yield* ids(table)).toEqual([1])
			expect(yield* Db.transaction(ids(table))).toEqual([1])
		}),
	)

	it.effect("run fills params, and a missing one is a QueryBuilderError", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			yield* Effect.all([insert(table, 1, "a"), insert(table, 2, "b")])
			const Items = CH.table(table, { id: PG.int4, note: PG.text })
			const byNote = CH.from(Items)
				.select("id")
				.where(($) => [$.note.eq(CH.param.string("note"))])
			expect(yield* Db.run(byNote, { note: "b" })).toEqual([{ id: 2 }])
			// @ts-expect-error -- a missing param is a type error too
			const error = yield* Effect.flip(Db.run(byNote))
			expect(error).toBeInstanceOf(CH.QueryBuilderError)
		}),
	)

	it.effect("sql binds every value: nothing in a value becomes SQL", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			const hostile = "x'); DROP TABLE t_1; --"
			yield* insert(table, 1, hostile)
			const where = Db.sql`note = ${hostile}`
			const rows = yield* Db.query(Db.sql`SELECT id, note FROM ${Db.sql.identifier(table)} WHERE ${where}`)
			expect(rows).toEqual([{ id: 1, note: hostile }])
		}),
	)

	it.effect("sql.identifier accepts only plain names", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(Db.execute(Db.sql`SELECT * FROM ${Db.sql.identifier("t; DROP TABLE x")}`))
			expect(error.reason).toBe("InvalidLiteral")
		}),
	)

	it.effect("query decodes rows through a schema", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			yield* insert(table, 1, "a")
			const Row = Schema.Struct({ id: Schema.Number, note: Schema.String })
			const rows = yield* Db.query(Db.sql`UPDATE ${Db.sql.identifier(table)} SET note = 'b' RETURNING id, note`, Row)
			expect(rows).toEqual([{ id: 1, note: "b" }])
			const error = yield* Effect.flip(Db.query(Db.sql`SELECT 'x' AS id`, Row))
			expect(error).toBeInstanceOf(CH.CompiledQueryDecodeError)
		}),
	)

	it.effect("refuses a query compiled for another dialect", () =>
		Effect.gen(function* () {
			// The root compile is ClickHouse's.
			const compiled = yield* CH.compile(CH.from(CH.table("x", { id: PG.int4 })).select("id"), {})
			const exit = yield* Effect.exit(Db.run(compiled))
			assert(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
			const defect = Cause.squash(exit.cause)
			assert(defect instanceof Db.DatabaseError)
			expect(defect.reason).toBe("DialectMismatch")
		}),
	)

	it.effect("commits on success", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			yield* Db.transaction(Effect.all([insert(table, 1), insert(table, 2)]))
			expect(yield* ids(table)).toEqual([1, 2])
		}),
	)

	it.effect("rolls back a typed failure and passes it through unchanged", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			const domain = new Domain("claim lost")
			const error = yield* Effect.flip(Db.transaction(insert(table, 1).pipe(Effect.andThen(Effect.fail(domain)))))
			expect(error).toBe(domain)
			expect(yield* ids(table)).toEqual([])
		}),
	)

	it.effect("rolls back a defect and keeps it a defect", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			const bug = new Error("bug")
			const exit = yield* Effect.exit(Db.transaction(insert(table, 1).pipe(Effect.andThen(Effect.die(bug)))))
			assert(Exit.isFailure(exit))
			expect(Cause.squash(exit.cause)).toBe(bug)
			expect(yield* ids(table)).toEqual([])
		}),
	)

	it.effect("a SqlError defect from the body stays the body's, not a rollback failure", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			const table = yield* freshTable
			const exit = yield* Effect.exit(
				Db.transaction(insert(table, 1).pipe(Effect.andThen(Effect.orDie(sql.unsafe("SELECT * FROM missing_table"))))),
			)
			assert(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
			expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SqlError" })
			expect(yield* ids(table)).toEqual([])
		}),
	)

	it.effect("rolls back on interruption and frees the connection", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			const inserted = yield* Deferred.make<void>()
			const fiber = yield* Db.transaction(
				insert(table, 1).pipe(Effect.andThen(Deferred.succeed(inserted, undefined)), Effect.andThen(Effect.never)),
			).pipe(Effect.forkChild)
			yield* Deferred.await(inserted)
			yield* Fiber.interrupt(fiber)
			expect(yield* ids(table)).toEqual([])
			yield* Db.transaction(insert(table, 2))
			expect(yield* ids(table)).toEqual([2])
		}),
	)

	it.effect("nests as savepoints: a caught inner failure keeps the outer writes", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			const depths = yield* Db.transaction(
				Effect.gen(function* () {
					const outer = yield* Db.Transaction
					yield* insert(table, 1)
					yield* Db.transaction(insert(table, 2).pipe(Effect.andThen(Effect.fail(new Domain("inner"))))).pipe(
						Effect.catchIf(
							(error) => error instanceof Domain,
							() => Effect.void,
						),
					)
					const middle = yield* Db.transaction(
						Effect.gen(function* () {
							yield* insert(table, 3)
							return yield* Db.transaction(Effect.map(Effect.service(Db.Transaction), (info) => info.depth))
						}),
					)
					return [outer.depth, middle]
				}),
			)
			expect(depths).toEqual([0, 2])
			expect(yield* ids(table)).toEqual([1, 3])
		}),
	)

	it.effect("refuses settings or retry on a nested transaction", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			const inner = yield* Db.transaction(
				insert(table, 1).pipe(
					Effect.andThen(Effect.flip(Db.transaction(insert(table, 2), { isolationLevel: "serializable" }))),
				),
			)
			expect(inner).toBeInstanceOf(Db.TransactionOptionsRejected)
			const retried = yield* Db.transaction(Effect.flip(Db.transaction(insert(table, 3), { retry: "contention" })))
			expect(retried).toBeInstanceOf(Db.TransactionOptionsRejected)
			expect(yield* ids(table)).toEqual([1])
		}),
	)

	it.effect("applies settings as the first statement of the transaction", () =>
		Effect.gen(function* () {
			statements.length = 0
			const settings = yield* Db.transaction(
				Effect.gen(function* () {
					const info = yield* Db.Transaction
					const rows = yield* Db.query(
						Db.sql`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only`,
					)
					return { info, row: rows[0] }
				}),
				{ isolationLevel: "serializable", accessMode: "read only", deferrable: true },
			)
			expect(statements[0]).toBe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ ONLY, DEFERRABLE")
			expect(settings.row).toEqual({ isolation: "serializable", read_only: "on" })
			expect(settings.info).toEqual({ depth: 0, isolationLevel: "serializable", accessMode: "read only" })
		}),
	)

	it.effect("a write under read only fails as DatabaseError with its SQLSTATE", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			const error = yield* Effect.flip(Db.transaction(insert(table, 1), { accessMode: "read only" }))
			assert(error instanceof Db.DatabaseError)
			expect(error.sqlState).toBe("25006")
		}),
	)

	it.effect("a failed COMMIT is TransactionCommitFailed, not a defect", () =>
		Effect.gen(function* () {
			const parent = yield* freshTable
			const child = Db.sql.identifier(`${parent}_child`)
			yield* Db.execute(
				Db.sql`CREATE TABLE ${child} (id int4, parent int4 REFERENCES ${Db.sql.identifier(parent)}(id) DEFERRABLE INITIALLY DEFERRED)`,
			)
			const error = yield* Effect.flip(Db.transaction(Db.execute(Db.sql`INSERT INTO ${child} VALUES (1, 999)`)))
			assert(error instanceof Db.TransactionCommitFailed)
			expect(error.sqlState).toBe("23503")
			expect(error.message).toMatch(/^COMMIT failed/)
			expect(yield* Db.query(Db.sql`SELECT * FROM ${child}`)).toEqual([])
		}),
	)

	it.effect("retry: contention re-runs the whole transaction", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			const attempts = yield* Ref.make(0)
			yield* Db.transaction(
				Effect.gen(function* () {
					const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
					yield* insert(table, attempt)
					if (attempt < 3) yield* raiseSqlState("40001")
				}),
				{ retry: { times: 3, schedule: Schedule.spaced("1 millis") } },
			)
			expect(yield* Ref.get(attempts)).toBe(3)
			expect(yield* ids(table)).toEqual([3])
		}),
	)

	it.effect("retry gives up after its attempts and never retries a domain error", () =>
		Effect.gen(function* () {
			const attempts = yield* Ref.make(0)
			const error = yield* Effect.flip(
				Db.transaction(Ref.update(attempts, (n) => n + 1).pipe(Effect.andThen(raiseSqlState("40P01"))), {
					retry: { times: 2 },
				}),
			)
			assert(error instanceof Db.DatabaseError)
			expect(Db.isContention(error)).toBe(true)
			expect(yield* Ref.get(attempts)).toBe(3)

			yield* Ref.set(attempts, 0)
			yield* Effect.flip(
				Db.transaction(Ref.update(attempts, (n) => n + 1).pipe(Effect.andThen(Effect.fail(new Domain("no")))), {
					retry: "contention",
				}),
			)
			expect(yield* Ref.get(attempts)).toBe(1)
		}),
	)

	it.effect("retryContention refuses inside an open transaction", () =>
		Effect.gen(function* () {
			const error = yield* Db.transaction(Effect.flip(Db.retryContention(Effect.void)))
			expect(error).toBeInstanceOf(Db.TransactionOptionsRejected)
		}),
	)

	it.effect("a statement from a fiber that outlives its transaction is a TransactionClosed defect", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			const release = yield* Deferred.make<void>()
			const straggler = yield* Db.transaction(
				Deferred.await(release).pipe(Effect.andThen(insert(table, 1)), Effect.forkDetach),
			)
			yield* Deferred.succeed(release, undefined)
			const exit = yield* Fiber.await(straggler)
			assert(Exit.isFailure(exit))
			expect(Cause.squash(exit.cause)).toBeInstanceOf(Db.TransactionClosed)
			expect(yield* ids(table)).toEqual([])
		}),
	)

	it.effect("shares one connection and one nesting counter with sql.withTransaction", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			const table = yield* freshTable
			yield* Db.transaction(
				Effect.gen(function* () {
					yield* insert(table, 1)
					yield* sql.withTransaction(sql.unsafe(`INSERT INTO ${table} VALUES (2, '')`).pipe(Effect.andThen(Effect.fail("raw")))).pipe(
						Effect.ignore,
					)
				}),
			)
			expect(yield* ids(table)).toEqual([1])
			const depth = yield* sql.withTransaction(Db.transaction(Effect.map(Effect.service(Db.Transaction), (info) => info.depth)))
			expect(depth).toBe(1)
		}),
	)

	it.effect("a dialect without transactions fails before sending anything", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			const sent: Array<string> = []
			const clickhouse = Db.fromSqlClient(sql, {
				dialect: clickhouseDialect,
				observe: (statement) => Effect.sync(() => void sent.push(statement.sql)),
			})
			const error = yield* Effect.flip(clickhouse.transaction(clickhouse.execute(Db.sql`SELECT 1`)))
			assert(error instanceof Db.TransactionUnsupported)
			expect(error.dialect).toBe("clickhouse")
			expect(sent).toEqual([])
		}),
	)

	it.effect("requireTransaction and transaction as Effect.fn pipe arguments", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			const write = Effect.fn("write")(function* (id: number) {
				yield* insert(table, id)
				if (id === 2) return yield* Effect.fail(new Domain("two"))
				return id
			}, Db.requireTransaction)
			const op = Effect.fn("op")(function* (id: number) {
				return yield* write(id)
			}, Db.transaction())
			expect(yield* op(1)).toBe(1)
			yield* Effect.flip(op(2))
			expect(yield* ids(table)).toEqual([1])
		}),
	)

	it.effect("run inserts rows built with insertInto, bound and decoded back through the column codecs", () =>
		Effect.gen(function* () {
			yield* Db.execute(
				Db.sql`CREATE TABLE keys (
					id uuid PRIMARY KEY,
					org_id text NOT NULL,
					uses int8 NOT NULL DEFAULT 0,
					created_at timestamptz NOT NULL DEFAULT now(),
					revoked boolean NOT NULL DEFAULT false,
					meta jsonb,
					tags text[] NOT NULL,
					note text
				)`,
			)
			const Keys = CH.table(
				"keys",
				{
					id: PG.uuid,
					org_id: PG.text,
					uses: PG.int8,
					created_at: PG.timestamptz,
					revoked: PG.bool,
					meta: PG.nullable(PG.jsonb()),
					tags: PG.array(PG.text),
					note: PG.nullable(PG.text),
				},
				{ tenantColumn: "org_id", defaults: ["uses", "created_at", "revoked"] },
			)
			const at = DateTime.makeUnsafe("2026-01-02T03:04:05.678Z")
			const id = (n: number) => `00000000-0000-0000-0000-00000000000${n}`
			const inserted = yield* Db.run(
				CH.insertInto(Keys).values([
					{ id: id(1), org_id: CH.param.string("org"), tags: ["a", "it's"], meta: { k: [1, 2] }, created_at: at },
					{ id: id(2), org_id: CH.param.string("org"), tags: [], uses: 7, revoked: true, note: "n" },
				]),
				{ org: "o1" },
			)
			expect(inserted).toEqual([])
			const returned = yield* Db.run(
				CH.insertInto(Keys)
					.values({ id: id(3), org_id: "o1", tags: ["z"] })
					.returning(($) => ({ id: $.id, uses: $.uses, createdAt: $.created_at, revoked: $.revoked, tags: $.tags })),
			)
			expect(returned).toHaveLength(1)
			expect(returned[0]).toMatchObject({ id: id(3), uses: 0, revoked: false, tags: ["z"] })
			expect(DateTime.isDateTime(returned[0]!.createdAt)).toBe(true)
			const rows = yield* Db.run(CH.from(Keys).where(($) => [$.id.neq(id(3))]).select("id", "uses", "created_at", "revoked", "meta", "tags", "note").orderBy(["id", "asc"]))
			expect(rows[0]).toEqual({ id: id(1), uses: 0, created_at: at, revoked: false, meta: { k: [1, 2] }, tags: ["a", "it's"], note: null })
			expect(rows[1]).toMatchObject({ id: id(2), uses: 7, revoked: true, meta: null, tags: [], note: "n" })
		}),
	)

	it.effect("upserts with onConflictDoUpdate and skips with onConflictDoNothing", () =>
		Effect.gen(function* () {
			yield* Db.execute(
				Db.sql`CREATE TABLE counters (key text PRIMARY KEY, count int8 NOT NULL, locked boolean NOT NULL DEFAULT false)`,
			)
			const Counters = CH.table("counters", { key: PG.text, count: PG.int8, locked: PG.bool }, { defaults: ["locked"] })
			const bump = (key: string, by: number) =>
				Db.run(
					CH.insertInto(Counters)
						.values({ key, count: by })
						.onConflictDoUpdate({
							target: ["key"],
							set: ($, excluded) => ({ count: $.count.add(excluded.count) }),
							where: ($) => $.locked.eq(false),
						})
						.returning("key", "count"),
				)
			expect(yield* bump("a", 1)).toEqual([{ key: "a", count: 1 }])
			expect(yield* bump("a", 2)).toEqual([{ key: "a", count: 3 }])
			yield* Db.execute(Db.sql`UPDATE counters SET locked = true WHERE key = 'a'`)
			// The WHERE skips a locked row: nothing is updated, so nothing returns.
			expect(yield* bump("a", 5)).toEqual([])
			const skipped = yield* Db.run(
				CH.insertInto(Counters)
					.values([{ key: "a", count: 100 }, { key: "b", count: 1 }])
					.onConflictDoNothing({ target: ["key"] })
					.returning("key"),
			)
			expect(skipped).toEqual([{ key: "b" }])
			expect(yield* Db.run(CH.from(Counters).select("key", "count").orderBy(["key", "asc"]))).toEqual([
				{ key: "a", count: 3 },
				{ key: "b", count: 1 },
			])
		}),
	)

	it.effect("insert ... select copies rows, with ON CONFLICT and RETURNING", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`CREATE TABLE src (org text NOT NULL, n int4 NOT NULL)`)
			yield* Db.execute(Db.sql`CREATE TABLE dst (org text PRIMARY KEY, total int8 NOT NULL)`)
			yield* Db.execute(Db.sql`INSERT INTO src VALUES ('a', 1), ('a', 2), ('b', 5)`)
			const Src = CH.table("src", { org: PG.text, n: PG.int4 })
			const Dst = CH.table("dst", { org: PG.text, total: PG.int8 })
			const rollup = CH.insertInto(Dst)
				.select(CH.from(Src).select(($) => ({ org: $.org, total: CH.coalesce(PG.sum($.n), CH.lit(0)) })).groupBy("org"))
				.onConflictDoUpdate({ target: ["org"], set: ($, excluded) => ({ total: $.total.add(excluded.total) }) })
				.returning("org", "total")
			expect(yield* Db.run(rollup)).toHaveLength(2)
			const again = yield* Db.run(rollup)
			expect([...again].sort((x, y) => x.org.localeCompare(y.org))).toEqual([
				{ org: "a", total: 6 },
				{ org: "b", total: 10 },
			])
		}),
	)

	it.effect("jsonb and array values bind in an upsert's SET as in VALUES", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`CREATE TABLE docs (id int4 PRIMARY KEY, meta jsonb NOT NULL, tags text[] NOT NULL)`)
			const Docs = CH.table("docs", { id: PG.int4, meta: PG.jsonb(), tags: PG.array(PG.text) })
			const upsert = (meta: unknown, tags: ReadonlyArray<string>) =>
				Db.run(
					CH.insertInto(Docs)
						.values({ id: 1, meta, tags })
						.onConflictDoUpdate({ target: ["id"], set: { meta, tags } })
						.returning("meta", "tags"),
				)
			expect(yield* upsert({ a: [1, "x"] }, ["p"])).toEqual([{ meta: { a: [1, "x"] }, tags: ["p"] }])
			expect(yield* upsert({ b: { c: null } }, ["q", "it's"])).toEqual([{ meta: { b: { c: null } }, tags: ["q", "it's"] }])
		}),
	)

	it.effect("update and deleteFrom change rows and return them", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`CREATE TABLE tickets (id int4 PRIMARY KEY, org text NOT NULL, seats int4 NOT NULL, tags text[] NOT NULL)`)
			const Tickets = CH.table("tickets", { id: PG.int4, org: PG.text, seats: PG.int4, tags: PG.array(PG.text) }, { tenantColumn: "org" })
			yield* Db.run(
				CH.insertInto(Tickets).values([
					{ id: 1, org: "a", seats: 1, tags: [] },
					{ id: 2, org: "a", seats: 5, tags: [] },
					{ id: 3, org: "b", seats: 9, tags: [] },
				]),
			)
			const bumped = yield* Db.run(
				CH.update(Tickets)
					.set(($) => ({ seats: $.seats.add(1), tags: ["x", "it's"] }))
					.where(($) => [$.org.eq(CH.param.string("org")), $.seats.lt(5)])
					.returning("id", "seats", "tags"),
				{ org: "a" },
			)
			expect(bumped).toEqual([{ id: 1, seats: 2, tags: ["x", "it's"] }])
			// Without RETURNING, a write runs through `execute` and returns nothing.
			expect(yield* Db.run(CH.update(Tickets).set({ seats: 0 }).where(($) => [$.id.eq(2)]))).toEqual([])
			const removed = yield* Db.run(CH.deleteFrom(Tickets).where(($) => [$.org.eq("a")]).returning("id"))
			expect([...removed].map((r) => r.id).sort()).toEqual([1, 2])
			expect(yield* Db.run(CH.from(Tickets).select("id", "seats"))).toEqual([{ id: 3, seats: 9 }])
			yield* Db.run(CH.deleteFrom(Tickets).allRows())
			expect(yield* Db.run(CH.from(Tickets).select("id"))).toEqual([])
		}),
	)

	it.effect("claims a job with FOR UPDATE SKIP LOCKED, and reads with DISTINCT ON, IS NULL and BETWEEN", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`CREATE TABLE jobs (id int4 PRIMARY KEY, org text NOT NULL, state text NOT NULL, done_at timestamptz)`)
			const Jobs = CH.table("jobs", { id: PG.int4, org: PG.text, state: PG.text, done_at: PG.nullable(PG.timestamptz) })
			yield* Db.run(
				CH.insertInto(Jobs).values([
					{ id: 1, org: "a", state: "queued" },
					{ id: 2, org: "a", state: "queued" },
					{ id: 3, org: "b", state: "queued" },
				]),
			)
			const claim = Db.transaction(
				Effect.gen(function* () {
					const [job] = yield* Db.run(
						CH.from(Jobs)
							.select("id")
							.where(($) => [$.state.eq("queued"), $.done_at.isNull()])
							.orderBy(["id", "asc"])
							.limit(1)
							.forUpdate({ skipLocked: true }),
					)
					if (job === undefined) return undefined
					yield* Db.run(CH.update(Jobs).set({ state: "running" }).where(($) => [$.id.eq(job.id)]))
					return job.id
				}),
			)
			expect(yield* claim).toBe(1)
			expect(yield* claim).toBe(2)
			const firstPerOrg = yield* Db.run(
				CH.from(Jobs)
					.select(($) => ({ org: $.org, id: $.id }))
					.distinctOn("org")
					.orderBy(["org", "asc"], ["id", "desc"]),
			)
			expect(firstPerOrg).toEqual([
				{ org: "a", id: 2 },
				{ org: "b", id: 3 },
			])
			const inRange = yield* Db.run(
				CH.from(Jobs).select("id").where(($) => [$.id.between(2, CH.param.int("hi")), CH.or($.org.eq("b"), $.state.eq("running"))]).orderBy(["id", "asc"]),
				{ hi: 3 },
			)
			expect(inRange).toEqual([{ id: 2 }, { id: 3 }])
			expect(yield* Db.run(CH.from(Jobs).select("state").distinct().orderBy(["state", "asc"]))).toEqual([
				{ state: "queued" },
				{ state: "running" },
			])
		}),
	)

	it.effect("CH.sql filters jsonb with @> and a bound param, and reads a typed cast", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`CREATE TABLE docs2 (id int4 PRIMARY KEY, meta jsonb NOT NULL)`)
			const Docs = CH.table("docs2", { id: PG.int4, meta: PG.jsonb() })
			yield* Db.run(CH.insertInto(Docs).values([{ id: 1, meta: { tier: "gold", n: 1 } }, { id: 2, meta: { tier: "free" } }]))
			const rows = yield* Db.run(
				CH.from(Docs)
					.select(($) => ({ id: $.id, tier: CH.sql(PG.text)`${$.meta}->>'tier'`, xid: CH.sql(PG.text)`pg_current_xact_id()::xid::text` }))
					.where(($) => [CH.sql.cond`${$.meta} @> ${CH.param.string("filter")}::jsonb`]),
				{ filter: JSON.stringify({ tier: "gold" }) },
			)
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({ id: 1, tier: "gold" })
			expect(typeof rows[0]!.xid).toBe("string")
		}),
	)

	it.effect("an insert inside a failed transaction rolls back", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			const T = CH.table(table, { id: PG.int4, note: PG.nullable(PG.text) })
			const exit = yield* Effect.exit(
				Db.transaction(
					Effect.andThen(Db.run(CH.insertInto(T).values({ id: 1 })), Effect.fail(new Domain())),
				),
			)
			expect(Exit.isFailure(exit)).toBe(true)
			yield* Db.run(CH.insertInto(T).values([{ id: 2 }, { id: 3, note: "x" }]))
			expect(yield* ids(table)).toEqual([2, 3])
		}),
	)
})

describe("sql templates per dialect", () => {
	const name = "it's"
	const template = Db.sql`SELECT * FROM ${Db.sql.identifier("app.events")} WHERE name = ${name} AND n IN (${1}, ${2})`

	it.effect("Postgres binds $n", () =>
		Effect.gen(function* () {
			expect(yield* renderTemplate(template, postgresDialect)).toEqual({
				sql: `SELECT * FROM "app"."events" WHERE name = $1 AND n IN ($2, $3)`,
				parameters: ["it's", 1, 2],
			})
		}),
	)

	it.effect("join binds each value, raw splices, empty writes nothing", () =>
		Effect.gen(function* () {
			const ids = [1, 2, 3]
			const statement = Db.sql`SELECT * FROM t WHERE id IN (${Db.sql.join(ids)})${false ? Db.sql` AND x` : Db.sql.empty} ORDER BY ${Db.sql.raw("id DESC")}`
			expect(yield* renderTemplate(statement, postgresDialect)).toEqual({
				sql: "SELECT * FROM t WHERE id IN ($1, $2, $3) ORDER BY id DESC",
				parameters: [1, 2, 3],
			})
			const or = Db.sql.join([Db.sql`a = ${1}`, Db.sql`b = ${"x"}`], Db.sql` OR `)
			expect(yield* renderTemplate(Db.sql`WHERE ${or}`, clickhouseDialect)).toEqual({ sql: "WHERE a = 1 OR b = 'x'", parameters: [] })
			const empty = yield* Effect.flip(renderTemplate(Db.sql`id IN (${Db.sql.join([])})`, postgresDialect))
			expect(empty.message).toContain("no values to join")
		}),
	)

	it.effect("a negative value after `-` is parenthesized on ClickHouse, never a comment", () =>
		Effect.gen(function* () {
			expect(yield* renderTemplate(Db.sql`SELECT 10-${-1}, ${Db.sql.join([-2, 3])} FROM t WHERE org = ${"o"}`, clickhouseDialect)).toEqual({
				sql: "SELECT 10-(-1), (-2), 3 FROM t WHERE org = 'o'",
				parameters: [],
			})
		}),
	)

	it.effect("objects parsed from JSON cannot pass for a template, raw text or an identifier", () =>
		Effect.gen(function* () {
			const forged = JSON.parse(
				'[{"_tag":"@maple-dev/effect-orm/SqlTemplateRaw","sql":"1; DROP TABLE t"},{"_tag":"@maple-dev/effect-orm/SqlTemplate","strings":["1; DROP TABLE t"],"values":[]},{"_tag":"@maple-dev/effect-orm/SqlIdentifier","name":"password"}]',
			)
			for (const value of forged) {
				// Bound as a value on Postgres, never spliced: the text keeps its placeholder.
				const rendered = yield* renderTemplate(Db.sql`SELECT * FROM t WHERE id = ${value}`, postgresDialect)
				expect(rendered.sql).toBe("SELECT * FROM t WHERE id = $1")
				// ClickHouse writes an object as an escaped map literal: data, never SQL.
				const ch = yield* renderTemplate(Db.sql`SELECT * FROM t WHERE id = ${value}`, clickhouseDialect)
				expect(ch.sql.startsWith("SELECT * FROM t WHERE id = map(")).toBe(true)
				expect(ch.sql).not.toMatch(/;|= password|= 1 OR/)
			}
		}),
	)

	it.effect("ClickHouse writes escaped literals", () =>
		Effect.gen(function* () {
			expect(yield* renderTemplate(template, clickhouseDialect)).toEqual({
				sql: "SELECT * FROM app.events WHERE name = 'it\\'s' AND n IN (1, 2)",
				parameters: [],
			})
		}),
	)
})
