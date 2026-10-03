// `Database` on a live ClickHouse: queries and statements run, transactions are
// refused before anything is sent. Creates one table in a throwaway database.

import { ClickhouseClient } from "@effect/sql-clickhouse"
import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/effect-orm"
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
		it("runs compiled queries and statements", async () => {
			const rows = await Effect.runPromise(
				withDatabase((db) =>
					Effect.gen(function* () {
						yield* db.execute({ sql: "CREATE TABLE events (Id UInt32, Name String) ENGINE = MergeTree ORDER BY Id" })
						yield* db.execute({ sql: "INSERT INTO events VALUES (1, 'a'), (2, 'b')" })
						const Events = CH.table("events", { Id: CH.uint32, Name: CH.string })
						return yield* db.run(CH.compileUnsafe(CH.from(Events).select("Id", "Name").orderBy(["Id", "asc"]), {}))
					}),
				),
			)
			expect(rows).toEqual([
				{ Id: 1, Name: "a" },
				{ Id: 2, Name: "b" },
			])
		})

		it("refuses a transaction before sending anything", async () => {
			const result = await Effect.runPromise(
				withDatabase((db, sent) =>
					Effect.gen(function* () {
						const error = yield* Effect.flip(db.transaction(db.execute({ sql: "SELECT 1" })))
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
