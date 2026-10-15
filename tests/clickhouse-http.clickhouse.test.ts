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

		it.effect("binds parameters on the server", () =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const rows = yield* sql`SELECT ${"o'brien"} AS name, ${41} + 1 AS n`
				expect(rows).toEqual([{ name: "o'brien", n: 42 }])
			}),
		)

		it.effect("streams rows", () =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const rows = yield* Stream.runCollect(sql.unsafe("SELECT toUInt8(number) AS n FROM numbers(4)").stream)
				expect(rows).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }])
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
