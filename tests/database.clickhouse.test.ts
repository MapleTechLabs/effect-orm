// `Database` on a live ClickHouse: queries and statements run, transactions are
// refused before anything is sent. Creates one table in a throwaway database.

import { ClickhouseClient } from "@effect/sql-clickhouse"
import { DateTime, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as Db from "@maple-dev/effect-orm/database"
import { endpoint } from "./clickhouse-support"

const user = process.env.EFFECT_ORM_CLICKHOUSE_USER ?? "default"
const password = process.env.EFFECT_ORM_CLICKHOUSE_PASSWORD ?? ""

const withDatabase = <A, E>(body: (db: Db.DatabaseApi, sent: Array<string>, client: ClickhouseClient.ClickhouseClient) => Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const database = `eo_database_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
		const admin = yield* ClickhouseClient.ClickhouseClient
		yield* admin.asCommand(admin.unsafe(`CREATE DATABASE ${database}`))
		return yield* Effect.gen(function* () {
			const client = yield* ClickhouseClient.ClickhouseClient
			const sent: Array<string> = []
			const db = Db.fromSqlClient(client, {
				dialect: CH.clickhouseDialect,
				command: client.asCommand,
				observe: (statement) => Effect.sync(() => void sent.push(statement.sql)),
			})
			return yield* body(db, sent, client)
		}).pipe(
			Effect.provide(ClickhouseClient.layer({ url: endpoint!, username: user, password, database })),
			Effect.ensuring(Effect.orDie(admin.asCommand(admin.unsafe(`DROP DATABASE IF EXISTS ${database} SYNC`)))),
		)
	}).pipe(Effect.provide(ClickhouseClient.layer({ url: endpoint!, username: user, password, database: "default" })))

describe("database", () => {
	describe.skipIf(!endpoint)("live ClickHouse", () => {
		it("runs queries and sql templates", async () => {
			const rows = await Effect.runPromise(
				withDatabase((db) =>
					Effect.gen(function* () {
						yield* db.execute(Db.sql`CREATE TABLE events (Id UInt32, Name String) ENGINE = MergeTree ORDER BY Id`)
						yield* db.execute(Db.sql`INSERT INTO events VALUES (${1}, ${"a"}), (${2}, ${"it's"})`)
						const Events = CH.table("events", { external: true, columns: { Id: CH.uint32, Name: CH.string } })
						return yield* db.run(CH.from(Events).select("Id", "Name").orderBy(["Id", "asc"]))
					}),
				),
			)
			expect(rows).toEqual([
				{ Id: 1, Name: "a" },
				{ Id: 2, Name: "it's" },
			])
		})

		it("runs an insert built with insertInto through the command path", async () => {
			const { rows, sent } = await Effect.runPromise(
				withDatabase((db, sent) =>
					Effect.gen(function* () {
						yield* db.execute(
							Db.sql`CREATE TABLE events (
								OrgId String,
								Id UInt64 DEFAULT 42,
								At DateTime64(3),
								Attrs Map(String, String),
								Note Nullable(String),
								Tags Array(String),
								Day String MATERIALIZED toString(toDate(At))
							) ENGINE = MergeTree ORDER BY (OrgId, Id)`,
						)
						const Events = CH.table("events", {
							external: true,
							tenantColumn: "OrgId",
							columns: {
								OrgId: CH.string,
								Id: CH.column(CH.uint64, { default: 42 }),
								At: CH.dateTime64,
								Attrs: CH.map(CH.string, CH.string),
								Note: CH.nullable(CH.string),
								Tags: CH.array(CH.string),
							},
						})
						const inserted = yield* db.run(
							CH.insertInto(Events).values([
								{ OrgId: CH.param.string("org"), At: new Date("2026-01-02T03:04:05.678Z"), Attrs: { a: "it's; x" }, Tags: ["t"], Note: null },
								{ OrgId: CH.param.string("org"), Id: 7, At: "2026-01-02 00:00:00", Attrs: {}, Tags: [], Note: "n" },
							]),
							{ org: "o1" },
						)
						expect(inserted).toEqual([])
						const rows = yield* db.run(
							CH.from(Events).select("OrgId", "Id", "At", "Attrs", "Note", "Tags").orderBy(["Id", "asc"]),
						)
						return { rows, sent: [...sent] }
					}),
				),
			)
			expect(rows.map((row) => ({ ...row, At: DateTime.formatIso(row.At) }))).toEqual([
				{ OrgId: "o1", Id: 7, At: "2026-01-02T00:00:00.000Z", Attrs: {}, Note: "n", Tags: [] },
				{ OrgId: "o1", Id: 42, At: "2026-01-02T03:04:05.678Z", Attrs: { a: "it's; x" }, Note: null, Tags: ["t"] },
			])
			expect(sent[1]).toMatch(/^INSERT INTO events \(OrgId, Id, At, Attrs, Note, Tags\)\nVALUES \('o1', DEFAULT, /)
		})

		it("runs insert ... select with settings", async () => {
			const rows = await Effect.runPromise(
				withDatabase((db) =>
					Effect.gen(function* () {
						yield* db.execute(Db.sql`CREATE TABLE spans (OrgId String, Name String, Ms UInt64) ENGINE = MergeTree ORDER BY OrgId`)
						yield* db.execute(Db.sql`CREATE TABLE daily (OrgId String, Name String, Total UInt64) ENGINE = MergeTree ORDER BY OrgId`)
						const Spans = CH.table("spans", { external: true, columns: { OrgId: CH.string, Name: CH.string, Ms: CH.uint64 }, tenantColumn: "OrgId" })
						const Daily = CH.table("daily", { external: true, columns: { OrgId: CH.string, Name: CH.string, Total: CH.uint64 }, tenantColumn: "OrgId" })
						yield* db.run(
							CH.insertInto(Spans)
								.values([
									{ OrgId: "o", Name: "a", Ms: 1 },
									{ OrgId: "o", Name: "a", Ms: 2 },
									{ OrgId: "p", Name: "b", Ms: 9 },
								])
								.settings({ async_insert: 0 }),
						)
						yield* db.run(
							CH.insertInto(Daily)
								.select(
									CH.from(Spans)
										.select(($) => ({ Total: CH.sum($.Ms), OrgId: $.OrgId, Name: $.Name }))
										.where(($) => [$.OrgId.eq(CH.param.string("org"))])
										.groupBy("OrgId", "Name"),
								)
								.settings({ max_threads: 1 }),
							{ org: "o" },
						)
						return yield* db.run(CH.from(Daily).select("OrgId", "Name", "Total"))
					}),
				),
			)
			expect(rows).toEqual([{ OrgId: "o", Name: "a", Total: 3 }])
		})

		it("runs update as an ALTER TABLE mutation and deleteFrom as a lightweight delete", async () => {
			const rows = await Effect.runPromise(
				withDatabase((db) =>
					Effect.gen(function* () {
						yield* db.execute(Db.sql`CREATE TABLE jobs (OrgId String, Id UInt32, State String) ENGINE = MergeTree ORDER BY (OrgId, Id)`)
						const Jobs = CH.table("jobs", { external: true, columns: { OrgId: CH.string, Id: CH.uint32, State: CH.string }, tenantColumn: "OrgId" })
						yield* db.run(
							CH.insertInto(Jobs).values([
								{ OrgId: "o", Id: 1, State: "queued" },
								{ OrgId: "o", Id: 2, State: "queued" },
								{ OrgId: "p", Id: 3, State: "queued" },
							]),
						)
						yield* db.run(
							CH.update(Jobs)
								.set({ State: "done" })
								.where(($) => [$.OrgId.eq(CH.param.string("org")), $.Id.eq(1)])
								.settings({ mutations_sync: 2 }),
							{ org: "o" },
						)
						yield* db.run(CH.deleteFrom(Jobs).where(($) => [$.OrgId.eq("p")]).settings({ lightweight_deletes_sync: 2 }))
						return yield* db.run(CH.from(Jobs).select("OrgId", "Id", "State").orderBy(["Id", "asc"]))
					}),
				),
			)
			expect(rows).toEqual([
				{ OrgId: "o", Id: 1, State: "done" },
				{ OrgId: "o", Id: 2, State: "queued" },
			])
		})

		it("reads with DISTINCT, DISTINCT ON, IS NULL and BETWEEN", async () => {
			const result = await Effect.runPromise(
				withDatabase((db) =>
					Effect.gen(function* () {
						yield* db.execute(Db.sql`CREATE TABLE ev (OrgId String, Id UInt32, Note Nullable(String)) ENGINE = MergeTree ORDER BY (OrgId, Id)`)
						const Ev = CH.table("ev", { external: true, columns: { OrgId: CH.string, Id: CH.uint32, Note: CH.nullable(CH.string) } })
						yield* db.run(
							CH.insertInto(Ev).values([
								{ OrgId: "o", Id: 1, Note: null },
								{ OrgId: "o", Id: 2, Note: "n" },
								{ OrgId: "p", Id: 3, Note: null },
							]),
						)
						const orgs = yield* db.run(CH.from(Ev).select("OrgId").distinct().orderBy(["OrgId", "asc"]))
						const last = yield* db.run(
							CH.from(Ev).select(($) => ({ OrgId: $.OrgId, Id: $.Id })).distinctOn("OrgId").orderBy(["OrgId", "asc"], ["Id", "desc"]),
						)
						const nulls = yield* db.run(
							CH.from(Ev).select("Id").where(($) => [$.Note.isNull(), $.Id.between(1, CH.param.int("hi"))]).orderBy(["Id", "asc"]),
							{ hi: 3 },
						)
						return { orgs, last, nulls }
					}),
				),
			)
			expect(result.orgs).toEqual([{ OrgId: "o" }, { OrgId: "p" }])
			expect(result.last).toEqual([
				{ OrgId: "o", Id: 2 },
				{ OrgId: "p", Id: 3 },
			])
			expect(result.nulls).toEqual([{ Id: 1 }, { Id: 3 }])
		})

		it("refuses a transaction before sending anything", async () => {
			const result = await Effect.runPromise(
				withDatabase((db, sent) =>
					Effect.gen(function* () {
						const error = yield* Effect.flip(db.transaction(db.execute(Db.sql`SELECT 1`)))
						return { error, sent: [...sent] }
					}),
				),
			)
			expect(result.error).toBeInstanceOf(Db.TransactionUnsupported)
			expect(result.sent).toEqual([])
		})

		// Why the dialect refuses: Effect's ClickHouse client has no session. Its
		// withTransaction sends BEGIN through the query path, which appends FORMAT
		// JSON and fails to parse; under asCommand the BEGIN reaches the server,
		// which a default server rejects, and which a server with experimental
		// transactions accepts and forgets (design/transactions.md section 3).
		// Pinned so a server or driver change that alters it is noticed.
		it("Effect's ClickHouse withTransaction fails at BEGIN", async () => {
			const [query, command] = await Effect.runPromise(
				withDatabase((_db, _sent, client) =>
					Effect.all([
						Effect.exit(client.withTransaction(client.unsafe("SELECT 1"))),
						Effect.exit(client.asCommand(client.withTransaction(client.unsafe("SELECT 1")))),
					]),
				),
			)
			expect(String(Exit.isFailure(query) ? query.cause : "")).toMatch(/Syntax error/)
			expect(String(Exit.isFailure(command) ? command.cause : "")).toMatch(/NOT_IMPLEMENTED|not supported/i)
		})
	})
})
