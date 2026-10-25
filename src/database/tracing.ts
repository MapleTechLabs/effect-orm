// One client span per statement, named and attributed the way the OpenTelemetry
// database semantic conventions describe:
// https://opentelemetry.io/docs/specs/semconv/database/database-spans/
//
// Effect's own `sql.execute` span still runs inside it with the query text, but
// it cannot carry these: it names the operation after the client method
// (`execute`), and only a compiled query knows its table.
import { Cause, Clock, Context, Effect, Exit, Redacted } from "effect"
import type { CompiledQuery, TenantScope } from "../ch/compile"
import type { Dialect } from "../ch/dialect"

/** What the spans read off a statement. A `CompiledQuery` has all of it. */
export type TracedStatement = { readonly sql: string } & Partial<
	Pick<CompiledQuery<unknown>, "kind" | "collection" | "parameters" | "sensitiveParameters" | "tenantScope" | "route">
>

/**
 * One statement, reported by `observeExit` once it has ended. Values given as
 * `Redacted` stay `Redacted` in `parameters`, so a log of them shows
 * `<redacted>`.
 */
export interface StatementObservation {
	readonly sql: string
	readonly parameters: ReadonlyArray<unknown>
	/** `db.system.name`: `postgresql`, `clickhouse`. */
	readonly system: string
	/** `db.operation.name`: `SELECT`, `INSERT`, `UPDATE`, `DELETE`. Absent for `sql\`...\``. */
	readonly operation?: string
	/** `db.collection.name`: the table, when there is one. */
	readonly collection?: string
	/** `db.query.summary`, which is also the span name. */
	readonly summary?: string
	/** A compiled query's tenant scope. Absent for `sql\`...\``. */
	readonly tenantScope?: TenantScope
	/** A compiled query's `route`, when it has one. */
	readonly route?: string
	/** From just before the statement is sent until its result is back. */
	readonly durationMillis: number
	/** The rows it returned. Absent for `execute`, which discards them. */
	readonly rows?: number
	/** `error.type` when the statement failed: a `DatabaseError` reason, else the error's tag. */
	readonly errorType?: string
}

/** What `traceStatement` does besides the span: from `FromSqlClientOptions`. */
export interface TraceOptions {
	readonly spanParameters?: boolean | undefined
	readonly observeExit?: ((observation: StatementObservation) => Effect.Effect<void>) | undefined
}

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

/** `error.type` of a failure: a DatabaseError's reason, else its tag. */
const errorTypeOf = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null
		? "reason" in error && typeof error.reason === "string"
			? error.reason
			: "_tag" in error && typeof error._tag === "string"
				? error._tag
				: undefined
		: undefined

/** The `error.type` of an exit that is not a success. */
const exitErrorType = (cause: Cause.Cause<unknown>): string => {
	const failure = Cause.findErrorOption(cause)
	if (failure._tag === "Some") return errorTypeOf(failure.value) ?? "_OTHER"
	if (Cause.hasInterruptsOnly(cause)) return "Interrupted"
	const defect = Cause.findDefect(cause)
	return (defect._tag === "Success" ? errorTypeOf(defect.success) : undefined) ?? "_OTHER"
}

/** The parameters with every sensitive one wrapped back in `Redacted`. */
const redactedParameters = (statement: TracedStatement): ReadonlyArray<unknown> => {
	const parameters = statement.parameters ?? []
	const sensitive = statement.sensitiveParameters
	if (sensitive === undefined || sensitive.length === 0) return parameters
	const marked = new Set(sensitive)
	return parameters.map((value, index) => (marked.has(index) ? Redacted.make(value) : value))
}

/** A parameter as a span attribute value: a string, as the conventions ask. */
const parameterText = (value: unknown): string => {
	if (Redacted.isRedacted(value)) return "<redacted>"
	if (typeof value === "string") return value
	if (typeof value === "object" && value !== null) {
		try {
			return JSON.stringify(value)
		} catch {
			return String(value)
		}
	}
	return String(value)
}

/**
 * Runs `effect`, which sends `statement`, in its client span. The span name is
 * the summary when there is one, then `{operation} {table}`, then the system.
 * `rowsOf` reads `db.response.returned_rows` from the result, when it has rows.
 * With `spanParameters` the span carries `db.query.parameter.<index>`, with
 * sensitive values as `<redacted>`; `observeExit` hears of the statement when
 * it ends.
 */
export const traceStatement = <A, E, R>(
	dialect: Dialect,
	statement: TracedStatement,
	effect: Effect.Effect<A, E, R>,
	rowsOf?: (result: A) => number,
	options: TraceOptions = {},
): Effect.Effect<A, E, R> =>
	Effect.withFiber((fiber) => {
		const configured = fiber.getRef(QuerySummary)
		const system = SYSTEM_NAMES[dialect.name] ?? dialect.name
		const operation = statement.kind === undefined ? undefined : OPERATIONS[statement.kind]
		const summary =
			configured ?? (operation === undefined ? undefined : statement.collection === undefined ? operation : `${operation} ${statement.collection}`)
		const attributes: Record<string, unknown> = { "db.system.name": system }
		if (operation !== undefined) attributes["db.operation.name"] = operation
		if (statement.collection !== undefined) attributes["db.collection.name"] = statement.collection
		if (summary !== undefined) attributes["db.query.summary"] = summary
		if (options.spanParameters === true) {
			redactedParameters(statement).forEach((value, index) => {
				attributes[`db.query.parameter.${index}`] = parameterText(value)
			})
		}
		const traced = effect.pipe(
			Effect.tap((result) =>
				rowsOf === undefined ? Effect.void : Effect.annotateCurrentSpan("db.response.returned_rows", rowsOf(result)),
			),
			Effect.tapError((error) => {
				const reason = errorTypeOf(error)
				return reason === undefined ? Effect.void : Effect.annotateCurrentSpan("error.type", reason)
			}),
		)
		const { observeExit } = options
		const observed =
			observeExit === undefined
				? traced
				: Effect.flatMap(Clock.currentTimeNanos, (start) =>
						Effect.onExit(traced, (exit) =>
							Effect.flatMap(Clock.currentTimeNanos, (end) =>
								observeExit({
									sql: statement.sql,
									parameters: redactedParameters(statement),
									system,
									...(operation !== undefined && { operation }),
									...(statement.collection !== undefined && { collection: statement.collection }),
									...(summary !== undefined && { summary }),
									...(statement.tenantScope !== undefined && { tenantScope: statement.tenantScope }),
									...(typeof statement.route === "string" && { route: statement.route }),
									durationMillis: Number(end - start) / 1_000_000,
									...(Exit.isSuccess(exit)
										? rowsOf === undefined
											? undefined
											: { rows: rowsOf(exit.value) }
										: { errorType: exitErrorType(exit.cause) }),
								}),
							),
						),
					)
		return Effect.withSpan(observed, summary ?? system, { kind: "client", attributes })
	})
