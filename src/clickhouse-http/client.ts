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
	ConstraintError,
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
	 * (`withSettings`). Queries already send two:
	 * `cancel_http_readonly_queries_on_client_close=1`, so an interrupted fiber
	 * stops its query on the server as well as the request, and
	 * `http_write_exception_in_output_format=1`, so a query that fails after its
	 * first rows were sent says so in the reply instead of cutting the connection.
	 *
	 * A `readonly=1` user may not change a setting, only repeat its current value:
	 * for one, set both here to what the server has (`system.settings`). The
	 * first is `0` unless a profile says otherwise; the second is `1` before
	 * ClickHouse 25.11 and `0` from it, where a late failure then arrives as a
	 * `ConnectionError`.
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
// whichever client ran it. One exception: that driver reads 469
// (VIOLATED_CONSTRAINT, a failed CHECK) as a statement timeout, which says
// retry; here it is a ConstraintError.
const SYNTAX_ERROR_CODES = new Set([36, 60, 62, 242])

const classify = (code: number | undefined, message: string, cause: unknown, operation: string) => {
	const props = { cause, message, operation }
	if (code === 516) return new AuthenticationError(props)
	if (code === 497) return new AuthorizationError(props)
	if (code !== undefined && SYNTAX_ERROR_CODES.has(code)) return new SqlSyntaxError(props)
	if (code === 159) return new StatementTimeoutError(props)
	if (code === 469) return new ConstraintError(props)
	return new UnknownError(props)
}

/** `Code: 62. DB::Exception: Syntax error …` when the header is missing. */
const codeFromBody = (body: string): number | undefined => {
	const match = /^Code:\s*(\d+)/.exec(body.trim())
	return match ? Number(match[1]) : undefined
}

// A query can fail after ClickHouse has answered 200 and sent rows. What the
// reply then holds depends on `http_write_exception_in_output_format`:
//
//   1  the format carries it: an `exception` key beside `data` (JSON,
//      JSONCompact), or a last line `{"exception": "…"}` (JSONEachRow);
//   0  the rows stop and a marked block follows,
//      `__exception__\r\n<message>`, which 25.11 and later wrap in a tag:
//      `\r\n__exception__\r\n<tag>\r\n<message>\n<length> <tag>\r\n__exception__\r\n`.
//
// The client asks for 1, and reads both: a server's profile or a caller's
// settings can say otherwise.
const EXCEPTION_MARKER = "__exception__"
const MARKED_EXCEPTION = /__exception__\r?\n/
const TAGGED_EXCEPTION = /^([a-z0-9]+)\r?\n([\s\S]*?)\r?\n\d+ \1\r?\n__exception__\s*$/

/** The message of the marked block that ends `body`, if it has one. */
const markedException = (body: string): string | undefined => {
	const marker = MARKED_EXCEPTION.exec(body)
	if (marker === null) return undefined
	const rest = body.slice(marker.index + marker[0].length)
	return (TAGGED_EXCEPTION.exec(rest)?.[2] ?? rest).trim()
}

// JSONEachRow's exception line. A row with one String column named `exception`
// is `{"exception":"…"}`: rows never have the space after the colon, so the
// prefix alone tells the two apart.
const EXCEPTION_ROW = '{"exception": "'

const exceptionOf = (parsed: unknown): string | undefined =>
	typeof parsed === "object" && parsed !== null && typeof (parsed as { exception?: unknown }).exception === "string"
		? (parsed as { exception: string }).exception
		: undefined

const exceptionRow = (line: string): string | undefined => {
	if (!line.startsWith(EXCEPTION_ROW)) return undefined
	try {
		return exceptionOf(JSON.parse(line))
	} catch {
		return undefined
	}
}

/**
 * What a failed reply says: the exception alone, out of whichever of those
 * forms it came in. A compressed reply that fails before its first flush is one
 * more: the rows so far, then the exception as plain text, found by its code.
 */
const failureText = (body: string, code: number | undefined): string => {
	const marked = markedException(body)
	if (marked !== undefined) return marked
	const text = body.trim()
	if (!text.startsWith("{") && !text.startsWith("[")) return text
	const row = exceptionRow(text.slice(text.lastIndexOf("\n") + 1))
	if (row !== undefined) return row
	try {
		const exception = exceptionOf(JSON.parse(text))
		if (exception !== undefined) return exception
	} catch {
		// Not one JSON document: rows, then the exception.
	}
	const plain = code === undefined ? -1 : text.lastIndexOf(`Code: ${code}. `)
	return plain === -1 ? text : text.slice(plain)
}

const validateUrl = (raw: string): URL => {
	const url = new URL(raw)
	if (url.username !== "" || url.password !== "") throw new Error("ClickhouseHttpClient: pass credentials as username and password, not in the url")
	if (url.search !== "" || url.hash !== "") throw new Error("ClickhouseHttpClient: the url takes no query string or fragment")
	return url
}

// Integer types in the order tried, each with the range it holds.
const INTEGER_TYPES: ReadonlyArray<readonly [string, bigint, bigint]> = [
	["Int64", -(2n ** 63n), 2n ** 63n - 1n],
	["UInt64", 0n, 2n ** 64n - 1n],
	["Int128", -(2n ** 127n), 2n ** 127n - 1n],
	["UInt256", 0n, 2n ** 256n - 1n],
	["Int256", -(2n ** 255n), 2n ** 255n - 1n],
]

/** The narrowest of those types that holds every value: Int64 wraps above 2^63. */
const integerType = (values: ReadonlyArray<bigint>): string =>
	INTEGER_TYPES.find(([, min, max]) => values.every((value) => value >= min && value <= max))?.[0] ?? "Int256"

const isNullish = (value: unknown): value is null | undefined => value === null || value === undefined

/**
 * The type of an array's elements, read from all of them: a null anywhere makes
 * the element Nullable (ClickHouse reads NULL into a non-nullable element as the
 * type's default), integers take a type wide enough for the largest, and nested
 * arrays are read together, so `[["a"], [null]]` is `Array(Array(Nullable(String)))`.
 */
const elementType = (values: ReadonlyArray<unknown>): string => {
	const present = values.filter((item) => !isNullish(item))
	// An array cannot be Nullable: a null beside arrays is left for ClickHouse to refuse.
	if (present.length > 0 && present.every((item) => Array.isArray(item))) return `Array(${elementType(present.flat())})`
	const base =
		present.length === 0 ? "String"
		: present.every((item) => typeof item === "bigint") ? integerType(present as ReadonlyArray<bigint>)
		: typeFromUnknown(present[0])
	return present.length < values.length ? `Nullable(${base})` : base
}

const typeFromUnknown = (value: unknown): string => {
	if (Array.isArray(value)) return `Array(${elementType(value)})`
	switch (typeof value) {
		case "number":
			return "Float64"
		case "bigint":
			return integerType([value])
		case "boolean":
			return "Bool"
		case "object":
			return value === null ? "Nullable(String)" : value instanceof Date ? "DateTime64(3)" : "String"
		case "undefined":
			return "Nullable(String)"
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

// ClickHouse reads a scalar HTTP query parameter in the escaped (TabSeparated) format: a raw
// newline fails to parse, and a backslash starts an escape sequence. An array parameter is
// read as a literal instead, so only its quoted strings are escaped.
const escapes: Record<string, string> = { "\\": "\\\\", "\0": "\\0", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" }

const dateValue = (value: Date): string => value.toISOString().replace("T", " ").replace("Z", "")

/** An array as a ClickHouse literal: strings single-quoted, since JSON's double quotes do not parse. */
const arrayLiteral = (value: ReadonlyArray<unknown>): string =>
	`[${value.map((item) =>
		item === null || item === undefined ? "NULL"
		: Array.isArray(item) ? arrayLiteral(item)
		: typeof item === "number" || typeof item === "bigint" || typeof item === "boolean" ? String(item)
		: `'${(item instanceof Date ? dateValue(item) : String(item)).replace(/[\\']/g, (c) => `\\${c}`)}'`).join(",")}]`

// `\N` is NULL in that format; a string of the same two characters is escaped, so it stays a string.
const paramValue = (value: unknown): string =>
	isNullish(value) ? "\\N"
	: Array.isArray(value) ? arrayLiteral(value)
	: (value instanceof Date ? dateValue(value) : String(value)).replace(/[\\\0\b\f\n\r\t]/g, (c) => escapes[c]!)

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
				if (!command) {
					urlParams.cancel_http_readonly_queries_on_client_close = "1"
					urlParams.http_write_exception_in_output_format = "1"
				}
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
					Effect.flatMap((response) => {
						// The header can come with a 200: a statement that sends progress
						// headers has its status out before it fails.
						const header = response.headers["x-clickhouse-exception-code"]
						return response.status === 200 && header === undefined
							? Effect.succeed({ response, queryId })
							: Effect.flatMap(Effect.orElseSucceed(response.text, () => ""), (body) => {
									const text = failureText(body, header === undefined ? undefined : Number(header))
									const code = header === undefined ? codeFromBody(text) : Number(header)
									const message = text.slice(0, 1000) || `ClickHouse answered ${response.status}`
									return Effect.fail(new SqlError({ reason: classify(code, message, { status: response.status, code }, operation) }))
								})
					}),
				)
			})

		const parseFailure = (cause: unknown, operation: string) =>
			new SqlError({ reason: new UnknownError({ cause, message: "ClickhouseHttpClient: the response is not valid JSON", operation }) })
		/** A query that failed after ClickHouse had answered 200: the rows before it are not a result. */
		const lateFailure = (exception: string, operation: string) => {
			const code = codeFromBody(exception)
			return new SqlError({ reason: classify(code, exception.slice(0, 1000), { status: 200, code }, operation) })
		}
		/** The same, from what a stream read after the exception marker. */
		const markedFailure = (rest: string) =>
			lateFailure(markedException(`${EXCEPTION_MARKER}\n${rest}`) || "ClickHouse stopped the query with an exception it did not send", "stream")
		const readFailure = (cause: unknown, operation: string) =>
			new SqlError({
				reason: new ConnectionError({ cause, message: "ClickhouseHttpClient: the response ended before it was complete", operation }),
			})

		const json = (sql: string, params: ReadonlyArray<unknown>, format: "JSON" | "JSONCompact") =>
			Effect.scoped(
				Effect.withFiber((fiber) =>
					fiber.getRef(ClientMethod) === "command"
						? Effect.as(send(sql, params, undefined, "execute"), [] as ReadonlyArray<any>)
						: send(sql, params, format, "execute").pipe(
								Effect.flatMap(({ response, queryId }) =>
									response.text.pipe(
										Effect.mapError((cause) => readFailure(cause, "execute")),
										Effect.onInterrupt(() => kill(queryId)),
									),
								),
								Effect.flatMap((text): Effect.Effect<ReadonlyArray<any>, SqlError> => {
									let parsed: { readonly data: ReadonlyArray<any> }
									try {
										parsed = JSON.parse(text)
									} catch (cause) {
										const exception = markedException(text)
										return Effect.fail(exception === undefined ? parseFailure(cause, "execute") : lateFailure(exception, "execute"))
									}
									const exception = exceptionOf(parsed)
									return exception === undefined ? Effect.succeed(parsed.data) : Effect.fail(lateFailure(exception, "execute"))
								}),
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
						// Set by the line that ends in the exception marker. What follows it is
						// the exception, kept (to a bound) and raised when the body ends.
						let rest: string | undefined
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
							Stream.mapEffect((line): Effect.Effect<object | undefined, SqlError> => {
								if (rest !== undefined) {
									if (rest.length < 65536) rest += `${line}\n`
									return Effect.succeed(undefined)
								}
								if (line.length === 0) return Effect.succeed(undefined)
								// Either way the query is over on the server: there is nothing left to kill.
								const exception = exceptionRow(line)
								if (exception !== undefined) {
									drained = true
									return Effect.fail(lateFailure(exception, "stream"))
								}
								// The marker follows the last complete row, or cuts one short.
								if (line.endsWith(EXCEPTION_MARKER)) {
									drained = true
									rest = ""
									return Effect.succeed(undefined)
								}
								return Effect.try({ try: () => JSON.parse(line) as object, catch: (cause) => parseFailure(cause, "stream") })
							}),
							Stream.filter((row) => row !== undefined),
							Stream.map((row) => (transformRows ? transformRows([row])[0] : row)),
							// A server before 25.11 closes the connection after the block, so the
							// body can fail with the exception already read: that is the error.
							Stream.catch((error) => Stream.fail(rest === undefined || rest.trim() === "" ? error : markedFailure(rest))),
							Stream.concat(Stream.suspend(() => (rest === undefined ? Stream.empty : Stream.fail(markedFailure(rest))))),
							Stream.ensuring(Effect.suspend(() => (drained ? Effect.void : kill(queryId)))),
						)
					}),
					Stream.unwrap,
				),
		}

		const client = yield* Client.make({
			acquirer: Effect.succeed(connection),
			driver: "clickhouse-http",
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
