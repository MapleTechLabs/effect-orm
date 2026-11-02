// One client span per statement, named and attributed the way the OpenTelemetry
// database semantic conventions describe:
// https://opentelemetry.io/docs/specs/semconv/database/database-spans/
//
// It is the only span a statement gets: it carries the query text, so the SQL
// driver's own span (named after the database, not the operation, and blind to
// the table) runs untraced unless `driverSpans` asks for it.
import { Cause, Clock, Context, Effect, Exit, Redacted, Stream } from "effect"
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
	/** `db.operation.name`: `SELECT`, `INSERT`, `UPDATE`, `DELETE`; for `sql\`...\``, its first word. */
	readonly operation?: string
	/** `db.collection.name`: the table, when there is one; for `sql\`...\``, the first one it names. */
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

/** What a statement's span and observation are named by, given the summary in context. */
interface Described {
	readonly system: string
	readonly operation?: string | undefined
	readonly collection?: string | undefined
	readonly summary?: string | undefined
}

const describe = (dialect: Dialect, statement: TracedStatement, configured: string | undefined): Described => {
	const { operation, collection } = describeStatement(statement)
	return {
		system: SYSTEM_NAMES[dialect.name] ?? dialect.name,
		operation,
		collection,
		summary: configured ?? (operation === undefined ? undefined : collection === undefined ? operation : `${operation} ${collection}`),
	}
}

// The span name and attributes for `statement`.
const spanOf = (statement: TracedStatement, described: Described, options: TraceOptions) => {
	const { system, operation, collection, summary } = described
	const attributes: Record<string, unknown> = { "db.system.name": system, "db.query.text": statement.sql }
	if (operation !== undefined) attributes["db.operation.name"] = operation
	if (collection !== undefined) attributes["db.collection.name"] = collection
	if (summary !== undefined) attributes["db.query.summary"] = summary
	if (options.spanParameters === true) {
		redactedParameters(statement).forEach((value, index) => {
			attributes[`db.query.parameter.${index}`] = parameterText(value)
		})
	}
	return { name: summary ?? system, attributes }
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

// `error.type` is the failure's class; `db.response.status_code` is the
// SQLSTATE, when the server sent one.
const annotateFailure = (error: unknown): Effect.Effect<void> => {
	const sqlState =
		typeof error === "object" && error !== null && "sqlState" in error && typeof error.sqlState === "string"
			? error.sqlState
			: undefined
	const reason = errorTypeOf(error)
	const failure: Record<string, unknown> = {}
	if (reason !== undefined) failure["error.type"] = reason
	if (sqlState !== undefined) failure["db.response.status_code"] = sqlState
	return Effect.annotateCurrentSpan(failure)
}

/** The observation of a statement that ran from `start` and ended with `exit`. */
const observe = (
	options: TraceOptions,
	statement: TracedStatement,
	described: Described,
	start: bigint,
	exit: Exit.Exit<unknown, unknown>,
	rows: number | undefined,
): Effect.Effect<void> => {
	const { observeExit } = options
	if (observeExit === undefined) return Effect.void
	const { system, operation, collection, summary } = described
	return Effect.flatMap(Clock.currentTimeNanos, (end) =>
		observeExit({
			sql: statement.sql,
			parameters: redactedParameters(statement),
			system,
			...(operation !== undefined && { operation }),
			...(collection !== undefined && { collection }),
			...(summary !== undefined && { summary }),
			...(statement.tenantScope !== undefined && { tenantScope: statement.tenantScope }),
			...(typeof statement.route === "string" && { route: statement.route }),
			durationMillis: Number(end - start) / 1_000_000,
			...(Exit.isSuccess(exit) ? (rows === undefined ? undefined : { rows }) : { errorType: exitErrorType(exit.cause) }),
		}),
	)
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
		const described = describe(dialect, statement, fiber.getRef(QuerySummary))
		const { name, attributes } = spanOf(statement, described, options)
		const traced = effect.pipe(
			Effect.tap((result) =>
				rowsOf === undefined ? Effect.void : Effect.annotateCurrentSpan("db.response.returned_rows", rowsOf(result)),
			),
			Effect.tapError(annotateFailure),
		)
		const observed =
			options.observeExit === undefined
				? traced
				: Effect.flatMap(Clock.currentTimeNanos, (start) =>
						Effect.onExit(traced, (exit) =>
							observe(options, statement, described, start, exit, Exit.isSuccess(exit) && rowsOf !== undefined ? rowsOf(exit.value) : undefined),
						),
					)
		return Effect.withSpan(observed, name, { kind: "client", attributes })
	})

/**
 * `traceStatement` for a stream of rows: one client span from the first pull
 * to the end, with `db.response.returned_rows` the rows it emitted, and one
 * observation when the stream ends.
 */
export const traceStream = <A, E, R>(
	dialect: Dialect,
	statement: TracedStatement,
	stream: Stream.Stream<A, E, R>,
	options: TraceOptions = {},
): Stream.Stream<A, E, R> =>
	Stream.unwrap(
		Effect.withFiber((fiber) => {
			const described = describe(dialect, statement, fiber.getRef(QuerySummary))
			const { name, attributes } = spanOf(statement, described, options)
			// Counted per run: the effect `unwrap` takes runs each time the stream does.
			let returned = 0
			return Effect.map(Clock.currentTimeNanos, (start) =>
				stream.pipe(
					Stream.tap(() =>
						Effect.sync(() => {
							returned++
						}),
					),
					Stream.onEnd(Effect.suspend(() => Effect.annotateCurrentSpan("db.response.returned_rows", returned))),
					Stream.tapError((error: E) => annotateFailure(error)),
					Stream.onExit((exit) => observe(options, statement, described, start, exit, Exit.isSuccess(exit) ? returned : undefined)),
					Stream.withSpan(name, { kind: "client", attributes }),
				),
			)
		}),
	)
