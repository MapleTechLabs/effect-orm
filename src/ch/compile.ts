// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
// Query Compilation
//
// Compiles a CHQuery + params into a SQL string by:
// 1. Creating a ColumnAccessor proxy for the table (+ joined tables)
// 2. Evaluating the selectFn to get aliased SqlFragments
// 3. Evaluating the whereFn (with params resolved) to get Conditions
// 4. Assembling into SqlQuery and calling the existing compileQuery()

import { custom, dateTime, dateTime64, type CHType, type ColumnDefs } from "./types"
import type { CHQuery, CHQueryState, NeedsSelect } from "./query"
import type { CHUnionQuery } from "./union"
import { isInsert, type CHInsert } from "./insert"
import { isDelete, isUpdate, type CHDelete, type CHUpdate } from "./update"
import type { Table } from "./table"
import { createColumnAccessor, createQualifiedColumnAccessor, createJoinedColumnAccessor, sourceAlias } from "./query"
import { aliased, columnTypeOf, isExprLike, type Expr } from "./expr"
import { raw, identPath, quoteIdent, quoteIdentPath, compile as compileSqlFragment } from "../sql/sql-fragment"
import { splitTerminalClauses } from "../sql/terminal-clauses"
import { compileQuery, type SqlQuery } from "../sql/sql-query"
import { PARAM_MARKER_PREFIX, PARAM_PLACEHOLDER_PATTERN, param, paramSchema, type ParamKind } from "./param"
import { mergeResultSchemas } from "./define-fn"
import { encodeValue } from "./literal"
import { checkedLiteral, clickhouseDialect, currentDialect, withDialect, type Dialect } from "./dialect"
import { Effect, Option, Schema } from "effect"
import { QueryBuilderDefect, QueryBuilderError } from "./errors"
import { withSubqueryCompiler } from "./subquery-context"
import { tenantBoundOf, tenantColumnOf, tenantPredicatesOf, withTenantBound, type TenantPredicate } from "./tenant"

// `QueryBuilderError` moved to ./errors so `expr.ts` can raise it too; still
// exported from here, which is where every caller imports it from.
export { QueryBuilderError } from "./errors"

export class CompiledQueryDecodeError extends Schema.TaggedError<CompiledQueryDecodeError>()(
	"@maple-dev/effect-orm/CompiledQueryDecodeError",
	{
		message: Schema.String,
		rowIndex: Schema.Number,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

export class CompiledQueryEncodeError extends Schema.TaggedError<CompiledQueryEncodeError>()(
	"@maple-dev/effect-orm/CompiledQueryEncodeError",
	{
		message: Schema.String,
		rowIndex: Schema.Number,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

/** `FOR UPDATE SKIP LOCKED` and the like, refused where the dialect has no locking. */
const lockClause = (lock: import("./query").LockClause | undefined): string | undefined => {
	if (lock === undefined) return undefined
	const dialect = currentDialect()
	if (dialect.clauses.locking !== true) {
		throw new QueryBuilderDefect({
			message: `CHQuery: FOR ${lock.strength} has no meaning for the ${dialect.name} dialect, which has no row locks`,
		})
	}
	if (lock.skipLocked === true && lock.noWait === true) {
		throw new QueryBuilderDefect({ message: "CHQuery: a lock takes skipLocked or noWait, not both" })
	}
	// Postgres takes only unqualified names here, so `public.jobs` is refused, not quoted.
	for (const name of lock.of ?? []) {
		if (name.includes(".")) {
			throw new QueryBuilderDefect({
				message: `CHQuery: FOR ${lock.strength} OF ${JSON.stringify(name)}: name the table by its alias or unqualified name`,
			})
		}
	}
	const of = lock.of !== undefined && lock.of.length > 0 ? ` OF ${lock.of.map(quoteIdent).join(", ")}` : ""
	const wait = lock.skipLocked === true ? " SKIP LOCKED" : lock.noWait === true ? " NOWAIT" : ""
	return `FOR ${lock.strength}${of}${wait}`
}

/** `orderBy` takes `[column, direction]` tuples. A bare string is the natural
 *  mistake (`.orderBy("count", "desc")`), and it is invisible without types:
 *  destructuring a string yields its first two characters, so `"count"` used to
 *  compile to `count -> "c O"`. Fail loudly instead of emitting invalid SQL —
 *  as a defect, because the specs are written at the query definition and no
 *  runtime value can steer them. */
const orderByClause = (specs: ReadonlyArray<[string, "asc" | "desc"]>): Array<string> =>
	specs.map((spec) => {
		if (!Array.isArray(spec) || spec.length !== 2) {
			throw new QueryBuilderDefect({
				message: `CHQuery: orderBy() takes [column, direction] tuples, got ${JSON.stringify(spec)}`,
			})
		}
		const [column, direction] = spec
		if (direction !== "asc" && direction !== "desc") {
			throw new QueryBuilderDefect({
				message: `CHQuery: orderBy() direction must be "asc" or "desc", got ${JSON.stringify(direction)}`,
			})
		}
		return `${quoteIdent(column)} ${direction.toUpperCase()}`
	})

/**
 * A `limit` / `offset` value. It often comes from a request (a page size), so a
 * bad one is a failure, not a defect: `LIMIT -1` or `LIMIT NaN` is not SQL, and
 * rounding `1.5` would quietly change the page.
 */
const rowCount = (clause: "limit" | "offset", value: number | undefined) => {
	if (value == null) return undefined
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new QueryBuilderError({
			code: "InvalidArguments",
			message: `${clause}(${value}): expected a non-negative integer`,
		})
	}
	return raw(String(value))
}

/**
 * A `groupBy` key: the select alias where the dialect resolves aliases there,
 * otherwise the selected column's position. Postgres reads a bare name in
 * GROUP BY as an input column first, so `select({ Service: lower(…) })` grouped
 * by `"Service"` would group by the raw column; `GROUP BY 1` cannot be misread.
 */
const groupByKey = (key: string, selected: ReadonlyArray<string>): string => {
	const position = selected.indexOf(key)
	return currentDialect().clauses.groupByAlias || position === -1 ? quoteIdent(key) : String(position + 1)
}

/** `.format()`'s value, refused for a dialect that has no `FORMAT` clause:
 *  dropping it would hand the caller rows in a shape they did not ask for. A
 *  defect, because the format is written in the query definition. */
const formatClause = (format: string | undefined): string | undefined => {
	if (format === undefined) return undefined
	const dialect = currentDialect()
	if (!dialect.clauses.format) {
		throw new QueryBuilderDefect({
			message: `CHQuery: format(${JSON.stringify(format)}) has no meaning for the ${dialect.name} dialect, which has no FORMAT clause`,
		})
	}
	return format
}

// CompiledQuery — bundles the SQL string with its output type so consumers
// never need to cast manually.

/**
 * How widely a compiled query reads across tenants.
 *
 * `"single-tenant"` means every tenanted source is confined to the same
 * tenant through constant bindings, tenant-key equalities, or scoped subqueries.
 * `"cross-tenant"` means a source has a tenant column
 * and this query did not pin it, so the read spans every tenant the credentials
 * can see. Executors are expected to refuse `"cross-tenant"` on their normal
 * read path and require an explicit privileged entry point instead — which is
 * why this is a derived fact on the compiled query rather than a convention in
 * a doc comment.
 *
 * `"untenanted"` is the third, different fact: the sources declare no
 * `tenantColumn` at all, so there is no row-level tenancy to pin and none to
 * leak. A dimension or lookup table is the usual case. It is deliberately not
 * folded into `"cross-tenant"` — an executor that refuses cross-tenant reads
 * would otherwise refuse every query over such a table, and "reads every
 * tenant" and "has no tenants" are not the same thing to audit.
 */
export type TenantScope = "single-tenant" | "cross-tenant" | "untenanted"

/** A CTE after its body is SQL and its scope is known. */
interface ResolvedCte {
	readonly name: string
	readonly sql: string
	readonly tenantScope: TenantScope | undefined
	readonly tenantBound?: string
}

interface CompiledQueryBase<Output> {
	readonly sql: string
	/**
	 * What the statement does. An `insert` without RETURNING sends back no rows,
	 * so an executor runs it the way it runs DDL (`Database.run` does), not
	 * through a client path that expects a result set.
	 */
	readonly kind: "select" | "insert" | "update" | "delete"
	/**
	 * The aliases of a write's RETURNING list, when it has one. A write
	 * without it sends back no rows; one with it is read like a query.
	 */
	readonly returning?: ReadonlyArray<string>
	/**
	 * The values a binding dialect sends beside `sql`, in placeholder order.
	 *
	 * Empty when the dialect writes params into the SQL as literals, which is
	 * what ClickHouse (the default) does.
	 */
	readonly parameters: ReadonlyArray<unknown>
	readonly tenantScope: TenantScope
	/**
	 * Where the query's row schema came from, or `"none"` if it has none.
	 *
	 * Lets a catalog sweep see the queries that decode nothing — a missing
	 * schema is otherwise invisible, because `decodeRows` degrades to an
	 * identity cast.
	 *
	 * `"derived"` is the normal case: every selected expression knew its own
	 * column type, so the row schema is the SELECT. `"declared"` means a caller
	 * passed one, which also lets it *narrow* what the builder inferred.
	 * `"none"` means at least one selected expression had no type to read —
	 * a `rawExpr`, a `dynamicColumn`, or an un-annotated custom function — and
	 * nothing validates the rows.
	 */
	readonly rowSchemaSource: "declared" | "derived" | "none"
	/**
	 * The selected aliases that had no type to read, when `rowSchemaSource` is
	 * `"none"`. Empty otherwise.
	 *
	 * Derivation is all-or-nothing — one untyped field means the builder cannot
	 * describe the row — so "this query decodes nothing" is otherwise a dead end
	 * for whoever has to fix it. This names the columns to type.
	 */
	readonly untypedColumns: ReadonlyArray<string>
	/**
	 * How a *declared* row schema disagrees with the SELECT, when it does.
	 *
	 * A declared schema replaces the derived one wholesale, which is what makes
	 * narrowing possible — and what makes drift invisible: a schema that has
	 * fallen behind the query it describes still decodes, silently dropping the
	 * columns it forgot and demanding ones the SELECT no longer emits. The
	 * builder knows both shapes at compile time, so it says so here rather than
	 * discarding the one it inferred.
	 *
	 * `undefined` when there is nothing to compare — no declared schema, or a
	 * SELECT with an untyped expression, where derivation is all-or-nothing —
	 * and when the two agree. Only field *names* are compared: a declared schema
	 * narrowing a column's type is the legitimate use, not drift.
	 */
	readonly rowSchemaMismatch: RowSchemaMismatch | undefined
	/**
	 * Why this query is handwritten SQL, when it is — set only by
	 * {@link rawCompiledQuery}, absent for a query the builder produced.
	 *
	 * On the compiled query rather than only at the call site, because that is
	 * what makes the reason auditable: a catalog sweep can count the handwritten
	 * queries and group them by reason, and an executor can log which one it is
	 * about to run. A required argument that nothing stores is a gate only a
	 * human reviewer can see.
	 */
	readonly rawSql?: { readonly reason: string; readonly justification: string }
	/**
	 * The `name` of the dialect the query was compiled for (`clickhouse`,
	 * `postgres`). Absent for handwritten SQL that did not say.
	 *
	 * Lets an executor refuse a query compiled for another database, the usual
	 * cause being the root `compile` (ClickHouse) where the Postgres one was
	 * meant: the SQL may even run, with ClickHouse quoting and inlined params.
	 */
	readonly dialect?: string
	/** Runtime decode of raw query results. Queries built from handwritten SQL
	 *  should provide a row schema so schema drift is caught before consumers
	 *  read fields from `Record<string, unknown>`. Without a schema this is an
	 *  identity cast — there is deliberately no separate `castRows`: a cast that
	 *  looked type-safe hid wire-format drift (64-bit ints arriving as strings). */
	readonly decodeRows: (
		rows: ReadonlyArray<Record<string, unknown>>,
	) => Effect.Effect<ReadonlyArray<Output>, CompiledQueryDecodeError>
	/** Runtime decode of only the first row, returned as an Option so callers
	 *  don't need to hand-roll `rows[0] ?? null` at every point lookup. */
	readonly decodeFirstRow: (
		rows: ReadonlyArray<Record<string, unknown>>,
	) => Effect.Effect<Option.Option<Output>, CompiledQueryDecodeError>
	/**
	 * The row codec itself, when the query has one.
	 *
	 * `decodeRows` / `encodeRows` are the two directions as functions; this is
	 * the thing they are built from, for the callers that need a `Schema` rather
	 * than a call — a cache that round-trips values through JSON, a boundary that
	 * composes it into a larger schema. Without it those callers have to
	 * re-declare by hand the shape the builder already knows.
	 */
	readonly rowSchema: CompiledQueryRowSchema<Output> | undefined
	/**
	 * The other direction: decoded rows back to the wire shape ClickHouse sent.
	 *
	 * The row schema is a codec, so it runs backwards for free — and running it
	 * backwards is what lets a surface hold the *good* value in memory and still
	 * emit the byte-for-byte shape its own clients parse. A `DateTime` column
	 * decoded to a `DateTime.Utc` re-encodes to `'YYYY-MM-DD hh:mm:ss'`, not to
	 * ISO-8601, because that is what the column's codec says the wire form is.
	 *
	 * Without this, keeping a wire byte-stable means never parsing it — which is
	 * what `T.dateTimeString` is for, and why it exists. A query whose row schema
	 * is `"none"` has no codec to reverse, so this returns the rows unchanged —
	 * the same contract `decodeRows` has.
	 */
	// Method syntax, not a property with a function type, and deliberately:
	// `Output` in a parameter position would make `CompiledQuery<Output>`
	// invariant, and a builder that returns one of two row shapes for the same
	// logical query — the usage query and its compare variant — could no longer
	// be assigned to the wider of them. Method parameters stay bivariant.
	encodeRows(
		rows: ReadonlyArray<Output>,
	): Effect.Effect<ReadonlyArray<Record<string, unknown>>, CompiledQueryEncodeError>
}

/**
 * Route is a type-level fact as well as runtime metadata, so a query tagged
 * for one backend cannot be passed accidentally to an API that reads from
 * another.
 */
export type CompiledQuery<
	Output,
	Route extends string | undefined = string | undefined,
> = CompiledQueryBase<Output> &
	(Route extends string ? { readonly route: Route } : { readonly route?: undefined })

/**
 * A query's row codec.
 *
 * Pinned to a service-free codec, not left as `Schema.Schema<Output>`: rows
 * arrive from a socket with nothing to provide, so a schema that needs a
 * service to decode could never run here. Saying so is what lets `decodeRows`
 * and `encodeRows` build their decoders without casting the services away —
 * the cost is that a caller assembling one out of generic `Schema.Struct.Fields`
 * has to carry the same constraint on its own type parameter.
 */
export type CompiledQueryRowSchema<Output> = Schema.Codec<Output, unknown, never, never>

/**
 * A compiled query, or the unrun compile that produces one.
 *
 * `compile` reports in the Effect channel, so an executor accepting this in
 * place of a `CompiledQuery` becomes the single place that decides what a
 * `QueryBuilderError` means — instead of every call site deciding again on the
 * way in, which is how a codebase ends up with one `Effect.orDie` per query.
 */
export type CompiledQueryInput<Output, Routing extends string | undefined = string | undefined> =
	| CompiledQuery<Output, Routing>
	| Effect.Effect<CompiledQuery<Output, Routing>, QueryBuilderError>

/**
 * A declared row schema's field names against the ones the SELECT emits.
 *
 * Both directions matter and they fail differently: an `undeclared` column is a
 * value the query produces and nothing validates, while an `unselected` field
 * is one the declared schema insists on and the query cannot supply — the
 * second decodes as a hard `ParseError` the first time it runs.
 */
export interface RowSchemaMismatch {
	/** Selected aliases the declared schema does not describe. */
	readonly undeclared: ReadonlyArray<string>
	/** Declared fields the SELECT does not emit. */
	readonly unselected: ReadonlyArray<string>
}

/** The field names of a struct codec, or `undefined` if it is not one. */
const structFieldNames = (schema: unknown): ReadonlyArray<string> | undefined => {
	const ast = (schema as { readonly ast?: { readonly _tag?: string } } | undefined)?.ast
	if (ast?._tag !== "Objects") return undefined
	const signatures = (
		ast as { readonly propertySignatures?: ReadonlyArray<{ readonly name: PropertyKey }> }
	).propertySignatures
	return signatures?.map((signature) => String(signature.name))
}

/**
 * Compare a declared schema against the derived one by field name.
 *
 * Silent — `undefined` — unless both are structs and the names differ. A
 * declared schema that is not a struct (a codec wrapping one, a union) has no
 * field list to read, and inventing a complaint from that would make the gate
 * built on this untrustworthy.
 */
const compareRowSchemas = (declared: unknown, derived: unknown): RowSchemaMismatch | undefined => {
	const declaredNames = structFieldNames(declared)
	const derivedNames = structFieldNames(derived)
	if (declaredNames === undefined || derivedNames === undefined) return undefined

	const declaredSet = new Set(declaredNames)
	const derivedSet = new Set(derivedNames)
	const undeclared = derivedNames.filter((name) => !declaredSet.has(name))
	const unselected = declaredNames.filter((name) => !derivedSet.has(name))
	return undeclared.length === 0 && unselected.length === 0 ? undefined : { undeclared, unselected }
}

const makeCompiledQuery = <Output, Route extends string | undefined>(
	sql: string,
	parameters: ReadonlyArray<unknown>,
	tenantScope: TenantScope,
	rowSchemaSource: "declared" | "derived" | "none",
	/** Built on first decode: a derived schema costs a `Schema.Struct` per
	 *  compile otherwise, and most compiled queries are never decoded. */
	getRowSchema: (() => CompiledQueryRowSchema<Output> | undefined) | undefined,
	route?: Route,
	untypedColumns: ReadonlyArray<string> = [],
	rawSql?: { readonly reason: string; readonly justification: string },
	rowSchemaMismatch?: RowSchemaMismatch,
	dialect?: string,
	kind: CompiledQueryBase<Output>["kind"] = "select",
	returning?: ReadonlyArray<string>,
): CompiledQuery<Output, Route> => {
	let cachedDecodeRow: ((row: unknown) => Effect.Effect<Output, unknown, never>) | undefined
	let decoderBuilt = false
	const decodeRow = () => {
		if (!decoderBuilt) {
			decoderBuilt = true
			const rowSchema = getRowSchema?.()
			cachedDecodeRow = rowSchema ? Schema.decodeUnknownEffect(rowSchema) : undefined
		}
		return cachedDecodeRow
	}

	const decodeRows: CompiledQueryBase<Output>["decodeRows"] = (rows) => {
		const decode = decodeRow()
		if (!decode) return Effect.succeed(rows as ReadonlyArray<Output>)

		return Effect.forEach(rows, (row, index) =>
			decode(row).pipe(
				Effect.mapError(
					(cause) =>
						new CompiledQueryDecodeError({
							message: `Compiled query row ${index} did not match its declared output schema`,
							rowIndex: index,
							cause,
						}),
				),
			),
		).pipe(Effect.map((decodedRows) => decodedRows as ReadonlyArray<Output>))
	}

	let cachedEncodeRow: ((row: Output) => Effect.Effect<unknown, unknown, never>) | undefined
	let encoderBuilt = false
	const encodeRow = () => {
		if (!encoderBuilt) {
			encoderBuilt = true
			const rowSchema = getRowSchema?.()
			cachedEncodeRow = rowSchema ? Schema.encodeUnknownEffect(rowSchema) : undefined
		}
		return cachedEncodeRow
	}

	const encodeRows: CompiledQueryBase<Output>["encodeRows"] = (rows) => {
		const encode = encodeRow()
		if (!encode) return Effect.succeed(rows as ReadonlyArray<Record<string, unknown>>)

		return Effect.forEach(rows, (row, index) =>
			encode(row).pipe(
				Effect.mapError(
					(cause) =>
						new CompiledQueryEncodeError({
							message: `Compiled query row ${index} could not be encoded to its wire shape`,
							rowIndex: index,
							cause,
						}),
				),
			),
		).pipe(Effect.map((encoded) => encoded as ReadonlyArray<Record<string, unknown>>))
	}

	return {
		sql,
		kind,
		...(returning !== undefined ? { returning } : undefined),
		parameters,
		tenantScope,
		// Resolved eagerly only here, where the getter is already memoised by
		// `decodeRow`/`encodeRow` below; reading it does not build a second one.
		get rowSchema() {
			return getRowSchema?.()
		},
		rowSchemaSource,
		untypedColumns: rowSchemaSource === "none" ? untypedColumns : [],
		rowSchemaMismatch,
		...(rawSql !== undefined ? { rawSql } : undefined),
		...(dialect !== undefined ? { dialect } : undefined),
		...(!(route === undefined) ? { route } : undefined),
		decodeRows,
		encodeRows,
		decodeFirstRow: (rows) => {
			const row = rows[0]
			if (row == null) return Effect.succeed(Option.none<Output>())
			const decode = decodeRow()
			if (!decode) return Effect.succeed(Option.some(row as Output))

			return decode(row).pipe(
				Effect.map(Option.some),
				Effect.mapError(
					(cause) =>
						new CompiledQueryDecodeError({
							message: "Compiled query row 0 did not match its declared output schema",
							rowIndex: 0,
							cause,
						}),
				),
			)
		},
	} as CompiledQuery<Output, Route>
}

/**
 * Explicit constructor for SQL that cannot be expressed through the typed DSL.
 *
 * Prefer `compile(CH.from(...))`. `tenantScope` here is taken at face value —
 * there is no query AST to inspect, only a string — which is exactly why this
 * is the one place tenant scope can be *asserted* rather than derived, and why
 * every use has to name a `reason` and say why in a `justification`.
 *
 * DDL, migrations, and another engine's file formats don't reach this function
 * at all; they never produce a `CompiledQuery`.
 */
export const rawCompiledQuery = <
	Output,
	Route extends string | undefined = undefined,
	Reason extends string = string,
>(args: {
	readonly sql: string
	readonly tenantScope: TenantScope
	readonly reason: Reason
	/** One sentence, at the call site, on why this instance qualifies. */
	readonly justification: string
	readonly rowSchema?: CompiledQueryRowSchema<Output>
	readonly route?: Route
	/** The `name` of the dialect the SQL is written for, so an executor can check it. */
	readonly dialect?: string
	/** `insert`, `update` or `delete` for a write that returns no rows. Default `select`. */
	readonly kind?: "select" | "insert" | "update" | "delete"
}): CompiledQuery<Output, Route> =>
	makeCompiledQuery(
		args.sql,
		[],
		args.tenantScope,
		args.rowSchema === undefined ? "none" : "declared",
		() => args.rowSchema,
		args.route,
		[],
		{ reason: args.reason, justification: args.justification },
		undefined,
		args.dialect,
		args.kind,
	)

/**
 * A thrown `QueryBuilderError` as a typed failure.
 *
 * Compilation reads values it cannot check earlier — the params bag, whatever a
 * caller compared a column against — so a missing param or an unencodable value
 * is an expected failure, not a bug. Anything else that escapes is a bug and
 * stays a defect: catching it would turn a real crash into a value someone
 * pattern-matches on.
 */
interface UnexpectedCompileFailure {
	readonly _tag: "UnexpectedCompileFailure"
	readonly cause: unknown
}

const asEffect = <A>(compile: () => A): Effect.Effect<A, QueryBuilderError> =>
	Effect.try({
		try: compile,
		catch: (cause): QueryBuilderError | UnexpectedCompileFailure =>
			cause instanceof QueryBuilderError ? cause : { _tag: "UnexpectedCompileFailure" as const, cause },
		// `UnexpectedCompileFailure` is this builder's own "cannot happen" tag: a query
		// is built from typed definitions, so a compile that throws is a bug in this
		// file rather than a failure a call site could handle.
		// oxlint-disable-next-line maple/no-effect-die
	}).pipe(Effect.catchTag("UnexpectedCompileFailure", ({ cause }) => Effect.die(cause)))

/**
 * Compile a query, with failures in the error channel.
 *
 * The compile step used to throw. `QueryBuilderError` was already a
 * `Schema.TaggedError`, but a thrown one is a defect: a route could not
 * `catchTag` it, and a missing param reached production as an unhandled crash
 * rather than a typed 400. Use {@link compileCHUnsafe} where a throw is what you
 * want — a fixture that fails to compile should fail its test loudly.
 */
export function compileCH<
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
	Joins extends Record<string, ColumnDefs>,
	Route extends string | undefined,
	Params extends Record<string, any> = {},
	Decoded extends Output = Output,
>(
	query: CHQuery<Cols, Output, Joins, Route> & NeedsSelect<Output>,
	/** Values for the query's `param.*` markers. Optional when it has none. */
	params?: Params,
	options?: {
		skipFormat?: boolean
		rowSchema?: CompiledQueryRowSchema<Decoded>
		deferParams?: boolean
		dialect?: Dialect
	},
): Effect.Effect<CompiledQuery<Decoded, Route>, QueryBuilderError>
/** An INSERT, UPDATE or DELETE. `params` fills the `param.*` markers among its values. */
export function compileCH<Output>(
	insert: CHWrite<Output>,
	params?: Record<string, unknown>,
	options?: InsertCompileOptions,
): Effect.Effect<CompiledQuery<Output, undefined>, QueryBuilderError>
export function compileCH(
	query: CHQuery<any, any, any, any> | CHWrite<any>,
	params?: Record<string, unknown>,
	options?: any,
): Effect.Effect<CompiledQuery<any, any>, QueryBuilderError> {
	return asEffect(() => compileCHUnsafe(query as CHQuery<any, any, any, any>, params ?? {}, options))
}

/** A write statement: what `compile` takes besides a query. */
export type CHWrite<Output> = CHInsert<any, any, any, Output> | CHUpdate<any, any, Output> | CHDelete<any, Output>

/** What compiling a write takes: only the dialect. */
export interface InsertCompileOptions {
	readonly dialect?: Dialect
}

/** {@link compileCH} for a `UNION ALL`. */
export const compileUnion = <Output extends Record<string, any>, Params extends Record<string, any>>(
	union: CHUnionQuery<Output>,
	params: Params,
	options?: { rowSchema?: CompiledQueryRowSchema<Output>; deferParams?: boolean; dialect?: Dialect },
): Effect.Effect<CompiledQuery<Output, undefined>, QueryBuilderError> =>
	asEffect(() => compileUnionUnsafe(union, params, options))

export function compileCHUnsafe<
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
	Joins extends Record<string, ColumnDefs>,
	Route extends string | undefined,
	Params extends Record<string, any> = {},
	Decoded extends Output = Output,
>(
	query: CHQuery<Cols, Output, Joins, Route> & NeedsSelect<Output>,
	/** Values for the query's `param.*` markers. Optional when it has none. */
	params?: Params,
	options?: {
		skipFormat?: boolean
		rowSchema?: CompiledQueryRowSchema<Decoded>
		/** Leave `__PARAM_…__` placeholders in the SQL instead of resolving them.
		 *  For fragments spliced into a larger query — a subquery condition — whose
		 *  params are resolved by the outer compilation pass. */
		deferParams?: boolean
		/** How params reach the server. ClickHouse literals when omitted. */
		dialect?: Dialect
	},
): CompiledQuery<Decoded, Route>
/** An INSERT, UPDATE or DELETE. `params` fills the `param.*` markers among its values. */
export function compileCHUnsafe<Output>(
	insert: CHWrite<Output>,
	params?: Record<string, unknown>,
	options?: InsertCompileOptions,
): CompiledQuery<Output, undefined>
export function compileCHUnsafe(
	query: CHQuery<any, any, any, any> | CHWrite<any>,
	params?: Record<string, unknown>,
	options?: any,
): CompiledQuery<any, any> {
	return withDialect(options?.dialect ?? currentDialect(), () =>
		isInsert(query)
			? compileInsert(query, params ?? {})
			: isUpdate(query) || isDelete(query)
				? compileUpdateOrDelete(query, params ?? {})
				: compileInner(query as CHQuery<any, any, any, any>, params ?? {}, options),
	)
}

/**
 * The recursion behind {@link compileCHUnsafe}.
 *
 * Separate only so `enclosingCtes` — which `compile` sets for itself as it walks
 * a query's CTEs, and which no caller has any reason to pass — stays off the
 * published signature, along with the `ResolvedCte` shape it names.
 */
function compileInner<
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
	Joins extends Record<string, ColumnDefs>,
	Route extends string | undefined,
	Params extends Record<string, any>,
	// The row schema, not the SELECT inference, is what actually produces values
	// at runtime, so it decides the compiled query's output type. `extends Output`
	// keeps it honest: a schema may *narrow* what the builder inferred (a String
	// column decoded as a literal union) but never contradict it.
	Decoded extends Output = Output,
>(
	query: CHQuery<Cols, Output, Joins, Route>,
	params: Params,
	options?: {
		selectKeys?: ReadonlyArray<string>
		skipFormat?: boolean
		rowSchema?: CompiledQueryRowSchema<Decoded>
		/** Leave `__PARAM_…__` placeholders in the SQL instead of resolving them.
		 *  For fragments spliced into a larger query — a subquery condition — whose
		 *  params are resolved by the outer compilation pass. */
		deferParams?: boolean
		/**
		 * Set by a compile that splices this query's SQL into its own: the
		 * outer one resolves params once over the whole statement, which a
		 * dialect that numbers its placeholders depends on.
		 */
		nested?: boolean
		/**
		 * The tenant scopes of CTEs an enclosing query has already resolved.
		 *
		 * Set by `compile` itself as it walks a query's own CTEs, so a CTE that
		 * reads an earlier sibling — the usual `WITH a AS (…), b AS (SELECT … FROM a)`
		 * chain — inherits that sibling's scope instead of reading as
		 * `"cross-tenant"` because it names a table this compilation cannot see.
		 * FROM-subqueries and joins receive the same visible CTE scopes.
		 * There is no reason to pass it by hand.
		 */
		enclosingCtes?: ReadonlyArray<ResolvedCte>
	},
): CompiledQuery<Decoded, Route> {
	const state = query._state
	const deferParams = options?.deferParams === true

	// The one accessor factory — shared with `selectExprsOf`, which reads a
	// query's output schemas without compiling it. Building a second one here is
	// what silently dropped every joined and subquery column's type: this path
	// passed `state.columns` (empty for a `fromQuery`/`fromUnion`) and no join
	// columns at all, so `$.p.ServiceName` and `$.bucket` compiled to correct SQL
	// with no schema, and the query derived nothing.
	assertDistinctNames(state)
	const $ = makeAccessor(state)

	// SELECT
	const selectExprs = state.selectFn ? state.selectFn($) : {}
	const keys = Object.keys(selectExprs)
	if (
		options?.selectKeys &&
		(keys.length !== options.selectKeys.length ||
			options.selectKeys.some((key) => !Object.hasOwn(selectExprs, key)))
	) {
		throw new QueryBuilderDefect({
			message: "unionAll: every branch must select the same column aliases",
		})
	}
	const selectFragments = (options?.selectKeys ?? keys).map((alias) => aliased(selectExprs[alias], alias))

	if (selectFragments.length === 0) {
		throw new QueryBuilderDefect({ message: "CHQuery: select() is required" })
	}

	// WHERE — resolve params by injecting values into the accessor
	const whereConditions = state.whereFn ? state.whereFn($) : []
	const whereFragments = whereConditions
		.filter((c): c is NonNullable<typeof c> => c != null)
		.map((c) => c.toFragment())

	// CTEs — resolved before the FROM below, which reads their scope. A CTE given
	// as a query is compiled here and its scope derived; one given as a string
	// carries whatever scope the caller declared.
	// Sequential, not `map`: each CTE is compiled with the ones before it in
	// scope, which is the only way `WITH a AS (…), b AS (SELECT … FROM a)` can
	// see that `b` reads a tenant-confined source.
	const resolvedCtes: Array<ResolvedCte> = []
	for (const c of state.ctes) {
		if (c.query) {
			const compiled = compileInner(c.query, params, {
				skipFormat: true,
				deferParams,
				nested: true,
				enclosingCtes: [...(options?.enclosingCtes ?? []), ...resolvedCtes],
			})
			resolvedCtes.push({
				name: c.name,
				sql: compiled.sql,
				tenantScope: compiled.tenantScope,
				tenantBound: tenantBoundOf(compiled),
			})
		} else {
			resolvedCtes.push({ name: c.name, sql: c.sql ?? "", tenantScope: c.tenantScope })
		}
	}

	const visibleCtes = [...resolvedCtes, ...(options?.enclosingCtes ?? [])]
	const sourceForTable = (name: string, column?: string): TenantSource => {
		const cte = visibleCtes.find((c) => c.name === name)
		return {
			// A projected CTE column need not be the original tenant key.
			column: cte ? undefined : column,
			scope: cte ? (cte.tenantScope ?? "cross-tenant") : column ? "cross-tenant" : "untenanted",
			bound: cte?.tenantBound,
		}
	}
	const sourceOf = (compiled: CompiledQuery<any>): TenantSource => ({
		scope: compiled.tenantScope,
		bound: tenantBoundOf(compiled),
	})
	const mainAlias = sourceAlias(state)
	const mainColumn =
		state.tenantColumn === undefined
			? undefined
			: `${mainAlias}.${state.tenantColumn}`
	let fromFragment
	let fromSource: TenantSource
	if (state.fromQuery) {
		const inner = compileInner(state.fromQuery, params, {
			skipFormat: true,
			deferParams,
			nested: true,
			enclosingCtes: visibleCtes,
		})
		fromSource = sourceOf(inner)
		fromFragment = raw(`(${inner.sql}) AS ${quoteIdent(state.fromQueryAlias ?? "")}`)
	} else if (state.fromUnion) {
		const inner = compileUnionInner(state.fromUnion, params, { deferParams, nested: true, enclosingCtes: visibleCtes })
		fromSource = sourceOf(inner)
		const body = currentDialect().clauses.format ? splitTerminalClauses(inner.sql).body : inner.sql
		fromFragment = raw(`(\n${body}\n) AS ${quoteIdent(state.fromQueryAlias ?? "")}`)
	} else {
		fromSource = sourceForTable(state.tableName, mainColumn)
		fromFragment = mainAlias !== state.tableName
			? raw(`${quoteIdentPath(state.tableName)} AS ${quoteIdentPath(mainAlias)}`)
			: identPath(state.tableName)
	}

	const sources: TenantSource[] = [fromSource]
	const wherePredicates = whereConditions.flatMap((c) => (c ? tenantPredicatesOf(c) : []))
	const joinPredicates: Array<{ predicates: ReadonlyArray<TenantPredicate>; target?: string }> = []
	let sql = withSubqueryCompiler((subquery) => {
		if (typeof subquery === "string") {
			sources.push({ scope: "cross-tenant" })
			return subquery
		}
		const compiled = compileInner(subquery, params, {
			skipFormat: true,
			deferParams,
			nested: true,
			enclosingCtes: visibleCtes,
		})
		sources.push(sourceOf(compiled))
		return compiled.sql
	}, () => {
		const joins = state.typedJoins.map((j) => {
			let tableSql: string
			let source: TenantSource
			if (j.innerQuery) {
				const compiled = compileInner(j.innerQuery, params, {
					skipFormat: true,
					deferParams,
					nested: true,
					enclosingCtes: visibleCtes,
				})
				tableSql = `(${compiled.sql})`
				source = sourceOf(compiled)
			} else if (j.tableName) {
				tableSql = quoteIdentPath(j.tableName)
				source = sourceForTable(
					j.tableName,
					j.tenantColumn === undefined ? undefined : `${j.alias}.${j.tenantColumn}`,
				)
			} else {
				throw new QueryBuilderDefect({ message: "TypedJoin: missing table or query" })
			}
			sources.push(source)
			const on = j.on?.(
				createQualifiedColumnAccessor(mainAlias, state.tenantColumn, columnsOf(state)),
				createQualifiedColumnAccessor(j.alias, j.tenantColumn, joinColumnsOf(j)),
			)
			if (on) {
				// A LEFT JOIN's ON clause can constrain only its right side. It
				// cannot remove unmatched rows from the preserved left side.
				if (j.type !== "LEFT" || source.column !== undefined) {
					joinPredicates.push({
						predicates: tenantPredicatesOf(on),
						target: j.type === "LEFT" ? source.column : undefined,
					})
				}
			}
			return {
				type: j.type,
				table: tableSql,
				alias: quoteIdent(j.alias),
				on: on ? compileSqlFragment(on.toFragment()) : undefined,
			}
		})

		const sqlQuery: SqlQuery = {
			distinct: state.distinct !== undefined,
			distinctOn: Array.isArray(state.distinct)
				? (state.distinct.length === 0
						? (() => {
								throw new QueryBuilderDefect({ message: "CHQuery: distinctOn() needs at least one key" })
							})()
						: state.distinct
					).map((key: string) => {
						if (!(options?.selectKeys ?? keys).includes(key)) {
							throw new QueryBuilderDefect({ message: `CHQuery: distinctOn(${JSON.stringify(key)}) is not a selected alias` })
						}
						return raw(quoteIdent(key))
					})
				: undefined,
			lock: (() => {
				// Postgres refuses a lock on rows that are no longer table rows; say so here.
				if (state.lock !== undefined && (state.distinct !== undefined || state.groupByKeys.length > 0 || state.havingFn !== undefined)) {
					throw new QueryBuilderDefect({
						message: `CHQuery: FOR ${state.lock.strength} cannot lock rows of a query with DISTINCT, GROUP BY or HAVING`,
					})
				}
				return lockClause(state.lock)
			})(),
			select: selectFragments,
			from: fromFragment,
			joins,
			where: whereFragments,
			groupBy: state.groupByKeys.map((k) => raw(groupByKey(k, options?.selectKeys ?? keys))),
			// Deliberately excluded from tenant evidence: by HAVING time the
			// rows are already aggregated, so the scan that produced them crossed
			// tenants no matter what this filters out.
			having: (state.havingFn ? state.havingFn($) : [])
				.filter((c): c is NonNullable<typeof c> => c != null)
				.map((c) => c.toFragment()),
			orderBy: orderByClause(state.orderBySpecs).map(raw),
			limit: rowCount("limit", state.limitValue),
			offset: rowCount("offset", state.offsetValue),
			format: options?.skipFormat ? undefined : formatClause(state.formatValue),
		}

		return compileQuery(sqlQuery)
	})

	// Prepend CTE definitions
	if (resolvedCtes.length > 0) {
		const cteDefs = resolvedCtes.map((c) => `${quoteIdent(c.name)} AS (\n${c.sql}\n)`).join(",\n")
		sql = `WITH ${cteDefs}\n${sql}`
	}

	// Once, at the top: a nested query's SQL is spliced into this one, and a
	// dialect that binds numbers its placeholders across the whole statement.
	let parameters: ReadonlyArray<unknown> = []
	if (!deferParams && options?.nested !== true) {
		const rendered = renderParams(sql, params, currentDialect())
		sql = rendered.sql
		parameters = rendered.parameters
	}

	const scope = deriveTenantScope(sources, [{ predicates: wherePredicates }, ...joinPredicates], (value) =>
		deferParams ? compileSqlFragment(value) : inlineParams(compileSqlFragment(value), params),
	)
	const tenantScope = state.crossTenant === true ? "cross-tenant" : scope.scope

	const derived = deriveRowSchema(selectExprs)
	const derivedSchema = "schema" in derived ? derived.schema : undefined

	return withTenantBound(
		makeCompiledQuery<Decoded, Route>(
			sql,
			parameters,
			tenantScope,
			options?.rowSchema !== undefined ? "declared" : derivedSchema ? "derived" : "none",
			() => options?.rowSchema ?? (derivedSchema as CompiledQueryRowSchema<Decoded> | undefined),
			state.routeValue as Route,
			"untyped" in derived ? derived.untyped : [],
			undefined,
			options?.rowSchema === undefined
				? undefined
				: compareRowSchemas(options.rowSchema, derivedSchema),
			currentDialect().name,
		),
		tenantScope === "single-tenant" ? scope.bound : undefined,
	)
}

/**
 * Every source in a query needs its own name. Two joins under one alias, or a
 * join named like the FROM source, make every qualified column ambiguous; a
 * join named like a FROM column hides that column from `$`; two CTEs under one
 * name are refused by both databases. The join cases are type errors too
 * (`FreshAlias`); this catches the ones the type cannot see.
 */
function assertDistinctNames(state: CHQueryState): void {
	const fromAlias = sourceAlias(state)
	const columns = new Set(Object.keys(columnsOf(state)))
	const seen = new Set<string>([fromAlias])
	for (const join of state.typedJoins) {
		if (seen.has(join.alias)) {
			throw new QueryBuilderDefect({
				message: `CHQuery: join alias ${JSON.stringify(join.alias)} is already the name of another source in this query`,
			})
		}
		if (columns.has(join.alias)) {
			throw new QueryBuilderDefect({
				message: `CHQuery: join alias ${JSON.stringify(join.alias)} is also a column of the FROM source; pick another alias`,
			})
		}
		seen.add(join.alias)
	}
	const ctes = new Set<string>()
	for (const cte of state.ctes) {
		if (ctes.has(cte.name)) {
			throw new QueryBuilderDefect({ message: `CHQuery: withCTE(${JSON.stringify(cte.name)}) is defined twice` })
		}
		ctes.add(cte.name)
	}
}

interface TenantSource {
	readonly column?: string
	readonly scope: TenantScope
	readonly bound?: string
}

function deriveTenantScope(
	sources: ReadonlyArray<TenantSource>,
	conditions: ReadonlyArray<{ predicates: ReadonlyArray<TenantPredicate>; target?: string }>,
	render: (value: import("../sql/sql-fragment").SqlFragment) => string,
): { scope: TenantScope; bound?: string } {
	const tenanted = sources.filter((source) => source.scope !== "untenanted")
	if (tenanted.length === 0) return { scope: "untenanted" }
	const columns = new Set(tenanted.flatMap((s) => (s.column === undefined ? [] : [s.column])))
	const bounds = new Map<string, string>()
	for (const source of tenanted) {
		if (source.column !== undefined && source.bound !== undefined) bounds.set(source.column, source.bound)
	}
	const edges: Array<readonly [string, string]> = []
	for (const { predicates, target } of conditions) {
		for (const p of predicates) {
			if ("column" in p) {
				if (columns.has(p.column) && (target === undefined || target === p.column)) {
					bounds.set(p.column, render(p.value))
				}
			} else if (columns.has(p.left) && columns.has(p.right)) {
				if (target === undefined || target === p.right) edges.push([p.left, p.right])
				if (target === undefined || target === p.left) edges.push([p.right, p.left])
			}
		}
	}
	let changed = true
	while (changed) {
		changed = false
		for (const [left, right] of edges) {
			const value = bounds.get(left)
			if (value !== undefined && !bounds.has(right)) {
				bounds.set(right, value)
				changed = true
			}
		}
	}
	const values = new Set<string>()
	for (const source of tenanted) {
		const bound = source.column === undefined ? source.bound : (bounds.get(source.column) ?? source.bound)
		if (source.scope !== "single-tenant" && bound === undefined) return { scope: "cross-tenant" }
		if (bound !== undefined) values.add(bound)
	}
	return values.size > 1 ? { scope: "cross-tenant" } : { scope: "single-tenant", bound: [...values][0] }
}

/**
 * The column accessor a query's callbacks see.
 *
 * Shared with `selectExprsOf` below, which needs the same accessor to read a
 * query's output schemas without compiling it.
 */
function makeAccessor(state: CHQueryState): any {
	const joinAliases = state.typedJoins.map((j) => j.alias)
	const hasJoins = joinAliases.length > 0
	if (!hasJoins) return createQualifiedColumnAccessor(sourceAlias(state), state.tenantColumn, columnsOf(state))

	const mainAlias = sourceAlias(state)
	return createJoinedColumnAccessor(
		columnsOf(state),
		joinAliases,
		mainAlias,
		state.tenantColumn,
		Object.fromEntries(state.typedJoins.map((j) => [j.alias, j.tenantColumn])),
		Object.fromEntries(state.typedJoins.map((j) => [j.alias, joinColumnsOf(j)])),
	)
}

/**
 * A join's columns: its table's, or — for a joined subquery — the schemas of
 * the SELECT it will compile to.
 *
 * `innerJoinQuery` records no columns (there is no table to read them from), so
 * without this every `$.alias.field` off a joined subquery is untyped.
 */
function joinColumnsOf(join: {
	readonly type: "INNER" | "LEFT" | "CROSS"
	readonly columns?: ColumnDefs
	readonly innerQuery?: CHQuery<any, any, any>
}): ColumnDefs | undefined {
	const exprs = join.innerQuery === undefined ? undefined : selectExprsOf(join.innerQuery)
	const columns = join.columns ?? (exprs === undefined ? undefined : synthesizeColumns(exprs))
	if (columns === undefined || join.type !== "LEFT") return columns
	return Object.fromEntries(
		Object.entries(columns).map(([name, type]) => [
			name,
			{
				...type,
				schema: Schema.NullOr(type.schema),
				literalSchema: Schema.NullOr(type.literalSchema),
			},
		]),
	)
}

/**
 * A FROM-subquery's columns are its inner SELECT, which only exists as
 * expressions. Reading their schemas back out is what lets a query built on a
 * subquery still derive a row schema instead of falling off at the boundary.
 */
function columnsOf(state: CHQueryState): ColumnDefs {
	if (Object.keys(state.columns).length > 0) return state.columns

	const innerExprs = state.fromUnion
		? unionExprsOf(state.fromUnion._state.queries)
		: state.fromQuery
			? selectExprsOf(state.fromQuery)
			: undefined
	if (innerExprs === undefined) return state.columns

	return synthesizeColumns(innerExprs)
}

/**
 * Column definitions for a derived source, from the expressions its SELECT
 * produced. An expression with no schema of its own contributes no column, so
 * the outer query's reference to it stays untyped rather than being invented.
 */
function synthesizeColumns(exprs: Record<string, unknown>): ColumnDefs {
	const synthesized: ColumnDefs = {}
	for (const [alias, expr] of Object.entries(exprs)) {
		const schema = (expr as { readonly schema?: Schema.Codec<any, any> } | null)?.schema
		if (schema === undefined) continue
		synthesized[alias] = columnTypeOf(expr as import("./expr").Expr<any>) ?? { _tag: "Inferred", sql: "", schema, literalSchema: derivedLiteralSchema(schema) }
	}
	return synthesized
}

/** Built-in DateTime expressions accept the same comparison values as columns. */
function derivedLiteralSchema(schema: Schema.Codec<any, any>): Schema.Codec<any, any> {
	if (schema.ast === dateTime.schema.ast) return dateTime.literalSchema
	if (schema.ast === dateTime64.schema.ast) return dateTime64.literalSchema
	// Preserve custom outer transformations; only unwrap a plain union.
	if (schema.ast._tag === "Union" && schema.ast.encoding === undefined) {
		return Schema.Union(schema.ast.types.map((ast) => derivedLiteralSchema(Schema.make(ast))))
	}
	return schema
}

/** Evaluate a query's SELECT callback without compiling it. */
function selectExprsOf(query: CHQuery<any, any, any>): Record<string, unknown> | undefined {
	const state = query._state
	return state.selectFn ? state.selectFn(makeAccessor(state)) : undefined
}

/**
 * Fold the selected expressions' own schemas into the query's row schema.
 *
 * All or nothing on purpose: one field without a schema — a `rawExpr`, a
 * `dynamicColumn`, a custom function that never declared its result type —
 * means the builder cannot describe the row, and inventing a permissive schema
 * for that field would hand back something that looks validated and is not.
 */
const deriveRowSchema = (
	selectExprs: Record<string, unknown>,
): { readonly schema: Schema.Codec<any, any> } | { readonly untyped: ReadonlyArray<string> } => {
	const fields: Record<string, Schema.Codec<any, any>> = {}
	const untyped: Array<string> = []
	for (const [alias, expr] of Object.entries(selectExprs)) {
		const schema = (expr as { readonly schema?: Schema.Codec<any, any> } | null)?.schema
		if (schema === undefined) untyped.push(alias)
		else fields[alias] = schema
	}
	// Every alias is collected before returning, rather than bailing at the
	// first: naming one column at a time turns a ten-column fix into ten
	// compile-and-look cycles.
	return untyped.length > 0 ? { untyped } : { schema: Schema.Struct(fields) }
}

/**
 * Fold every branch's SELECT into one row schema, widening per column.
 *
 * All-or-nothing like the single-query case: one branch that cannot describe a
 * column means the union cannot either. Identical schemas collapse rather than
 * becoming a one-member union, so the common case — every branch selecting the
 * same column type — costs nothing.
 */
const unionExprsOf = (
	branches: ReadonlyArray<CHQuery<any, any, any>>,
): Record<string, { readonly schema?: Schema.Codec<any, any> }> | undefined => {
	if (branches.length === 0) return undefined

	const perColumn = new Map<string, Array<Schema.Codec<any, any>>>()
	const untyped = new Set<string>()
	for (const branch of branches) {
		const exprs = selectExprsOf(branch)
		if (exprs === undefined) return undefined
		for (const [alias, expr] of Object.entries(exprs)) {
			const schema = (expr as { readonly schema?: Schema.Codec<any, any> } | null)?.schema
			if (schema === undefined) {
				untyped.add(alias)
				continue
			}
			const seen = perColumn.get(alias) ?? []
			if (!seen.includes(schema)) seen.push(schema)
			perColumn.set(alias, seen)
		}
	}
	const fields: Record<string, { readonly schema?: Schema.Codec<any, any> }> = {}
	for (const alias of untyped) fields[alias] = {}
	for (const [alias, schemas] of perColumn) {
		if (!untyped.has(alias)) fields[alias] = { schema: mergeResultSchemas(schemas) }
	}
	return fields
}

// UNION ALL compilation

export function compileUnionUnsafe<Output extends Record<string, any>, Params extends Record<string, any>>(
	union: CHUnionQuery<Output>,
	params: Params,
	options?: {
		rowSchema?: CompiledQueryRowSchema<Output>
		deferParams?: boolean
		dialect?: Dialect
	},
): CompiledQuery<Output, undefined> {
	return withDialect(options?.dialect ?? currentDialect(), () => compileUnionInner(union, params, options))
}

/** The recursion behind {@link compileUnionUnsafe}; see {@link compileInner}. */
function compileUnionInner<Output extends Record<string, any>, Params extends Record<string, any>>(
	union: CHUnionQuery<Output>,
	params: Params,
	options?: {
		rowSchema?: CompiledQueryRowSchema<Output>
		deferParams?: boolean
		/** Set by a compile that splices this union's SQL into its own, and so
		 *  resolves its params itself. */
		nested?: boolean
		/** A union in a later CTE's FROM must still see its earlier scoped
		 *  siblings. See `compileInner`'s option of the same name. */
		enclosingCtes?: ReadonlyArray<ResolvedCte>
	},
): CompiledQuery<Output, undefined> {
	const state = union._state
	const deferParams = options?.deferParams === true
	const enclosingCtes = options?.enclosingCtes

	// Compile each sub-query without FORMAT
	const first = state.queries[0]
	if (first === undefined) throw new QueryBuilderDefect({ message: "unionAll requires at least one query" })
	const selectKeys = Object.keys(selectExprsOf(first) ?? {})
	if (state.queries.some((q) => q._state.lock !== undefined)) {
		throw new QueryBuilderDefect({ message: "unionAll: a branch cannot take a row lock; lock in a query over the union instead" })
	}
	const subQueries = state.queries.map((q) =>
		compileInner(q, params, { skipFormat: true, deferParams, nested: true, selectKeys, enclosingCtes }),
	)
	const bounds = new Set(
		subQueries.flatMap((q) => {
			const bound = tenantBoundOf(q)
			return bound === undefined ? [] : [bound]
		}),
	)

	// UNION ALL is a disjunction: one unscoped branch leaks every tenant into the
	// result regardless of how tightly the others are filtered.
	const tenantScope: TenantScope =
		bounds.size <= 1 &&
		subQueries.length > 0 &&
		subQueries.every((q) => q.tenantScope === "single-tenant")
			? "single-tenant"
			: // All-untenanted branches read nothing tenanted, so the union does not
				// either. Any other mix has at least one branch that spans tenants.
				subQueries.length > 0 && subQueries.every((q) => q.tenantScope === "untenanted")
				? "untenanted"
				: "cross-tenant"

	const parenthesize = currentDialect().clauses.parenthesizeUnionBranches
	let sql = subQueries.map((q) => (parenthesize ? `(\n${q.sql}\n)` : q.sql)).join("\nUNION ALL\n")

	// Wrap in outer SELECT if ordering/pagination is needed
	const hasOuter =
		state.outerOrderBySpecs.length > 0 || state.outerLimitValue != null || state.outerOffsetValue != null

	if (hasOuter) {
		sql = `SELECT * FROM (\n${sql}\n)${currentDialect().clauses.derivedTableAlias ? ` AS ${quoteIdent("__union")}` : ""}`
		if (state.outerOrderBySpecs.length > 0) {
			sql += `\nORDER BY ${orderByClause(state.outerOrderBySpecs).join(", ")}`
		}
		if (state.outerLimitValue != null) {
			sql += `\nLIMIT ${compileSqlFragment(rowCount("limit", state.outerLimitValue)!)}`
		}
		if (state.outerOffsetValue != null) {
			sql += `\nOFFSET ${compileSqlFragment(rowCount("offset", state.outerOffsetValue)!)}`
		}
	}

	const format = formatClause(state.formatValue)
	if (format) {
		sql += `\nFORMAT ${format}`
	}

	let parameters: ReadonlyArray<unknown> = []
	if (!deferParams && options?.nested !== true) {
		const rendered = renderParams(sql, params, currentDialect())
		sql = rendered.sql
		parameters = rendered.parameters
	}

	// A union decodes as its branches do — but not as its FIRST branch does.
	// The branches share an Output *shape*, not a column type: ClickHouse widens
	// across them, so a column that is `String` in one branch and nullable in
	// another resolves to `Nullable(String)` for the whole union. Deriving from
	// branch 0 alone produced a schema that rejected rows the query can really
	// return.
	const exprs = unionExprsOf(state.queries)
	const derived = exprs === undefined ? undefined : deriveRowSchema(exprs)
	const derivedSchema = derived && "schema" in derived ? derived.schema : undefined

	return withTenantBound(
		makeCompiledQuery<Output, undefined>(
			sql,
			parameters,
			tenantScope,
			options?.rowSchema !== undefined ? "declared" : derivedSchema ? "derived" : "none",
			() => options?.rowSchema ?? (derivedSchema as CompiledQueryRowSchema<Output> | undefined),
			undefined,
			derived && "untyped" in derived ? derived.untyped : [],
			undefined,
			options?.rowSchema === undefined
				? undefined
				: compareRowSchemas(options.rowSchema, derivedSchema),
			currentDialect().name,
		),
		tenantScope === "single-tenant" ? [...bounds][0] : undefined,
	)
}

/**
 * Substitute every `__PARAM_<kind>_<name>__` placeholder, the way the dialect
 * sends params: as literals written into the SQL, or as bind placeholders whose
 * encoded values come back in `parameters`.
 *
 * Params are resolved here rather than handed to the driver unchecked, so a
 * value that never arrives, or arrives as the wrong type, would otherwise
 * become part of the SQL text: a missing param used to ship the placeholder
 * itself to the server, and a `Date` handed to a dateTime param used to
 * stringify as `Thu Jan 01 2026 …`. Both are compile-time failures, whichever
 * way the dialect sends values.
 *
 * Params the query doesn't mention are ignored — one bag of params is commonly
 * shared across a family of queries.
 */
function renderParams(
	sql: string,
	params: Record<string, unknown>,
	dialect: Dialect,
): { readonly sql: string; readonly parameters: ReadonlyArray<unknown> } {
	const missing: Array<string> = []
	const parameters: Array<unknown> = []
	// Keyed by kind and name: `dateTime` and `dateTimeSeconds` read one value
	// and encode it differently, so they are two bound values, not one.
	const bound = new Map<string, string>()
	const style = dialect.params

	const resolved = sql.replace(PARAM_PLACEHOLDER_PATTERN, (placeholder, kind: string, name: string) => {
		if (!(name in params)) {
			missing.push(name)
			return placeholder
		}
		const value = encodeParam(dialect, kind as ParamKind, name, params[name])
		if (style._tag === "inline") return checkedLiteral(dialect, value, paramContext(kind, name))

		const key = `${kind}\0${name}`
		const existing = style.reuse ? bound.get(key) : undefined
		if (existing !== undefined) return existing
		parameters.push(value)
		const marker = style.placeholder(parameters.length, kind)
		bound.set(key, marker)
		return marker
	})

	if (style._tag === "bind" && style.maxParameters !== undefined && parameters.length > style.maxParameters) {
		throw new QueryBuilderError({
			code: "InvalidArguments",
			message: `compile: the statement binds ${parameters.length} values, over the ${style.maxParameters} ${dialect.name} allows in one statement; send fewer rows per statement`,
		})
	}

	if (missing.length > 0) {
		throw new QueryBuilderError({
			code: "UnresolvedParam",
			message: `compile: no value given for param${missing.length > 1 ? "s" : ""} ${missing
				.map((n) => `'${n}'`)
				.join(", ")}`,
		})
	}

	// Nothing placeholder-shaped may survive a resolved compile. The loop above
	// only reports the names it recognised, so a marker naming a kind the pattern
	// matches but `paramSchema` cannot resolve — or one a value smuggled past the
	// escaper — would otherwise reach the warehouse as query text.
	if (resolved.includes(PARAM_MARKER_PREFIX)) {
		throw new QueryBuilderError({
			code: "UnresolvedParam",
			message: "compile: unresolved param placeholder remains in the compiled SQL",
		})
	}

	return { sql: resolved, parameters }
}

/**
 * A fragment with its params written in as ClickHouse literals.
 *
 * Only for tenant bounds, which are compared with each other as text and never
 * sent anywhere, so they render the same whatever the query's dialect.
 */
const inlineParams = (sql: string, params: Record<string, unknown>): string =>
	renderParams(sql, params, clickhouseDialect).sql

const paramContext = (kind: string, name: string): string => `param '${name}' (${kind})`

/**
 * A param value encoded to its wire form, through its declared type's codec.
 *
 * The same schema that decodes a column of that type runs backwards here, so
 * the two directions cannot drift: a `DateTime` param and a `DateTime` column
 * agree on the literal by construction, not by two functions being kept in sync.
 */
function encodeParam(dialect: Dialect, kind: ParamKind, name: string, value: unknown): unknown {
	const schema = dialect.paramCodecs?.[kind] ?? paramSchema(kind)
	if (schema === undefined) {
		// Only reachable from a hand-written placeholder naming a kind nothing
		// declared: `param.of` registers its type before it can reach any SQL —
		// which is why it is a defect and not a failure a caller could report.
		throw new QueryBuilderDefect({
			message: `compile: param '${name}' has an unknown type '${kind}'`,
		})
	}
	return encodeValue(schema, value, paramContext(kind, name))
}

// INSERT

/**
 * The column type an insert's literal values are bound as. The value is
 * encoded through its own column's codec first (so a failure names the row and
 * column), and this passes the wire value on unchanged: ClickHouse writes it as
 * a literal, Postgres binds it. A Postgres placeholder in `VALUES` needs no
 * cast: the server coerces it to the target column.
 */
const insertWireValue = custom("insert value", Schema.Unknown)

/** Prefix of the params an insert's literal values become. */
const VALUE_PARAM = "$$v"

const EMPTY_ROW = Schema.Struct({}) as unknown as CompiledQueryRowSchema<never>

/**
 * The ON CONFLICT clause, or `""` without one. `$` in SET and WHERE is the
 * existing row, qualified with the table name: an unqualified column there
 * would be ambiguous with `excluded`.
 */
const onConflictClause = (
	insert: CHInsert<any, any, any, any>,
	cell: (column: string, value: unknown, context: string) => string,
	wrote: (column: string, value: unknown, sql: string) => void,
): string => {
	const { table, conflict } = insert._state
	if (conflict === undefined) return ""
	const where = `insertInto(${table.name})`
	const dialect = currentDialect()
	if (dialect.clauses.onConflict !== true) {
		throw new QueryBuilderDefect({
			message: `${where}: onConflict has no meaning for the ${dialect.name} dialect, which has no ON CONFLICT clause`,
		})
	}

	let target = ""
	if (conflict.target !== undefined) {
		if ("constraint" in conflict.target) {
			if (conflict.targetWhere !== undefined) {
				throw new QueryBuilderDefect({ message: `${where}: targetWhere needs a column target, not a constraint` })
			}
			target = ` ON CONSTRAINT ${quoteIdent(conflict.target.constraint)}`
		} else {
			const targetColumns = conflict.target
			if (targetColumns.length === 0 || targetColumns.some((column) => !Object.hasOwn(table.columns, column))) {
				throw new QueryBuilderDefect({ message: `${where}: the conflict target must name columns of the table` })
			}
			const predicate = conflict.targetWhere?.(createColumnAccessor(table.columns))
			target = ` (${targetColumns.map(quoteIdent).join(", ")})${
				predicate === undefined ? "" : ` WHERE ${compileSqlFragment(predicate.toFragment())}`
			}`
		}
	} else if (conflict.targetWhere !== undefined) {
		throw new QueryBuilderDefect({ message: `${where}: targetWhere needs a target` })
	}
	if (conflict.action === "nothing") return `\nON CONFLICT${target} DO NOTHING`

	const existing = createQualifiedColumnAccessor(table.name, undefined, table.columns)
	const excluded = createQualifiedColumnAccessor("excluded", undefined, table.columns)
	const set = typeof conflict.set === "function" ? conflict.set(existing, excluded) : conflict.set
	const assignments = setAssignments(table, set as Record<string, unknown>, cell, wrote, where, "onConflictDoUpdate")
	const condition = conflict.where?.(existing, excluded)
	return `\nON CONFLICT${target} DO UPDATE SET ${assignments.join(", ")}${
		condition === undefined ? "" : ` WHERE ${compileSqlFragment(condition.toFragment())}`
	}`
}

/** The RETURNING clause and its row schema, or none without `returning`. */
const returningOf = (
	table: Table<string, ColumnDefs>,
	returningFn: (($: any) => Record<string, Expr<any>>) | undefined,
	where: string,
) => {
	if (returningFn === undefined) return undefined
	const dialect = currentDialect()
	if (dialect.clauses.returning !== true) {
		throw new QueryBuilderDefect({
			message: `${where}: returning() has no meaning for the ${dialect.name} dialect, which has no RETURNING clause`,
		})
	}
	const exprs = returningFn(createColumnAccessor(table.columns))
	const aliases = Object.keys(exprs)
	if (aliases.length === 0) {
		throw new QueryBuilderDefect({ message: `${where}: returning() needs at least one column` })
	}
	const sql = `\nRETURNING ${aliases.map((alias) => compileSqlFragment(aliased(exprs[alias]!, alias))).join(", ")}`
	return { exprs, aliases, sql, derived: deriveRowSchema(exprs) }
}

/** A write's compiled query, with the row schema its RETURNING list derives. */
const writeCompiledQuery = (
	rendered: { readonly sql: string; readonly parameters: ReadonlyArray<unknown> },
	kind: "insert" | "update" | "delete",
	tenantScope: TenantScope,
	tenantBound: string | undefined,
	returning: ReturnType<typeof returningOf>,
): CompiledQuery<any, undefined> => {
	const returnedSchema = returning !== undefined && "schema" in returning.derived ? returning.derived.schema : undefined
	return withTenantBound(
		makeCompiledQuery<any, undefined>(
			rendered.sql,
			rendered.parameters,
			tenantScope,
			returning === undefined || returnedSchema !== undefined ? "derived" : "none",
			() => (returning === undefined ? EMPTY_ROW : returnedSchema),
			undefined,
			returning !== undefined && "untyped" in returning.derived ? returning.derived.untyped : [],
			undefined,
			undefined,
			currentDialect().name,
			kind,
			returning?.aliases,
		),
		tenantBound,
	)
}

/**
 * Literal values of a write as params of their column's type: encoded by the
 * column's codec (so a failure names the column), then sent the way the
 * dialect sends params. `values` is the params bag to render with.
 */
const valueCells = (table: Table<string, ColumnDefs>, params: Record<string, unknown>, where: string) => {
	const values: Record<string, unknown> = { ...params }
	let next = 0
	const cell = (column: string, value: unknown, context: string): string => {
		if (value === undefined) return "DEFAULT"
		if (isExprLike(value)) return compileSqlFragment(value.toFragment())
		const wire = encodeValue(table.columns[column]!.literalSchema, value, `${where}: ${context}, column ${column}`)
		let name = `${VALUE_PARAM}${next++}`
		while (Object.hasOwn(params, name)) name = `${VALUE_PARAM}${next++}`
		values[name] = wire
		return compileSqlFragment(param.of(insertWireValue, name).toFragment())
	}
	return { values, cell }
}

/**
 * The subquery compiler a write's expressions render under, recording what
 * each subquery reads: a write that reads another tenant's rows through a
 * subquery is cross-tenant, as a query that does is. A string subquery could
 * read anything.
 */
const recordingSubqueries = (values: Record<string, unknown>, reads: Array<TenantSource>) =>
	(subquery: Parameters<Parameters<typeof withSubqueryCompiler>[0]>[0]): string => {
		if (typeof subquery === "string") {
			reads.push({ scope: "cross-tenant" })
			return subquery
		}
		const compiled = compileInner(subquery, values, { skipFormat: true, nested: true })
		reads.push({ scope: compiled.tenantScope, bound: tenantBoundOf(compiled) })
		return compiled.sql
	}

/** A write's own scope combined with what its subqueries read. */
const withReads = (
	own: { readonly scope: TenantScope; readonly bound: string | undefined },
	reads: ReadonlyArray<TenantSource>,
): { readonly scope: TenantScope; readonly bound: string | undefined } => {
	if (reads.length === 0) return own
	const derived = deriveTenantScope([{ scope: own.scope, bound: own.bound }, ...reads], [], (value) =>
		compileSqlFragment(value),
	)
	return { scope: derived.scope, bound: derived.scope === "single-tenant" ? derived.bound : undefined }
}

/** `column = value, ...` for a SET record, which may come from data, so a bad key is a failure. */
const setAssignments = (
	table: Table<string, ColumnDefs>,
	set: Record<string, unknown>,
	cell: (column: string, value: unknown, context: string) => string,
	wrote: (column: string, value: unknown, sql: string) => void,
	where: string,
	context: string,
): ReadonlyArray<string> => {
	const computed = new Set<string>(table.computed ?? [])
	const assignments = Object.entries(set).flatMap(([column, value]) => {
		if (value === undefined) return []
		if (!Object.hasOwn(table.columns, column) || computed.has(column)) {
			throw new QueryBuilderError({
				code: "InvalidArguments",
				message: `${where}: ${context} sets ${JSON.stringify(column)}, which is not an insertable column of the table`,
			})
		}
		const sql = cell(column, value, `${context} set`)
		wrote(column, value, sql)
		return [`${quoteIdent(column)} = ${sql}`]
	})
	if (assignments.length === 0) {
		throw new QueryBuilderError({ code: "InvalidArguments", message: `${where}: ${context} sets no columns` })
	}
	return assignments
}

/**
 * The column list and SQL of an `INSERT ... SELECT` source. The selected
 * aliases name the columns, in select order, which is also the order the
 * SELECT writes them in, so positional and named matching agree.
 */
const insertSelectSource = (
	insert: CHInsert<any, any, any, any>,
	query: CHQuery<any, any, any, any> | CHUnionQuery<any>,
	values: Record<string, unknown>,
) => {
	const { table } = insert._state
	const isUnion = "_tag" in query && query._tag === "CHUnionQuery"
	const exprs = selectExprsOf(isUnion ? (query as CHUnionQuery<any>)._state.queries[0]! : (query as CHQuery<any, any, any, any>)) ?? {}
	const columns = Object.keys(exprs)
	const computed = new Set<string>(table.computed ?? [])
	// The query is written in source, so a column the table cannot take is a
	// defect, as the type error on `select` says.
	for (const column of columns) {
		if (!Object.hasOwn(table.columns, column) || computed.has(column)) {
			throw new QueryBuilderDefect({
				message: `insertInto(${table.name}): the query selects ${JSON.stringify(column)}, which is not an insertable column of the table`,
			})
		}
	}
	const inner = isUnion
		? compileUnionInner(query as CHUnionQuery<any>, values, { nested: true })
		: compileInner(query as CHQuery<any, any, any, any>, values, { skipFormat: true, nested: true })
	const sql = isUnion && currentDialect().clauses.format ? splitTerminalClauses(inner.sql).body : inner.sql
	return { columns, exprs, inner, sql }
}

/** `SETTINGS a = 1, b = 'x'`, or `""` without settings. */
const writeSettingsClause = (
	table: Table<string, ColumnDefs>,
	settings: Readonly<Record<string, unknown>> | undefined,
	where: string,
): string => {
	const entries = Object.entries(settings ?? {})
	if (entries.length === 0) return ""
	const dialect = currentDialect()
	if (dialect.clauses.writeSettings !== true) {
		throw new QueryBuilderDefect({
			message: `${where}: settings() has no meaning for the ${dialect.name} dialect, which has no SETTINGS on writes`,
		})
	}
	return ` SETTINGS ${entries
		.map(([name, value]) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
				throw new QueryBuilderDefect({ message: `${where}: ${JSON.stringify(name)} is not a setting name` })
			}
			return `${name} = ${checkedLiteral(dialect, value, `setting ${name}`)}`
		})
		.join(", ")}`
}

/**
 * An INSERT ... VALUES or INSERT ... SELECT. For VALUES, columns are written in
 * table order, so two rows with their keys in different orders cannot swap
 * values, and a column some rows leave out is `DEFAULT` in those rows, which
 * both dialects accept.
 */
function compileInsert(insert: CHInsert<any, any, any, any>, params: Record<string, unknown>): CompiledQuery<any, undefined> {
	const { table, rows, selectQuery } = insert._state
	const where = `insertInto(${table.name})`
	if (rows === undefined && selectQuery === undefined) {
		throw new QueryBuilderDefect({ message: `${where}: values() or select() is required` })
	}
	const dialect = currentDialect()
	const { values, cell } = valueCells(table, params, where)

	// A tenant table's insert is single-tenant when every row it writes (and an
	// upsert's SET, if it writes the column) pins the tenant column to the same
	// value or param. Any other expression, a NULL or a default could be anything.
	const tenant = table.tenantColumn
	const bounds = new Set<string>()
	let pinned = tenant !== undefined
	const pin = (value: unknown, sql: string): void => {
		if (!pinned) return
		if (value === undefined || value === null || (isExprLike(value) && !("_paramName" in value))) pinned = false
		else bounds.add(inlineParams(sql, values))
	}

	const reads: Array<TenantSource> = []
	let readBound: string | undefined
	const [columns, source, conflictSql, readScope] = withSubqueryCompiler(
		recordingSubqueries(values, reads),
		() => {
			let columns: ReadonlyArray<string>
			let source: string
			// What the statement reads, besides what it writes: an INSERT ... SELECT
			// into any table reads with the SELECT's scope.
			let readScope: TenantScope | undefined
			if (rows !== undefined) {
				columns = valuesColumns(table, rows)
				if (tenant !== undefined && !columns.includes(tenant)) pinned = false
				const tuples = rows.map((row, index) => {
					const cells = columns.map((column) => {
						const value = row[column]
						const sql = cell(column, value, `row ${index}`)
						if (column === tenant) pin(value, sql)
						return sql
					})
					return `(${cells.join(", ")})`
				})
				source = `VALUES ${tuples.join(", ")}`
			} else {
				const selected = insertSelectSource(insert, selectQuery!, values)
				columns = selected.columns
				source = selected.sql
				readScope = selected.inner.tenantScope
				const bound = tenantBoundOf(selected.inner)
				readBound = bound
				if (tenant !== undefined) {
					// The written tenant is pinned when the read is, and the row takes its
					// tenant from a tenant column of the source or from that same value.
					const expr = selected.exprs[tenant] as Expr<unknown> | undefined
					const fromSource = expr !== undefined && isExprLike(expr) && tenantColumnOf(expr) !== undefined
					const sameValue =
						expr !== undefined &&
						isExprLike(expr) &&
						"_paramName" in expr &&
						inlineParams(compileSqlFragment(expr.toFragment()), values) === bound
					if (readScope !== "single-tenant" || bound === undefined || !(fromSource || sameValue)) pinned = false
					else bounds.add(bound)
				}
			}
			const conflictSql = onConflictClause(insert, cell, (column, value, sql) => {
				if (column === tenant) pin(value, sql)
			})
			return [columns, source, conflictSql, readScope] as const
		},
	)

	const returning = returningOf(table, insert._state.returningFn, where)
	const rendered = renderParams(
		`INSERT INTO ${quoteIdentPath(table.name)} (${columns.map(quoteIdent).join(", ")})${writeSettingsClause(table, insert._state.settings, where)}\n${source}${conflictSql}${returning?.sql ?? ""}`,
		values,
		dialect,
	)
	const tenantScope: TenantScope =
		tenant === undefined
			? (readScope ?? "untenanted")
			: pinned && bounds.size === 1
				? "single-tenant"
				: "cross-tenant"
	const own = withReads(
		{
			scope: tenantScope,
			bound: tenantScope !== "single-tenant" ? undefined : tenant === undefined ? readBound : [...bounds][0],
		},
		reads,
	)
	return writeCompiledQuery(rendered, "insert", own.scope, own.bound, returning)
}

/** The VALUES rows' columns, in table order, after checking every key. */
const valuesColumns = (
	table: CHInsert<any, any, any, any>["_state"]["table"],
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ReadonlyArray<string> => {
	const where = `insertInto(${table.name})`
	// The rows usually come from data, so their number and keys are failures, not defects.
	if (rows.length === 0) {
		throw new QueryBuilderError({ code: "InvalidArguments", message: `${where}: values() was given no rows` })
	}
	const computed = new Set<string>(table.computed ?? [])
	const present = new Set<string>()
	rows.forEach((row, index) => {
		for (const [column, value] of Object.entries(row)) {
			if (value === undefined) continue
			if (!Object.hasOwn(table.columns, column)) {
				throw new QueryBuilderError({
					code: "InvalidArguments",
					message: `${where}: row ${index} has ${JSON.stringify(column)}, which is not a column of the table`,
				})
			}
			if (computed.has(column)) {
				throw new QueryBuilderError({
					code: "InvalidArguments",
					message: `${where}: row ${index} writes ${column}, which the database computes (MATERIALIZED or ALIAS)`,
				})
			}
			present.add(column)
		}
	})
	const columns = Object.keys(table.columns).filter((column) => present.has(column))
	if (columns.length === 0) {
		throw new QueryBuilderError({ code: "InvalidArguments", message: `${where}: every row is empty; give at least one column` })
	}
	return columns
}

// UPDATE and DELETE

/**
 * An UPDATE or DELETE. Postgres writes `UPDATE t SET ... WHERE ...` and
 * `DELETE FROM t WHERE ...`; ClickHouse an `ALTER TABLE t UPDATE ... WHERE ...`
 * mutation and a lightweight `DELETE FROM t WHERE ...`, both of which need a
 * WHERE, so `allRows()` writes `WHERE 1` there.
 */
function compileUpdateOrDelete(
	write: CHUpdate<any, any, any> | CHDelete<any, any>,
	params: Record<string, unknown>,
): CompiledQuery<any, undefined> {
	const state = write._state
	const { table } = state
	const kind = write._tag === "CHUpdate" ? "update" : "delete"
	const where = `${kind === "update" ? "update" : "deleteFrom"}(${table.name})`
	const dialect = currentDialect()
	const { values, cell } = valueCells(table, params, where)
	const $ = createColumnAccessor(table.columns, table.tenantColumn)

	// No WHERE at all is a mistake in the source; a WHERE whose conditions all
	// came out undefined is data, and would otherwise turn a filtered write into
	// one over every row.
	if (state.whereFn === undefined && state.allRows !== true) {
		throw new QueryBuilderDefect({ message: `${where}: no where(); call allRows() to write every row` })
	}
	const conditions = (state.whereFn?.($) ?? []).filter((c): c is NonNullable<typeof c> => c != null)

	const tenant = table.tenantColumn
	const setWrites: Array<{ readonly value: unknown; readonly sql: string }> = []

	const reads: Array<TenantSource> = []
	const [assignments, whereSql] = withSubqueryCompiler(
		recordingSubqueries(values, reads),
		() => {
			let assignments: ReadonlyArray<string> = []
			if (write._tag === "CHUpdate") {
				const set = (write as CHUpdate<any, any, any>)._state.set
				if (set === undefined) throw new QueryBuilderDefect({ message: `${where}: set() is required` })
				const record = typeof set === "function" ? set($) : set
				assignments = setAssignments(table, record as Record<string, unknown>, cell, (column, value, sql) => {
					if (column === tenant) setWrites.push({ value, sql })
				}, where, "update")
			}
			// An empty rendering (a `rawCond("")`) filters nothing, so it does not count.
			const rendered = conditions.map((c) => compileSqlFragment(c.toFragment())).filter((sql) => sql.trim() !== "")
			if (state.whereFn !== undefined && rendered.length === 0 && state.allRows !== true) {
				throw new QueryBuilderError({
					code: "InvalidArguments",
					message: `${where}: where() gave no conditions (each was undefined or empty), which would write every row; call allRows() if that is meant`,
				})
			}
			const whereSql =
				rendered.length > 0
					? `\nWHERE ${rendered.join("\n  AND ")}`
					: dialect.clauses.alterTableUpdate === true
						? "\nWHERE 1"
						: ""
			return [assignments, whereSql] as const
		},
	)

	// Scope as for a query over the table, from the WHERE; an UPDATE that moves
	// rows to another tenant reaches past it.
	let tenantScope: TenantScope = "untenanted"
	let tenantBound: string | undefined
	if (tenant !== undefined) {
		const derived = deriveTenantScope(
			[{ column: tenant, scope: "cross-tenant" }],
			[{ predicates: conditions.flatMap((c) => tenantPredicatesOf(c)) }],
			(value) => inlineParams(compileSqlFragment(value), values),
		)
		tenantScope = derived.scope
		tenantBound = derived.bound
		for (const { value, sql } of setWrites) {
			const pinned = value !== null && (!isExprLike(value) || "_paramName" in value)
			if (!pinned || inlineParams(sql, values) !== tenantBound) {
				tenantScope = "cross-tenant"
				tenantBound = undefined
			}
		}
	}

	const returning = returningOf(table, state.returningFn, where)
	const settings = writeSettingsClause(table, state.settings, where)
	const target = quoteIdentPath(table.name)
	const head =
		kind === "delete"
			? `DELETE FROM ${target}`
			: dialect.clauses.alterTableUpdate === true
				? `ALTER TABLE ${target} UPDATE ${assignments.join(", ")}`
				: `UPDATE ${target} SET ${assignments.join(", ")}`
	const rendered = renderParams(`${head}${whereSql}${returning?.sql ?? ""}${settings}`, values, dialect)
	const scope = withReads({ scope: tenantScope, bound: tenantScope === "single-tenant" ? tenantBound : undefined }, reads)
	return writeCompiledQuery(rendered, kind, scope.scope, scope.bound, returning)
}
