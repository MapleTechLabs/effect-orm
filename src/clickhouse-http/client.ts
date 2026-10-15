// A ClickHouse `SqlClient` over Effect's `HttpClient`.
//
// Effect's own driver, `@effect/sql-clickhouse`, wraps the Node client, so it
// cannot run in Cloudflare Workers, Deno or a browser. This one speaks
// ClickHouse's HTTP interface through whatever `HttpClient` the caller provides
// (`FetchHttpClient.layer` anywhere `fetch` exists), and keeps that driver's
// shape: the same error reasons, `asCommand`, query ids and settings, so
// `Database` and the migration runner treat the two alike.
import { Context, Effect, Layer, Redacted, Stream } from "effect"
import { dual } from "effect/Function"
import * as Base64 from "effect/encoding/Base64"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Reactivity from "effect/reactivity/Reactivity"
import type * as Scope from "effect/Scope"
import * as Client from "effect/sql/SqlClient"
import type { Connection } from "effect/sql/SqlConnection"
import {
	AuthenticationError,
	AuthorizationError,
	ConnectionError,
	SqlError,
	SqlSyntaxError,
	StatementTimeoutError,
	UnknownError,
} from "effect/sql/SqlError"
import * as Statement from "effect/sql/Statement"

/** A ClickHouse setting value as the HTTP interface takes it. */
export type ClickhouseSetting = string | number | boolean

export interface ClickhouseHttpClientConfig {
	/**
	 * The server, e.g. `https://abc.clickhouse.cloud:8443`. A path is kept, for a
	 * ClickHouse behind a proxy prefix (`https://gateway/clickhouse`); credentials,
	 * a query string or a fragment are refused.
	 */
	readonly url: string
	readonly username?: string | undefined
	readonly password?: Redacted.Redacted<string> | string | undefined
	/** The database unqualified names resolve in; `db.namespace` on spans. Defaults to `default`. */
	readonly database?: string | undefined
	/**
	 * Settings sent with every statement, under the per-call ones
	 * (`withSettings`). Queries already send
	 * `cancel_http_readonly_queries_on_client_close=1`, so an interrupted fiber
	 * stops its query on the server as well as the request.
	 */
	readonly settings?: Readonly<Record<string, ClickhouseSetting>> | undefined
	readonly spanAttributes?: Readonly<Record<string, unknown>> | undefined
}

/** The ClickHouse HTTP client: a `SqlClient`, plus what statements over HTTP need. */
export interface ClickhouseHttpClient extends Client.SqlClient {
	readonly config: ClickhouseHttpClientConfig
	/** Run the statements in `effect` as commands: DDL and writes, which send back no rows. */
	readonly asCommand: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
	/** The `query_id` of the statements in `effect`. Each statement gets a random one otherwise. */
	readonly withQueryId: {
		(queryId: string): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
		<A, E, R>(effect: Effect.Effect<A, E, R>, queryId: string): Effect.Effect<A, E, R>
	}
	/** ClickHouse settings for the statements in `effect`, over the configured ones. */
	readonly withSettings: {
		(settings: Readonly<Record<string, ClickhouseSetting>>): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
		<A, E, R>(effect: Effect.Effect<A, E, R>, settings: Readonly<Record<string, ClickhouseSetting>>): Effect.Effect<A, E, R>
	}
}

export const ClickhouseHttpClient = Context.Service<ClickhouseHttpClient>("@maple-dev/effect-orm/ClickhouseHttpClient")

const ClientMethod = Context.Reference<"query" | "command">("@maple-dev/effect-orm/ClickhouseHttpClient/ClientMethod", {
	defaultValue: () => "query",
})
const QueryId = Context.Reference<string | undefined>("@maple-dev/effect-orm/ClickhouseHttpClient/QueryId", {
	defaultValue: () => undefined,
})
const Settings = Context.Reference<Readonly<Record<string, ClickhouseSetting>>>(
	"@maple-dev/effect-orm/ClickhouseHttpClient/Settings",
	{ defaultValue: () => ({}) },
)

// The codes Effect's Node driver classifies, so a failure means the same thing
// whichever client ran it.
const SYNTAX_ERROR_CODES = new Set([36, 60, 62, 242])

const classify = (code: number | undefined, message: string, cause: unknown, operation: string) => {
	const props = { cause, message, operation }
	if (code === 516) return new AuthenticationError(props)
	if (code === 497) return new AuthorizationError(props)
	if (code !== undefined && SYNTAX_ERROR_CODES.has(code)) return new SqlSyntaxError(props)
	if (code === 159 || code === 469) return new StatementTimeoutError(props)
	return new UnknownError(props)
}

/** `Code: 62. DB::Exception: Syntax error …` when the header is missing. */
const codeFromBody = (body: string): number | undefined => {
	const match = /^Code:\s*(\d+)/.exec(body.trim())
	return match ? Number(match[1]) : undefined
}

const validateUrl = (raw: string): URL => {
	const url = new URL(raw)
	if (url.username !== "" || url.password !== "") throw new Error("ClickhouseHttpClient: pass credentials as username and password, not in the url")
	if (url.search !== "" || url.hash !== "") throw new Error("ClickhouseHttpClient: the url takes no query string or fragment")
	return url
}

const typeFromUnknown = (value: unknown): string => {
	if (Array.isArray(value)) return `Array(${typeFromUnknown(value[0])})`
	switch (typeof value) {
		case "number":
			return "Float64"
		case "bigint":
			return "Int64"
		case "boolean":
			return "Bool"
		case "object":
			return value instanceof Date ? "DateTime64(3)" : "String"
		default:
			return "String"
	}
}

/** `{pN: Type}` placeholders, sent as `param_pN`: ClickHouse's server-side binding. */
const compiler = Statement.makeCompiler({
	dialect: "clickhouse",
	placeholder: (i, value) => `{p${i}: ${typeFromUnknown(value)}}`,
	onIdentifier: Statement.defaultEscape('"'),
	onRecordUpdate: () => ["", []],
	onCustom: () => ["", []],
})

const paramValue = (value: unknown): string =>
	value instanceof Date ? value.toISOString().replace("T", " ").replace("Z", "") : Array.isArray(value) ? JSON.stringify(value) : String(value)

export const make = (
	config: ClickhouseHttpClientConfig,
): Effect.Effect<ClickhouseHttpClient, never, HttpClient.HttpClient | Reactivity.Reactivity | Scope.Scope> =>
	Effect.gen(function* () {
		const url = validateUrl(config.url)
		const database = config.database ?? "default"
		const password = config.password === undefined ? "" : Redacted.isRedacted(config.password) ? Redacted.value(config.password) : config.password
		const authorization =
			config.username === undefined ? undefined : `Basic ${Base64.encode(`${config.username}:${password}`)}`
		const http = yield* HttpClient.HttpClient

		const post = (urlParams: Record<string, string>, body: string) => {
			const request = HttpClientRequest.post(url).pipe(
				HttpClientRequest.setUrlParams(urlParams),
				HttpClientRequest.bodyText(body, "text/plain; charset=utf-8"),
			)
			return authorization === undefined ? request : HttpClientRequest.setHeader(request, "authorization", authorization)
		}
		// The statement span is the record of the request: an HTTP span would add
		// nothing, and its URL carries bound parameter values.
		const untraced = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.provideService(effect, HttpClient.TracerDisabledWhen, () => true)
		// Best effort, and bounded: a kill that fails leaves the query to finish or
		// to time out on its own, which is what would happen without it.
		const kill = (queryId: string) =>
			untraced(
				http.execute(post({ param_id: queryId }, "KILL QUERY WHERE query_id = {id:String} ASYNC")),
			).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.ignore)

		const send = (
			sql: string,
			params: ReadonlyArray<unknown>,
			format: "JSON" | "JSONCompact" | "JSONEachRow" | undefined,
			operation: string,
		): Effect.Effect<{ readonly response: HttpClientResponse.HttpClientResponse; readonly queryId: string }, SqlError, Scope.Scope> =>
			Effect.withFiber((fiber) => {
				const command = fiber.getRef(ClientMethod) === "command"
				const queryId = fiber.getRef(QueryId) ?? crypto.randomUUID()
				const urlParams: Record<string, string> = { database, query_id: queryId }
				if (!command) urlParams.cancel_http_readonly_queries_on_client_close = "1"
				for (const [key, value] of Object.entries({ ...config.settings, ...fiber.getRef(Settings) })) {
					urlParams[key] = String(value)
				}
				params.forEach((value, i) => {
					urlParams[`param_p${i + 1}`] = paramValue(value)
				})
				const request = post(urlParams, command || format === undefined ? sql : `${sql}\nFORMAT ${format}`)
				return untraced(http.execute(request)).pipe(
					// Aborting the request does not stop the query: ClickHouse notices a
					// closed connection only when it next writes to it, which a query still
					// computing its first block may not do for a long time. So kill it by id,
					// as Effect's Node driver does. The body is read after this returns (the
					// headers come with the first block), so readers keep the same guard.
					Effect.onInterrupt(() => kill(queryId)),
					Effect.mapError(
						(cause) =>
							new SqlError({
								reason: new ConnectionError({ cause, message: "ClickhouseHttpClient: the request failed", operation }),
							}),
					),
					Effect.flatMap((response) =>
						response.status === 200
							? Effect.succeed({ response, queryId })
							: Effect.flatMap(Effect.orElseSucceed(response.text, () => ""), (body) => {
									const header = response.headers["x-clickhouse-exception-code"]
									const code = header === undefined ? codeFromBody(body) : Number(header)
									const message = body.trim().slice(0, 1000) || `ClickHouse answered ${response.status}`
									return Effect.fail(new SqlError({ reason: classify(code, message, { status: response.status, code }, operation) }))
								}),
					),
				)
			})

		const parseFailure = (cause: unknown, operation: string) =>
			new SqlError({ reason: new UnknownError({ cause, message: "ClickhouseHttpClient: the response is not valid JSON", operation }) })

		const json = (sql: string, params: ReadonlyArray<unknown>, format: "JSON" | "JSONCompact") =>
			Effect.scoped(
				Effect.withFiber((fiber) =>
					fiber.getRef(ClientMethod) === "command"
						? Effect.as(send(sql, params, undefined, "execute"), [] as ReadonlyArray<any>)
						: send(sql, params, format, "execute").pipe(
								Effect.flatMap(({ response, queryId }) =>
									response.text.pipe(
										Effect.mapError((cause) => parseFailure(cause, "execute")),
										Effect.onInterrupt(() => kill(queryId)),
									),
								),
								Effect.flatMap((text) =>
									Effect.try({
										try: () => (JSON.parse(text) as { readonly data: ReadonlyArray<any> }).data,
										catch: (cause) => parseFailure(cause, "execute"),
									}),
								),
							),
				),
			)

		const connection: Connection = {
			execute: (sql, params, transformRows) =>
				transformRows ? Effect.map(json(sql, params, "JSON"), transformRows) : json(sql, params, "JSON"),
			executeRaw: (sql, params) => json(sql, params, "JSON"),
			executeValues: (sql, params) => json(sql, params, "JSONCompact"),
			executeValuesUnprepared: (sql, params) => json(sql, params, "JSONCompact"),
			executeUnprepared: (sql, params, transformRows) =>
				transformRows ? Effect.map(json(sql, params, "JSON"), transformRows) : json(sql, params, "JSON"),
			executeStream: (sql, params, transformRows) =>
				send(sql, params, "JSONEachRow", "stream").pipe(
					Effect.map(({ response, queryId }) => {
						// A stream can end before the body does: interrupted, failed, or stopped
						// early by its consumer (`Stream.take`). Any of those leaves the query
						// running on the server, so it is killed unless the body was read to the end.
						let drained = false
						return response.stream.pipe(
							Stream.onEnd(Effect.sync(() => void (drained = true))),
							Stream.mapError(
								(cause) =>
									new SqlError({
										reason: new ConnectionError({ cause, message: "ClickhouseHttpClient: the stream failed", operation: "stream" }),
									}),
							),
							Stream.decodeText(),
							Stream.splitLines,
							Stream.filter((line) => line.length > 0),
							Stream.mapEffect((line) =>
								Effect.try({ try: () => JSON.parse(line) as object, catch: (cause) => parseFailure(cause, "stream") }),
							),
							Stream.map((row) => (transformRows ? transformRows([row])[0] : row)),
							Stream.ensuring(Effect.suspend(() => (drained ? Effect.void : kill(queryId)))),
						)
					}),
					Stream.unwrap,
				),
		}

		const client = yield* Client.make({
			acquirer: Effect.succeed(connection),
			compiler,
			// The peer, for service maps: with the HTTP span off, nothing else names it.
			// The caller's attributes come last, so they can rename the peer.
			spanAttributes: [
				["db.system.name", "clickhouse"],
				["db.namespace", database],
				["server.address", url.hostname],
				["server.port", Number(url.port || (url.protocol === "https:" ? 443 : 80))],
				["peer.service", "clickhouse"],
				...Object.entries(config.spanAttributes ?? {}),
			],
			// ClickHouse has no transactions over HTTP without a session; effect-orm's
			// ClickHouse dialect refuses them before this is ever sent.
			beginTransaction: "BEGIN TRANSACTION",
		})

		return Object.assign(client, {
			config,
			asCommand: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, ClientMethod, "command"),
			withQueryId: dual(2, <A, E, R>(effect: Effect.Effect<A, E, R>, queryId: string) =>
				Effect.provideService(effect, QueryId, queryId),
			),
			withSettings: dual(2, <A, E, R>(effect: Effect.Effect<A, E, R>, settings: Readonly<Record<string, ClickhouseSetting>>) =>
				Effect.provideService(effect, Settings, settings),
			),
		}) as ClickhouseHttpClient
	})

/**
 * `ClickhouseHttpClient` and `SqlClient` from `config`. Provide an
 * `HttpClient`: `FetchHttpClient.layer` from `effect/http` runs anywhere
 * `fetch` does, Cloudflare Workers included.
 */
export const layer = (
	config: ClickhouseHttpClientConfig,
): Layer.Layer<ClickhouseHttpClient | Client.SqlClient, never, HttpClient.HttpClient> =>
	Layer.effectContext(
		Effect.map(make(config), (client) =>
			Context.make(ClickhouseHttpClient, client).pipe(Context.add(Client.SqlClient, client)),
		),
	).pipe(Layer.provide(Reactivity.layer))
