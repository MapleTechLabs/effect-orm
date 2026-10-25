// `afterCommit` against a real Effect SqlClient (`@effect/sql-pglite`): work
// that must wait for COMMIT, such as a vendor call, and must never run after a
// rollback.

import { PgliteClient } from "@effect/sql-pglite"
import { assert, expect, layer } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, ErrorReporter, Exit, Fiber, Layer, Logger, Ref, Schedule } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as CH from "../ch/index"
import * as PG from "../postgres"
import { postgresDialect } from "../pg/dialect"
import * as Db from "../database"

const Live = Layer.effect(
	Db.Database,
	Effect.gen(function* () {
		return Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: postgresDialect })
	}),
).pipe(Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })))

let tables = 0
const freshTable = Effect.gen(function* () {
	const name = `after_commit_${++tables}`
	yield* Db.execute(Db.sql`CREATE TABLE ${Db.sql.identifier(name)} (id int4 PRIMARY KEY)`)
	return name
})
const insert = (table: string, id: number) => Db.execute(Db.sql`INSERT INTO ${Db.sql.identifier(table)} VALUES (${id})`)
const ids = (table: string) =>
	Db.run(CH.from(CH.table(table, { id: PG.int4 })).select("id").orderBy(["id", "asc"])).pipe(
		Effect.map((rows) => rows.map((row) => row.id)),
	)

class Domain extends Error {
	readonly _tag = "Domain"
}

class Sms extends Context.Service<Sms, { readonly sent: Array<string> }>()("test/Sms") {}

const dies = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.map(Effect.exit(effect), (exit) => {
		assert(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
		return Cause.squash(exit.cause)
	})

layer(Live, { excludeTestServices: true })("afterCommit on PGlite", (it) => {
	it.effect("runs after COMMIT, outside the transaction, and never after a rollback", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			const seen = yield* Ref.make<ReadonlyArray<unknown>>([])
			const record = (label: string) =>
				Effect.gen(function* () {
					const open = yield* Effect.serviceOption(Db.Transaction)
					const rows = yield* ids(table)
					yield* Ref.update(seen, (all) => [...all, { label, ids: rows, open: open._tag === "Some" }])
				})

			const value = yield* Db.transaction(
				Effect.gen(function* () {
					yield* insert(table, 1)
					yield* Db.afterCommit(record("sms"))
					expect(yield* Ref.get(seen)).toEqual([])
					return "done"
				}),
			)
			expect(value).toBe("done")
			expect(yield* Ref.get(seen)).toEqual([{ label: "sms", ids: [1], open: false }])

			const error = yield* Effect.flip(
				Db.transaction(
					insert(table, 2).pipe(
						Effect.andThen(Db.afterCommit(record("rolled back"))),
						Effect.andThen(Effect.fail(new Domain("no"))),
					),
				),
			)
			assert(error instanceof Domain)
			expect(yield* Ref.get(seen)).toHaveLength(1)
		}),
	)

	it.effect("runs in queue order; a rolled-back savepoint drops its hooks, a kept one hands them up", () =>
		Effect.gen(function* () {
			const ran = yield* Ref.make<ReadonlyArray<string>>([])
			const queue = (label: string) => Db.afterCommit(Ref.update(ran, (all) => [...all, label]))
			yield* Db.transaction(
				Effect.gen(function* () {
					yield* queue("outer 1")
					yield* Db.transaction(queue("kept savepoint"))
					yield* Db.transaction(queue("dropped savepoint").pipe(Effect.andThen(Effect.fail(new Domain("inner"))))).pipe(
						Effect.ignore,
					)
					yield* Db.transaction(Db.transaction(queue("two deep")))
					yield* queue("outer 2")
					expect(yield* Ref.get(ran)).toEqual([])
				}),
			)
			expect(yield* Ref.get(ran)).toEqual(["outer 1", "kept savepoint", "two deep", "outer 2"])

			// A kept savepoint inside an outer transaction that rolls back runs nothing.
			yield* Ref.set(ran, [])
			yield* Db.transaction(Db.transaction(queue("inner")).pipe(Effect.andThen(Effect.fail(new Domain("outer"))))).pipe(
				Effect.ignore,
			)
			expect(yield* Ref.get(ran)).toEqual([])
		}),
	)

	it.effect("a failing hook does not fail the committed transaction: it is reported and logged, and the next hook runs", () =>
		Effect.gen(function* () {
			const table = yield* freshTable
			const reported: Array<unknown> = []
			const logged: Array<{ level: string; message: unknown; failure: unknown }> = []
			const reporter = ErrorReporter.make(({ cause }) => void reported.push(Cause.squash(cause)))
			const logger = Logger.make(({ logLevel, message, cause }) => {
				logged.push({ level: logLevel, message, failure: Cause.squash(cause) })
			})
			const ran = yield* Ref.make(0)
			const vendorDown = new Domain("vendor down")
			const bug = new Error("bug in a hook")

			const value = yield* Db.transaction(
				Effect.gen(function* () {
					yield* insert(table, 1)
					yield* Db.afterCommit(Effect.fail(vendorDown))
					yield* Db.afterCommit(Effect.die(bug))
					yield* Db.afterCommit(Ref.update(ran, (n) => n + 1))
					return "committed"
				}),
			).pipe(Effect.provide(Layer.merge(ErrorReporter.layer([reporter]), Logger.layer([logger]))))

			expect(value).toBe("committed")
			expect(yield* ids(table)).toEqual([1])
			expect(yield* Ref.get(ran)).toBe(1)
			expect(reported).toEqual([vendorDown, bug])
			expect(logged.map((entry) => [entry.level, entry.failure])).toEqual([
				["Error", vendorDown],
				["Error", bug],
			])
		}),
	)

	it.effect("a hook sees the services of the place it was queued, and its R stays required", () =>
		Effect.gen(function* () {
			const sent: Array<string> = []
			const sendSms = (text: string) => Effect.flatMap(Effect.service(Sms), (sms) => Effect.sync(() => void sms.sent.push(text)))
			yield* Db.transaction(Db.afterCommit(sendSms("tour booked")).pipe(Effect.provideService(Sms, { sent })))
			expect(sent).toEqual(["tour booked"])
		}),
	)

	it.effect("a retried attempt drops its hooks; only the attempt that commits runs them", () =>
		Effect.gen(function* () {
			const ran = yield* Ref.make<ReadonlyArray<number>>([])
			const attempts = yield* Ref.make(0)
			yield* Db.transaction(
				Effect.gen(function* () {
					const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
					yield* Db.afterCommit(Ref.update(ran, (all) => [...all, attempt]))
					if (attempt < 3) yield* Db.execute({ sql: "DO $$ BEGIN RAISE EXCEPTION 'forced' USING ERRCODE = '40001'; END $$" })
				}),
				{ retry: { times: 3, schedule: Schedule.spaced("1 millis") } },
			)
			expect(yield* Ref.get(ran)).toEqual([3])
		}),
	)

	it.effect("runs under a plain sql.withTransaction too; dies where nothing will run it", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			const ran = yield* Ref.make(0)
			const work = Ref.update(ran, (n) => n + 1)

			// Effect's own transaction queues it: it runs once the outer COMMIT succeeds.
			yield* sql.withTransaction(
				Db.transaction(Db.afterCommit(work)).pipe(Effect.andThen(Effect.flatMap(Ref.get(ran), (n) => Effect.sync(() => expect(n).toBe(0))))),
			)
			expect(yield* Ref.get(ran)).toBe(1)

			// Transaction provided by hand, with no transaction behind it.
			yield* dies(Db.afterCommit(work).pipe(Effect.provideService(Db.Transaction, { depth: 0, isolationLevel: undefined, accessMode: undefined })))

			// A fiber forked in the transaction that queues work after it ended.
			const release = yield* Deferred.make<void>()
			const straggler = yield* Db.transaction(Deferred.await(release).pipe(Effect.andThen(Db.afterCommit(work)), Effect.forkDetach))
			yield* Deferred.succeed(release, undefined)
			yield* dies(Fiber.join(straggler))
			expect(yield* Ref.get(ran)).toBe(1)
		}),
	)
})
