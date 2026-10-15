// The ClickHouse HTTP client against a fake HttpClient: what it sends, how it
// reads replies and failures, and that `Database` runs through it unchanged.
// tests/clickhouse-http.clickhouse.test.ts runs the same client on a server.
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, Redacted, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as SqlClient from "effect/sql/SqlClient"
import { isSqlError } from "effect/sql/SqlError"
import * as CH from "../clickhouse"
import * as Db from "../database"
import { ClickhouseHttpClient, layer, type ClickhouseHttpClientConfig } from "../clickhouse-http"

interface Sent {
	readonly url: URL
	readonly body: string
	readonly headers: Record<string, string>
}

type Reply = { readonly status?: number; readonly body: string; readonly headers?: Record<string, string> }

/** A ClickHouse HTTP client over a fake HttpClient that records each request. */
const fake = (reply: (sent: Sent) => Reply, config: Partial<ClickhouseHttpClientConfig> = {}) => {
	const sent: Array<Sent> = []
	const http = HttpClient.make((request, url) => {
		const body = request.body._tag === "Uint8Array" ? (request.body.text ?? new TextDecoder().decode(request.body.body)) : ""
		const recorded = { url, body, headers: { ...request.headers } }
		sent.push(recorded)
		const { status = 200, body: text, headers } = reply(recorded)
		return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(text, { status, headers })))
	})
	const live = layer({
		url: "https://clickhouse.example:8443",
		username: "reader",
		password: Redacted.make("s3cret"),
		database: "analytics",
		settings: { max_execution_time: 30 },
		...config,
	}).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))
	return { sent, live }
}

const json = (data: ReadonlyArray<unknown>): Reply => ({ body: JSON.stringify({ meta: [], data, rows: data.length }) })

describe("ClickhouseHttpClient", () => {
	it.effect("POSTs the SQL with its format, credentials as a header, and settings as URL parameters", () => {
		const { sent, live } = fake(() => json([{ x: 1 }]))
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			const rows = yield* sql.unsafe("SELECT 1 AS x")
			expect(rows).toEqual([{ x: 1 }])
			const [request] = sent
			assert(request !== undefined)
			expect(request.body).toBe("SELECT 1 AS x\nFORMAT JSON")
			expect(request.headers.authorization).toBe(`Basic ${btoa("reader:s3cret")}`)
			expect(request.url.origin).toBe("https://clickhouse.example:8443")
			expect(request.url.username).toBe("")
			expect(request.url.searchParams.get("database")).toBe("analytics")
			expect(request.url.searchParams.get("max_execution_time")).toBe("30")
			// An interrupted query stops on the server, not only in the client.
			expect(request.url.searchParams.get("cancel_http_readonly_queries_on_client_close")).toBe("1")
			expect(request.url.searchParams.get("query_id")).toMatch(/^[0-9a-f-]{36}$/)
		}).pipe(Effect.provide(live))
	})

	it.effect("binds parameters server-side, typed, as param_pN", () => {
		const { sent, live } = fake(() => json([]))
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			yield* sql`SELECT ${"o'brien"} AS name, ${42} AS n`
			const [request] = sent
			assert(request !== undefined)
			expect(request.body).toBe("SELECT {p1: String} AS name, {p2: Float64} AS n\nFORMAT JSON")
			expect(request.url.searchParams.get("param_p1")).toBe("o'brien")
			expect(request.url.searchParams.get("param_p2")).toBe("42")
		}).pipe(Effect.provide(live))
	})

	it.effect("sends a command without a format, and returns no rows", () => {
		const { sent, live } = fake(() => ({ body: "" }))
		return Effect.gen(function* () {
			const client = yield* ClickhouseHttpClient
			const rows = yield* client.asCommand(client.unsafe("CREATE TABLE t (x UInt8) ENGINE = Memory"))
			expect(rows).toEqual([])
			const [request] = sent
			assert(request !== undefined)
			expect(request.body).toBe("CREATE TABLE t (x UInt8) ENGINE = Memory")
			expect(request.url.searchParams.has("cancel_http_readonly_queries_on_client_close")).toBe(false)
		}).pipe(Effect.provide(live))
	})

	it.effect("applies a query id and per-call settings over the configured ones", () => {
		const { sent, live } = fake(() => json([]))
		return Effect.gen(function* () {
			const client = yield* ClickhouseHttpClient
			yield* client.unsafe("SELECT 1").pipe(client.withSettings({ max_execution_time: 5 }), client.withQueryId("q-1"))
			const [request] = sent
			assert(request !== undefined)
			expect(request.url.searchParams.get("query_id")).toBe("q-1")
			expect(request.url.searchParams.get("max_execution_time")).toBe("5")
		}).pipe(Effect.provide(live))
	})

	it.effect.each([
		[62, "SqlSyntaxError"],
		[516, "AuthenticationError"],
		[497, "AuthorizationError"],
		[159, "StatementTimeoutError"],
		[241, "UnknownError"],
	] as const)("classifies ClickHouse code %s as %s", ([code, reason]) => {
		const { live } = fake(() => ({
			status: 500,
			body: `Code: ${code}. DB::Exception: fixture failure. (FIXTURE)`,
			headers: { "x-clickhouse-exception-code": String(code) },
		}))
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			const exit = yield* Effect.exit(sql.unsafe("SELECT 1"))
			assert(Exit.isFailure(exit))
			const error = exit.cause.reasons.find((r) => r._tag === "Fail")
			assert(error?._tag === "Fail" && isSqlError(error.error))
			expect(error.error.reason._tag).toBe(reason)
			expect(error.error.message).toContain("fixture failure")
		}).pipe(Effect.provide(live))
	})

	it.effect("reads the code from the body when the header is missing", () => {
		const { live } = fake(() => ({ status: 400, body: "Code: 62. DB::Exception: Syntax error" }))
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			const error = yield* Effect.flip(sql.unsafe("SELEKT 1"))
			expect(error.reason._tag).toBe("SqlSyntaxError")
		}).pipe(Effect.provide(live))
	})

	it.effect("streams JSONEachRow rows", () => {
		const { sent, live } = fake(() => ({ body: '{"n":1}\n{"n":2}\n{"n":3}\n' }))
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			const rows = yield* Stream.runCollect(sql.unsafe("SELECT number AS n FROM numbers(3)").stream)
			expect(rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
			expect(sent[0]?.body).toBe("SELECT number AS n FROM numbers(3)\nFORMAT JSONEachRow")
		}).pipe(Effect.provide(live))
	})

	it.effect("runs effect-orm queries through Database, decoding 64-bit integers", () => {
		const { sent, live } = fake(() => json([{ id: "18446744073709551615", n: "7" }]))
		const Events = CH.table("events", { external: true, columns: { Id: CH.uint64, OrgId: CH.string } })
		const query = CH.from(Events)
			.select(($) => ({ id: CH.toString($.Id), n: CH.count() }))
			.where(($) => [$.OrgId.eq(CH.param.string("org"))])
			.groupBy("id")
		return Effect.gen(function* () {
			const rows = yield* Db.run(query, { org: "o'1" })
			expect(rows).toEqual([{ id: "18446744073709551615", n: 7 }])
			expect(sent[0]?.body).toContain("events.OrgId = 'o\\'1'")
		}).pipe(
			Effect.provide(Layer.effect(Db.Database, Effect.gen(function* () {
				return Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: CH.clickhouseDialect })
			})).pipe(Layer.provideMerge(live))),
		)
	})

	it.effect("kills the query by id when its fiber is interrupted", () => {
		const sent: Array<Sent> = []
		const http = HttpClient.make((request, url) => {
			const body = request.body._tag === "Uint8Array" ? (request.body.text ?? "") : ""
			sent.push({ url, body, headers: { ...request.headers } })
			// The query never answers; the kill does.
			return body.startsWith("KILL")
				? Effect.succeed(HttpClientResponse.fromWeb(request, new Response("")))
				: Effect.never
		})
		const live = layer({ url: "https://clickhouse.example" }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))
		return Effect.gen(function* () {
			const client = yield* ClickhouseHttpClient
			const fiber = yield* Effect.forkChild(client.unsafe("SELECT sleep(3)").pipe(client.withQueryId("slow-1")))
			yield* Effect.yieldNow
			yield* Fiber.interrupt(fiber)
			const kill = sent.find((request) => request.body.startsWith("KILL"))
			assert(kill !== undefined, "no KILL QUERY was sent")
			expect(kill.body).toBe("KILL QUERY WHERE query_id = {id:String} ASYNC")
			expect(kill.url.searchParams.get("param_id")).toBe("slow-1")
		}).pipe(Effect.provide(live))
	})

	it("refuses credentials, a query string or a fragment in the url", () => {
		for (const url of ["https://u:p@clickhouse.example", "https://clickhouse.example/?x=1", "https://clickhouse.example/#f"]) {
			const { live } = fake(() => json([]), { url })
			expect(() => Effect.runSync(Effect.scoped(Layer.build(live)))).toThrow(/url/)
		}
	})
})
