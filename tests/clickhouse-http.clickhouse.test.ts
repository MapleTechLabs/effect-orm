// The ClickHouse HTTP client against a real server, over `fetch`. Opt in with
// EFFECT_ORM_CLICKHOUSE_URL (and _USER, _PASSWORD); like the other live suites
// it creates no tables and writes no data.
import { assert, describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Exit, Layer, Schedule, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import * as TestClock from "effect/testing/TestClock"
import * as SqlClient from "effect/sql/SqlClient"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as Db from "@maple-dev/effect-orm/database"
import { ClickhouseHttpClient, layer } from "@maple-dev/effect-orm/clickhouse-http"
import { endpoint } from "./clickhouse-support"

const Client = layer({
	url: endpoint ?? "http://127.0.0.1:8123",
	username: process.env.EFFECT_ORM_CLICKHOUSE_USER ?? "default",
	password: process.env.EFFECT_ORM_CLICKHOUSE_PASSWORD ?? "",
	settings: { session_timezone: "UTC" },
}).pipe(Layer.provide(FetchHttpClient.layer))

const Live = Layer.effect(
	Db.Database,
	Effect.gen(function* () {
		return Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: CH.clickhouseDialect })
	}),
).pipe(Layer.provideMerge(Client))

const Numbers = CH.table("system.numbers", { external: true, columns: { number: CH.uint64 } })
const Databases = CH.table("system.databases", { external: true, columns: { name: CH.string, engine: CH.string } })

describe.skipIf(!endpoint)("ClickhouseHttpClient on ClickHouse", () => {
	it.layer(Live)((it) => {
		it.effect("runs a builder query and decodes it", () =>
			Effect.gen(function* () {
				const rows = yield* Db.run(
					CH.from(Numbers)
						.select(($) => ({ n: $.number }))
						.where(($) => [$.number.lt(CH.param.int("limit"))])
						.limit(3),
					{ limit: 3 },
				)
				expect(rows).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }])
			}),
		)

		it.effect("batches concurrent findById lookups into one IN statement", () =>
			Effect.gen(function* () {
				const byName = Db.findById(CH.from(Databases).select("name").crossTenant(), { key: "name" })
				const found = yield* Effect.forEach(["system", "default", "no_such_db"], (name) => Effect.result(byName(name)), {
					concurrency: "unbounded",
				})
				expect(found.map((result) => (result._tag === "Success" ? result.success : result.failure._tag))).toEqual([
					{ name: "system" },
					{ name: "default" },
					"NoSuchElementError",
				])
			}),
		)

		it.effect("binds parameters on the server", () =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const rows = yield* sql`SELECT ${"o'brien"} AS name, ${41} + 1 AS n`
				expect(rows).toEqual([{ name: "o'brien", n: 42 }])
			}),
		)

		// Issue #38: these used to fail to parse or arrive changed; string arrays did not parse at all.
		it.effect("binds strings with newlines, tabs and backslashes unchanged", () =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const values = ["a\nb", "a\\nb", "a\\\\b", "tab\there", "cr\r", "nul\0", "é é 🙂\n|\t\\n"]
				for (const value of values) {
					const rows = yield* sql`SELECT ${value} AS value, ${[value, "it's"]} AS list`
					expect(rows).toEqual([{ value, list: [value, "it's"] }])
				}
			}),
		)

		it.effect("binds NULL, nullable arrays and integers beyond Int64", () =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const rows = yield* sql`SELECT ${null} AS missing, ${"\\N"} AS text, ${[null, "a"]} AS list, ${[]} AS empty, toString(${2n ** 64n - 1n}) AS big, toString(${-(2n ** 100n)}) AS wide`
				expect(rows).toEqual([
					{ missing: null, text: "\\N", list: [null, "a"], empty: [], big: "18446744073709551615", wide: "-1267650600228229401496703205376" },
				])
			}),
		)

		// A query can fail after ClickHouse has answered 200 and sent rows. The rows
		// are not a result: both paths fail, with the server's reason. This used to
		// succeed with the rows so far on servers before 25.11.
		it.effect("fails a query that throws part way through its result", () =>
			Effect.gen(function* () {
				const client = yield* ClickhouseHttpClient
				const late = client
					.unsafe("SELECT number, throwIf(number = 50000, 'late failure') AS t FROM numbers(100000)")
					.pipe(client.withSettings({ max_block_size: 1000 }))
				const error = yield* Effect.flip(late)
				expect(error.reason._tag).toBe("UnknownError")
				expect(error.message).toMatch(/^Code: 395\. DB::Exception: late failure/)

				const slow = client
					.unsafe("SELECT number, sleepEachRow(0.001) AS s FROM numbers(100000)")
					.pipe(client.withSettings({ max_block_size: 100, max_execution_time: 1 }))
				expect((yield* Effect.flip(slow)).reason._tag).toBe("StatementTimeoutError")
			}),
		)

		it.effect("fails a stream that throws part way through", () =>
			Effect.gen(function* () {
				const client = yield* ClickhouseHttpClient
				let seen = 0
				const error = yield* client
					.unsafe("SELECT number, throwIf(number = 50000, 'late failure') AS t FROM numbers(100000)")
					.stream.pipe(
						Stream.runForEach(() => Effect.sync(() => void seen++)),
						client.withSettings({ max_block_size: 1000 }),
						Effect.flip,
					)
				expect(error.message).toMatch(/^Code: 395\. DB::Exception: late failure/)
				// None at all when the server buffered the reply and could still answer 500.
				expect(seen).toBeLessThanOrEqual(50000)
				// A column that happens to be named `exception` is still a column.
				expect(yield* Stream.runCollect(client.unsafe("SELECT 'Code: 1. x' AS exception").stream)).toEqual([{ exception: "Code: 1. x" }])
			}),
		)

		it.effect("streams rows", () =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const rows = yield* Stream.runCollect(sql.unsafe("SELECT toUInt8(number) AS n FROM numbers(4)").stream)
				expect(rows).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }])
			}),
		)

		it.effect("Db.stream decodes each streamed row with the query's row schema, and stops early", () =>
			Effect.gen(function* () {
				const query = CH.from(Numbers).select(($) => ({ n: $.number })).where(($) => [$.number.lt(CH.param.int("limit"))])
				const rows = yield* Stream.runCollect(Db.stream(query, { limit: 3 }))
				// UInt64 arrives as a string and is decoded to a number by the row schema.
				expect(rows).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }])
				// An unbounded scan ends when the consumer stops reading.
				expect(yield* Stream.runCollect(Stream.take(Db.stream(CH.from(Numbers).select(($) => ({ n: $.number }))), 2))).toEqual([
					{ n: 0 },
					{ n: 1 },
				])
			}),
		)

		it.effect("classifies a syntax error", () =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(Db.query({ sql: "SELEKT 1" }))
				assert(Exit.isFailure(exit))
				const error = exit.cause.reasons.find((r) => r._tag === "Fail")
				assert(error?._tag === "Fail" && error.error._tag === "@maple-dev/effect-orm/DatabaseError")
				expect(error.error.reason).toBe("SqlSyntaxError")
			}),
		)

		// On the real clock: the timeout below has to fire, which a TestClock never does.
		it.effect("stops the query on the server when the fiber is interrupted", () =>
			TestClock.withLive(Effect.gen(function* () {
				const client = yield* ClickhouseHttpClient
				const queryId = `effect-orm-cancel-${crypto.randomUUID()}`
				const slow = client
					.unsafe("SELECT count() FROM numbers(1e12) WHERE NOT ignore(sleepEachRow(0))")
					.pipe(client.withQueryId(queryId), client.withSettings({ max_block_size: 1 }))
				yield* Effect.timeout(slow, Duration.millis(500)).pipe(Effect.ignore)
				// Aborting the request is not enough on its own; the client kills the query by id.
				const running = yield* client
					.unsafe<{ readonly n: number }>(`SELECT count() AS n FROM system.processes WHERE query_id = '${queryId}'`)
					.pipe(
						Effect.map((rows) => Number(rows[0]?.n)),
						Effect.repeat({ until: (n) => n === 0, schedule: Schedule.spaced(Duration.millis(100)), times: 30 }),
					)
				expect(running).toBe(0)
			})),
		)
	})
})
