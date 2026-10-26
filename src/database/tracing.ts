// One client span per statement, named and attributed the way the OpenTelemetry
// database semantic conventions describe:
// https://opentelemetry.io/docs/specs/semconv/database/database-spans/
//
// It is the only span a statement gets: it carries the query text, so the SQL
// driver's own span (named after the database, not the operation, and blind to
// the table) runs untraced unless `driverSpans` asks for it.
import { Context, Effect } from "effect"
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
		const configured = fiber.getRef(QuerySummary)
		const system = SYSTEM_NAMES[dialect.name] ?? dialect.name
		const operation = statement.kind === undefined ? undefined : OPERATIONS[statement.kind]
		const summary =
			configured ?? (operation === undefined ? undefined : statement.collection === undefined ? operation : `${operation} ${statement.collection}`)
		const attributes: Record<string, unknown> = { "db.system.name": system, "db.query.text": statement.sql }
		if (operation !== undefined) attributes["db.operation.name"] = operation
		if (statement.collection !== undefined) attributes["db.collection.name"] = statement.collection
		if (summary !== undefined) attributes["db.query.summary"] = summary
		return effect.pipe(
			Effect.tap((result) =>
				rowsOf === undefined ? Effect.void : Effect.annotateCurrentSpan("db.response.returned_rows", rowsOf(result)),
			),
			// `error.type` is the failure's class: a DatabaseError's reason, else its tag.
			// `db.response.status_code` is the SQLSTATE, when the server sent one.
			Effect.tapError((error) => {
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
			}),
			Effect.withSpan(summary ?? system, { kind: "client", attributes }),
		)
	})
