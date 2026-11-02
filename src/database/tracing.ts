// One client span per statement, named and attributed the way the OpenTelemetry
// database semantic conventions describe:
// https://opentelemetry.io/docs/specs/semconv/database/database-spans/
//
// It is the only span a statement gets: it carries the query text, so the SQL
// driver's own span (named after the database, not the operation, and blind to
// the table) runs untraced unless `driverSpans` asks for it.
import { Context, Effect, Stream } from "effect"
import type { CompiledQuery } from "../ch/compile"
import type { Dialect } from "../ch/dialect"

/** What the spans read off a statement. A `CompiledQuery` has all of it. */
export type TracedStatement = { readonly sql: string } & Partial<Pick<CompiledQuery<unknown>, "kind" | "collection">>

/**
 * A low-cardinality name for the statements run inside an effect, recorded as
 * `db.query.summary` and used as the span name. Without one the summary is
 * the operation and table (`SELECT events`), as the conventions recommend.
 */
export const QuerySummary = Context.Reference<string | undefined>("@maple-dev/effect-orm/QuerySummary", {
	defaultValue: () => undefined,
})

/** Names the statements `effect` runs, for spans: `db.query.summary`. */
export const withQuerySummary: {
	(summary: string): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
	<A, E, R>(effect: Effect.Effect<A, E, R>, summary: string): Effect.Effect<A, E, R>
} = ((...args: ReadonlyArray<unknown>) =>
	typeof args[0] === "string"
		? (effect: Effect.Effect<unknown, unknown, unknown>) => Effect.provideService(effect, QuerySummary, args[0] as string)
		: Effect.provideService(args[0] as Effect.Effect<unknown, unknown, unknown>, QuerySummary, args[1] as string)) as never

/** `db.system.name` values the conventions define, by dialect name. */
const SYSTEM_NAMES: Record<string, string> = { clickhouse: "clickhouse", postgres: "postgresql" }

const OPERATIONS: Record<NonNullable<TracedStatement["kind"]>, string> = {
	select: "SELECT",
	insert: "INSERT",
	update: "UPDATE",
	delete: "DELETE",
}

// Plain SQL has no compiled operation or table, so they are read off its text,
// as the conventions allow: the first operation and the first collection named.
const LEADING_WORD = /^\s*(\w+)/
const FIRST_TABLE = /(?:from|into|update|join|table)\s+\W?([\w.]+)/i
/** String literals, with `''` and backslash escapes, so text inside them is not read as a table. */
const STRING_LITERAL = /'(?:[^'\\]|\\.|'')*'/g

/** The operation and table a statement names: compiled, or read off plain SQL. */
const describeStatement = (statement: TracedStatement): { operation?: string; collection?: string } => {
	if (statement.kind !== undefined) return { operation: OPERATIONS[statement.kind], collection: statement.collection }
	return {
		operation: LEADING_WORD.exec(statement.sql)?.[1]?.toUpperCase(),
		collection: FIRST_TABLE.exec(statement.sql.replace(STRING_LITERAL, "''"))?.[1],
	}
}

// The span name and attributes for `statement`, given the summary in context.
const spanOf = (dialect: Dialect, statement: TracedStatement, configured: string | undefined) => {
	const system = SYSTEM_NAMES[dialect.name] ?? dialect.name
	const { operation, collection } = describeStatement(statement)
	const summary =
		configured ?? (operation === undefined ? undefined : collection === undefined ? operation : `${operation} ${collection}`)
	const attributes: Record<string, unknown> = { "db.system.name": system, "db.query.text": statement.sql }
	if (operation !== undefined) attributes["db.operation.name"] = operation
	if (collection !== undefined) attributes["db.collection.name"] = collection
	if (summary !== undefined) attributes["db.query.summary"] = summary
	return { name: summary ?? system, attributes }
}

// `error.type` is the failure's class: a DatabaseError's reason, else its tag.
// `db.response.status_code` is the SQLSTATE, when the server sent one.
const annotateFailure = (error: unknown): Effect.Effect<void> => {
	const sqlState =
		typeof error === "object" && error !== null && "sqlState" in error && typeof error.sqlState === "string"
			? error.sqlState
			: undefined
	const reason =
		typeof error === "object" && error !== null
			? "reason" in error && typeof error.reason === "string"
				? error.reason
				: "_tag" in error && typeof error._tag === "string"
					? error._tag
					: undefined
			: undefined
	const failure: Record<string, unknown> = {}
	if (reason !== undefined) failure["error.type"] = reason
	if (sqlState !== undefined) failure["db.response.status_code"] = sqlState
	return Effect.annotateCurrentSpan(failure)
}

/**
 * Runs `effect`, which sends `statement`, in its client span. The span name is
 * the summary when there is one, then `{operation} {table}`, then the system.
 * `rowsOf` reads `db.response.returned_rows` from the result, when it has rows.
 */
export const traceStatement = <A, E, R>(
	dialect: Dialect,
	statement: TracedStatement,
	effect: Effect.Effect<A, E, R>,
	rowsOf?: (result: A) => number,
): Effect.Effect<A, E, R> =>
	Effect.withFiber((fiber) => {
		const { name, attributes } = spanOf(dialect, statement, fiber.getRef(QuerySummary))
		return effect.pipe(
			Effect.tap((result) =>
				rowsOf === undefined ? Effect.void : Effect.annotateCurrentSpan("db.response.returned_rows", rowsOf(result)),
			),
			Effect.tapError(annotateFailure),
			Effect.withSpan(name, { kind: "client", attributes }),
		)
	})

/**
 * `traceStatement` for a stream of rows: one client span from the first pull
 * to the end, with `db.response.returned_rows` the rows it emitted.
 */
export const traceStream = <A, E, R>(dialect: Dialect, statement: TracedStatement, stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
	Stream.unwrap(
		Effect.withFiber((fiber) => {
			const { name, attributes } = spanOf(dialect, statement, fiber.getRef(QuerySummary))
			// Counted per run: the effect `unwrap` takes runs each time the stream does.
			let returned = 0
			return Effect.succeed(
				stream.pipe(
					Stream.tap(() =>
						Effect.sync(() => {
							returned++
						}),
					),
					Stream.onEnd(Effect.suspend(() => Effect.annotateCurrentSpan("db.response.returned_rows", returned))),
					Stream.tapError((error: E) => annotateFailure(error)),
					Stream.withSpan(name, { kind: "client", attributes }),
				),
			)
		}),
	)
