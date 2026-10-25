// One client span per statement, named and attributed the way the OpenTelemetry
// database semantic conventions describe:
// https://opentelemetry.io/docs/specs/semconv/database/database-spans/
//
// Effect's own `sql.execute` span still runs inside it with the query text, but
// it cannot carry these: it names the operation after the client method
// (`execute`), and only a compiled query knows its table.
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

// The span name and attributes for `statement`, given the summary in context.
const spanOf = (dialect: Dialect, statement: TracedStatement, configured: string | undefined) => {
	const system = SYSTEM_NAMES[dialect.name] ?? dialect.name
	const operation = statement.kind === undefined ? undefined : OPERATIONS[statement.kind]
	const summary =
		configured ?? (operation === undefined ? undefined : statement.collection === undefined ? operation : `${operation} ${statement.collection}`)
	const attributes: Record<string, unknown> = { "db.system.name": system }
	if (operation !== undefined) attributes["db.operation.name"] = operation
	if (statement.collection !== undefined) attributes["db.collection.name"] = statement.collection
	if (summary !== undefined) attributes["db.query.summary"] = summary
	return { name: summary ?? system, attributes }
}

// `error.type` is the failure's class: a DatabaseError's reason, else its tag.
const annotateErrorType = (error: unknown): Effect.Effect<void> => {
	const reason =
		typeof error === "object" && error !== null
			? "reason" in error && typeof error.reason === "string"
				? error.reason
				: "_tag" in error && typeof error._tag === "string"
					? error._tag
					: undefined
			: undefined
	return reason === undefined ? Effect.void : Effect.annotateCurrentSpan("error.type", reason)
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
			Effect.tapError(annotateErrorType),
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
					Stream.tapError((error: E) => annotateErrorType(error)),
					Stream.withSpan(name, { kind: "client", attributes }),
				),
			)
		}),
	)
