// Query Builder
//
// Fluent builder with progressive type accumulation, inspired by Kysely's
// type-safe joins. Each method call refines the type parameters.
//
// Usage:
//   const q = CH.from(Traces)
//     .select($ => ({
//       bucket: CH.toStartOfInterval($.Timestamp, 60),
//       count: CH.count(),
//     }))
//     .where($ => [
//       $.OrgId.eq(CH.param.string("orgId")),
//     ])
//     .groupBy("bucket")
//     .orderBy(["bucket", "asc"])
//     .format("JSON")
//
// Type-safe joins:
//   CH.from(Traces)
//     .innerJoin(Events, "e", (main, e) => main.TraceId.eq(e.TraceId))
//     .select($ => ({
//       traceId: $.TraceId,
//       errorType: $.e.ErrorType,
//     }))

import type { ColumnDefs, CHType, InferTS, OutputToColumnDefs, NullableColumnDefs } from "./types"
import type { Table } from "./table"
import type { Expr, Condition, ColumnRef, ParamsIn, Widen } from "./expr"
import { makeColumnRef } from "./expr"
import type { TenantScope } from "./compile"

// Type utilities

/** A select callback reading each named column under its own key. */
const selectEvery =
	(columns: ReadonlyArray<string>) =>
	($: any): Record<string, any> =>
		Object.fromEntries(columns.map((column) => [column, $[column]]))

export type ColumnAccessor<Cols extends ColumnDefs> = {
	readonly [K in keyof Cols & string]: ColumnRef<K, Cols[K]>
}

/** Combined accessor: main table columns + nested alias accessors for joins. */
export type JoinedColumnAccessor<
	Cols extends ColumnDefs,
	Joins extends Record<string, ColumnDefs>,
> = ColumnAccessor<Cols> & {
	readonly [A in keyof Joins & string]: ColumnAccessor<Joins[A]>
}

type SelectRecord = Record<string, Expr<any>>

/**
 * Read each selected expression's output type off its `_phantom` property
 * rather than `S[K] extends Expr<infer T>`. Structural inference prefers the
 * contravariant candidates in the comparison methods, and those are widened
 * (`Widen<TSType>`) so literal-union columns accept plain params — inferring
 * through them resolved such a column's output to the bare primitive. The indexed
 * read is exact; `Exclude` only strips the `undefined` that `_phantom`'s
 * optionality adds, so a `Nullable(...)` column's `| null` survives.
 */
export type InferOutput<S extends SelectRecord> = {
	readonly [K in keyof S]: S[K] extends Expr<any> ? Exclude<S[K]["_phantom"], undefined> : never
}

type OrderBySpec<Output> = [keyof Output & string, "asc" | "desc"]

/** How a locking clause waits for rows another transaction holds. */
export interface LockOptions {
	/** `SKIP LOCKED`: leave out rows another transaction has locked. */
	readonly skipLocked?: boolean
	/** `NOWAIT`: fail at once instead of waiting. Not with `skipLocked`. */
	readonly noWait?: boolean
	/**
	 * `OF name, ...`: lock only these tables' rows. Each is an alias or an
	 * unqualified table name (`jobs`, not `public.jobs`, which Postgres refuses).
	 */
	readonly of?: ReadonlyArray<string>
}

/** @internal — the locking clause of a query. */
export interface LockClause extends LockOptions {
	readonly strength: "UPDATE" | "NO KEY UPDATE" | "SHARE" | "KEY SHARE"
}

/** Callback for ON conditions — receives main and joined column accessors. */
export type JoinOnCallback<MainCols extends ColumnDefs, JoinedCols extends ColumnDefs, P = never> = (
	main: ColumnAccessor<MainCols>,
	joined: ColumnAccessor<JoinedCols>,
) => Condition<P>

// Query state (runtime storage)

interface TypedJoinClause {
	readonly type: "INNER" | "LEFT" | "CROSS"
	/** Table name for direct table joins. */
	readonly tableName?: string
	/** Inner query for subquery joins (compiled lazily at compileCH time). */
	readonly innerQuery?: CHQuery<any, any, any>
	readonly alias: string
	/** ON callback, evaluated during compilation with source codecs. Omitted for CROSS JOIN. */
	readonly on?: JoinOnCallback<any, any>
	/** The joined table's tenant column, if it declared one. */
	readonly tenantColumn?: string
	/** The joined table's column definitions, for decoding joined selections. */
	readonly columns?: ColumnDefs
}

export interface CHQueryState {
	readonly tableName: string
	readonly tableAlias?: string
	readonly columns: ColumnDefs
	readonly selectFn?: ($: any) => SelectRecord
	readonly whereFn?: ($: any) => ReadonlyArray<Condition | undefined>
	readonly groupByKeys: string[]
	/** Post-aggregation filter. Deliberately NOT consulted when deriving tenant
	 *  scope — see `having()` on the interface. */
	readonly havingFn?: ($: any) => ReadonlyArray<Condition | undefined>
	readonly orderBySpecs: Array<[string, "asc" | "desc"]>
	readonly limitValue?: number
	readonly offsetValue?: number
	readonly formatValue?: string
	/** Set by `distinct` (`true`) or `distinctOn` (the output aliases). */
	readonly distinct?: true | ReadonlyArray<string>
	/** Set by `forUpdate` and the other locking methods. */
	readonly lock?: LockClause
	/** Execution-route metadata carried onto the CompiledQuery (see compile.ts). */
	readonly routeValue?: string
	/** Set by `.crossTenant()`. Forces `tenantScope: "cross-tenant"` (see compile.ts). */
	readonly crossTenant?: boolean
	/** The FROM table's declared tenant column, if any. Propagated to the column
	 *  accessors so an `eq`/`in_` on it marks the query scoped. */
	readonly tenantColumn?: string
	/** Typed FROM subquery. Compiled lazily at compileCH time. */
	readonly fromQuery?: CHQuery<any, any, any>
	readonly fromQueryAlias?: string
	/** Typed FROM union (UNION ALL of branches with identical Output shape). */
	readonly fromUnion?: import("./union").CHUnionQuery<any>
	/** Typed joins (compiled lazily at compileCH time). */
	readonly typedJoins: TypedJoinClause[]
	/** CTE definitions prepended as WITH clauses. Either pre-compiled SQL with a
	 *  caller-asserted scope, or a query compiled lazily at compileCH time whose
	 *  scope is derived. */
	readonly ctes: Array<{
		name: string
		sql?: string
		query?: CHQuery<any, any, any>
		tenantScope?: TenantScope
	}>
}

/**
 * A join alias, refused at the type level when it is already a join alias or
 * a column of the FROM source: `$.<alias>` would name two things, and SQL with
 * two sources under one name is ambiguous. A clash with the FROM alias itself,
 * or with a CTE, is refused when compiling.
 */
export type FreshAlias<Alias extends string, Cols extends ColumnDefs, Joins extends Record<string, ColumnDefs>> = Alias &
	(Alias extends KnownKeys<Cols> | KnownKeys<Joins> ? { readonly aliasAlreadyInUse: Alias } : unknown)

/** The literal keys of a record: none for an open one (`Record<string, …>`), whose keys name nothing in use. */
type KnownKeys<R> = string extends keyof R ? never : keyof R & string

/** The row a query selects. */
export type OutputOf<Q> = Q extends { readonly _phantom?: { readonly output: infer O } } ? O : never

/**
 * `unknown` once a query has a SELECT list, otherwise a property saying so.
 * Intersected with a query argument, it turns "this query selects nothing" into
 * a type error wherever the query is run or used as a source.
 */
export type NeedsSelect<Output> = [keyof Output] extends [never]
	? { readonly selectRequired: "call select() first: a query with no SELECT list cannot be run or read from" }
	: unknown

/**
 * Whether two column types can meet in one SQL column: one (without its
 * NULL, and widened as comparisons widen) must be assignable to the other.
 */
export type CompatibleTypes<A, B> = [Widen<NonNullable<A>>] extends [Widen<NonNullable<B>>]
	? true
	: [Widen<NonNullable<B>>] extends [Widen<NonNullable<A>>]
		? true
		: false

/**
 * `unknown` when a query selects exactly one column that can meet `T`, as
 * `expr IN (subquery)` needs; otherwise a property naming what is wrong.
 */
export type SingleColumnOf<Output, T> = 0 extends 1 & Output
	? unknown
	: [keyof Output] extends [never]
	? NeedsSelect<Output>
	: IsUnion<keyof Output> extends true
		? { readonly subqueryMustSelectOneColumn: keyof Output }
		: CompatibleTypes<T, Output[keyof Output]> extends true
			? unknown
			: { readonly subqueryColumnTypeDiffers: Output[keyof Output] }

type IsUnion<A, B = A> = A extends unknown ? ([B] extends [A] ? false : true) : never

// CHQuery interface

export interface CHQuery<
	Cols extends ColumnDefs = ColumnDefs,
	Output extends Record<string, any> = {},
	Joins extends Record<string, ColumnDefs> = {},
	Route extends string | undefined = string | undefined,
	/** The `param.*` placeholders the query uses, as `ParamEntry`s. */
	Params = never,
> {
	/** @internal — runtime query state */
	readonly _state: CHQueryState
	/** phantom */
	readonly _phantom?: { cols: Cols; output: Output; joins: Joins; route: Route; params: (entries: Params) => void }

	/** Select every column of the FROM table, as drizzle's bare `select()` does. Output keys are the column keys. */
	select(): CHQuery<Cols, { readonly [K in keyof Cols]: InferTS<Cols[K]> }, Joins, Route, Params>

	/** Select specific columns by name. Output keys match column names. */
	select<K extends keyof Cols & string>(
		...columns: K[]
	): CHQuery<Cols, { readonly [P in K]: InferTS<Cols[P]> }, Joins, Route, Params>

	/** Select computed expressions via callback. */
	select<S extends SelectRecord>(
		fn: ($: JoinedColumnAccessor<Cols, Joins>) => S,
	): CHQuery<Cols, InferOutput<S>, Joins, Route, Params | ParamsIn<S[keyof S]>>

	/**
	 * Filter rows: conditions AND-joined, an `undefined` one skipped. Calling it
	 * again adds conditions, ANDed with the earlier ones.
	 */
	where<const C extends ReadonlyArray<Condition | undefined>>(
		fn: ($: JoinedColumnAccessor<Cols, Joins>) => C,
	): CHQuery<Cols, Output, Joins, Route, Params | ParamsIn<C[number]>>

	groupBy(...keys: Array<keyof Output & string>): CHQuery<Cols, Output, Joins, Route, Params>

	/**
	 * Post-aggregation filter, applied after `GROUP BY`.
	 *
	 * Output aliases are not on the column accessor, so reference them with
	 * `CH.dynamicColumn<T>("alias")`.
	 *
	 * A `HAVING` predicate on the tenant column does NOT make a query
	 * tenant-scoped: the rows are already aggregated by then, so the scan that
	 * produced them crossed tenants regardless. Scope comes only from the
	 * top-level `where` list.
	 *
	 * Calling it again adds conditions, as `where` does.
	 */
	having<const C extends ReadonlyArray<Condition | undefined>>(
		fn: ($: JoinedColumnAccessor<Cols, Joins>) => C,
	): CHQuery<Cols, Output, Joins, Route, Params | ParamsIn<C[number]>>

	orderBy(...specs: Array<OrderBySpec<Output>>): CHQuery<Cols, Output, Joins, Route, Params>

	/** At most `n` rows: a non-negative integer. */
	limit<N extends number>(n: RowCount<N>): CHQuery<Cols, Output, Joins, Route, Params>

	/** Skip `n` rows: a non-negative integer. */
	offset<N extends number>(n: RowCount<N>): CHQuery<Cols, Output, Joins, Route, Params>

	format(fmt: "JSON" | "JSONEachRow"): CHQuery<Cols, Output, Joins, Route, Params>

	/** `SELECT DISTINCT`: drop duplicate output rows. */
	distinct(): CHQuery<Cols, Output, Joins, Route, Params>

	/**
	 * `SELECT DISTINCT ON (keys)`: keep the first row of each group of these
	 * output aliases, in ORDER BY order (Postgres wants the keys to lead the
	 * ORDER BY). Replaces `distinct()`.
	 */
	distinctOn(...keys: [keyof Output & string, ...Array<keyof Output & string>]): CHQuery<Cols, Output, Joins, Route, Params>

	/**
	 * `FOR UPDATE`: lock the selected rows until the transaction ends. Run it
	 * inside `Database.transaction`. Postgres only; replaces any earlier lock.
	 */
	forUpdate(options?: LockOptions): CHQuery<Cols, Output, Joins, Route, Params>
	/** `FOR NO KEY UPDATE`: as `forUpdate`, without blocking inserts that reference the rows. */
	forNoKeyUpdate(options?: LockOptions): CHQuery<Cols, Output, Joins, Route, Params>
	/** `FOR SHARE`: a shared lock, which blocks writers but not other sharers. */
	forShare(options?: LockOptions): CHQuery<Cols, Output, Joins, Route, Params>
	/** `FOR KEY SHARE`: the weakest lock, blocking only deletes and key updates. */
	forKeyShare(options?: LockOptions): CHQuery<Cols, Output, Joins, Route, Params>

	/**
	 * Tag this query with an execution route, carried through to the compiled
	 * query as a type-level fact. The tag is opaque to the builder: what routes
	 * exist, and what an executor does with one, is the caller's vocabulary.
	 */
	route<NewRoute extends string>(route: NewRoute): CHQuery<Cols, Output, Joins, NewRoute, Params>

	/**
	 * Declare that this query deliberately reads across every tenant, forcing
	 * `tenantScope: "cross-tenant"` on the compiled result.
	 *
	 * Opting in explicitly rather than relying on the absence of a tenant
	 * predicate is the whole point: "no tenant filter" is indistinguishable from
	 * "someone forgot the tenant filter" until an author says which. Executors
	 * are expected to refuse these on the ordinary read path.
	 */
	crossTenant(): CHQuery<Cols, Output, Joins, Route, Params>

	// Type-safe joins with Table

	innerJoin<JName extends string, JCols extends ColumnDefs, Alias extends string, OnParams = never>(
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, JCols, OnParams>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: JCols }, Route, Params | OnParams>

	leftJoin<JName extends string, JCols extends ColumnDefs, Alias extends string, OnParams = never>(
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, JCols, OnParams>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: NullableColumnDefs<JCols> }, Route, Params | OnParams>

	crossJoin<JName extends string, JCols extends ColumnDefs, Alias extends string>(
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: JCols }, Route, Params>

	// Type-safe joins with subquery (CHQuery)

	innerJoinQuery<
		JCols extends ColumnDefs,
		JOutput extends Record<string, any>,
		JJoins extends Record<string, ColumnDefs>,
		Alias extends string,
		JParams = never,
		OnParams = never,
	>(
		query: CHQuery<JCols, JOutput, JJoins, string | undefined, JParams> & NeedsSelect<JOutput>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, OutputToColumnDefs<JOutput>, OnParams>,
	): CHQuery<
		Cols,
		Output,
		Joins & { readonly [K in Alias]: OutputToColumnDefs<JOutput> },
		Route,
		Params | JParams | OnParams
	>

	leftJoinQuery<
		JCols extends ColumnDefs,
		JOutput extends Record<string, any>,
		JJoins extends Record<string, ColumnDefs>,
		Alias extends string,
		JParams = never,
		OnParams = never,
	>(
		query: CHQuery<JCols, JOutput, JJoins, string | undefined, JParams> & NeedsSelect<JOutput>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, OutputToColumnDefs<JOutput>, OnParams>,
	): CHQuery<
		Cols,
		Output,
		Joins & { readonly [K in Alias]: NullableColumnDefs<OutputToColumnDefs<JOutput>> },
		Route,
		Params | JParams | OnParams
	>

	crossJoinQuery<
		JCols extends ColumnDefs,
		JOutput extends Record<string, any>,
		JJoins extends Record<string, ColumnDefs>,
		Alias extends string,
		JParams = never,
	>(
		query: CHQuery<JCols, JOutput, JJoins, string | undefined, JParams> & NeedsSelect<JOutput>,
		alias: FreshAlias<Alias, Cols, Joins>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: OutputToColumnDefs<JOutput> }, Route, Params | JParams>

	/**
	 * Add a CTE (WITH clause). The CTE is prepended to the compiled query, and
	 * its name can then be used as a table name via `from()` or in raw
	 * expressions.
	 *
	 * Prefer this arm: the CTE is compiled at `compileCH` time and its tenant
	 * scope is *derived*, so a query whose only row source is a scoped CTE is
	 * itself scoped without anyone asserting it.
	 */
	withCTE<CTEOutput extends Record<string, any>, CTEParams = never>(
		name: string,
		query: CHQuery<any, CTEOutput, any, string | undefined, CTEParams> & NeedsSelect<CTEOutput>,
	): CHQuery<Cols, Output, Joins, Route, Params | CTEParams>

	/**
	 * Attach a CTE from pre-compiled SQL.
	 *
	 * `tenantScope` describes the SQL being passed in. It cannot be inferred —
	 * the CTE arrives as an opaque string — so a caller splicing in a query it
	 * compiled itself should pass the scope through, otherwise a query whose only
	 * row source is a scoped CTE reads as cross-tenant. Pass the query itself
	 * instead where you can, and this problem goes away.
	 */
	withCTE(
		name: string,
		sql: string,
		options?: { readonly tenantScope?: TenantScope },
	): CHQuery<Cols, Output, Joins, Route, Params>
}

// Type utilities for extracting output types from queries

/**
 * Extract the Output type from a `CHQuery` or a `CHUnionQuery`.
 *
 * The union arm matters as much as the query arm: a builder returning
 * `CHUnionQuery<Row>` used to infer `never` here, which reads as "this query
 * has no output" rather than as the error it is, and quietly passed any
 * type-level assertion made about it.
 */
export type InferQueryOutput<Q> =
	Q extends CHQuery<any, infer O, any>
		? O
		: Q extends import("./union").CHUnionQuery<infer U extends Record<string, any>>
			? U
			: never

/** SQL qualifier shared by SELECT/WHERE and deferred join callbacks. */
export function sourceAlias(state: CHQueryState): string {
	if (state.tableAlias !== undefined) return state.tableAlias
	if (state.fromQueryAlias !== undefined) return state.fromQueryAlias
	if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(state.tableName)) return state.tableName
	const aliases = new Set(state.typedJoins.map((join) => join.alias))
	let alias = "__ch_source"
	while (aliases.has(alias)) alias += "_"
	return alias
}

// ColumnAccessor factory (Proxy-based)

export function createColumnAccessor<Cols extends ColumnDefs>(
	columns: Cols,
	tenantColumn?: string,
): ColumnAccessor<Cols> {
	const cache = new Map<string, ColumnRef<string, CHType<string, any>>>()

	return new Proxy({} as ColumnAccessor<Cols>, {
		get(_target, prop) {
			if (typeof prop !== "string") return undefined
			let ref = cache.get(prop)
			if (!ref) {
				ref = makeColumnRef(prop, undefined, tenantColumn, columns[prop])
				cache.set(prop, ref)
			}
			return ref
		},
	})
}

// Qualified ColumnAccessor for joined tables (generates alias.Column SQL)

export function createQualifiedColumnAccessor(
	alias: string,
	tenantColumn?: string,
	columns?: ColumnDefs,
): ColumnAccessor<any> {
	const cache = new Map<string, ColumnRef<string, CHType<string, any>>>()

	return new Proxy({} as ColumnAccessor<any>, {
		get(_target, prop) {
			if (typeof prop !== "string") return undefined
			let ref = cache.get(prop)
			if (!ref) {
				ref = makeColumnRef(`${alias}.${prop}`, prop, tenantColumn, columns?.[prop])
				cache.set(prop, ref)
			}
			return ref
		},
	})
}

// Joined ColumnAccessor — main columns + nested alias accessors

export function createJoinedColumnAccessor<Cols extends ColumnDefs, Joins extends Record<string, ColumnDefs>>(
	columns: Cols,
	joinAliases: readonly string[],
	mainAlias?: string,
	/** The FROM table's tenant column. */
	tenantColumn?: string,
	/** Per-join-alias tenant columns, so `$.p.TenantId.eq(…)` scopes when the
	 *  joined table declares one of its own. */
	joinTenantColumns?: Readonly<Record<string, string | undefined>>,
	/** Per-join-alias column definitions, so joined refs decode like their own
	 *  table's columns rather than losing their schema at the alias boundary. */
	joinColumns?: Readonly<Record<string, ColumnDefs | undefined>>,
): JoinedColumnAccessor<Cols, Joins> {
	const cache = new Map<string, any>()
	const aliasSet = new Set(joinAliases)

	return new Proxy({} as JoinedColumnAccessor<Cols, Joins>, {
		get(_target, prop) {
			if (typeof prop !== "string") return undefined
			let cached = cache.get(prop)
			if (cached) return cached

			if (aliasSet.has(prop)) {
				// Return a nested proxy for the joined table's columns
				cached = createQualifiedColumnAccessor(prop, joinTenantColumns?.[prop], joinColumns?.[prop])
				cache.set(prop, cached)
				return cached
			}

			// Main table column — qualify with alias when joins are present
			const qualifiedName = mainAlias ? `${mainAlias}.${prop}` : prop
			cached = makeColumnRef(qualifiedName, prop, tenantColumn, columns[prop])
			cache.set(prop, cached)
			return cached
		},
	})
}

// Query builder implementation

type ConditionsFn = ($: any) => ReadonlyArray<Condition | undefined>

/** A second `where` (or `having`) ANDs with the first, as in Kysely: replacing
 *  it would silently drop a filter, the tenant one included. */
export const appendConditions = (previous: ConditionsFn | undefined, next: ConditionsFn): ConditionsFn =>
	previous === undefined ? next : ($) => [...previous($), ...next($)]

/**
 * A row count for `limit` / `offset`: a literal that is negative or has a
 * fraction is a type error. Any other value is checked when compiling.
 */
export type RowCount<N extends number> = number extends N
	? N
	: `${N}` extends `-${string}` | `${string}.${string}` | `${string}e${string}`
		? never
		: N

function makeQuery<
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
	Joins extends Record<string, ColumnDefs>,
	Route extends string | undefined,
>(state: CHQueryState): CHQuery<Cols, Output, Joins, Route, any> {
	return {
		_state: state,

		select(...args: any[]): any {
			if (args.length === 0) return makeQuery({ ...state, selectFn: selectEvery(Object.keys(state.columns)) })
			// String overload: select("Col1", "Col2") → select($ => ({ Col1: $.Col1, Col2: $.Col2 }))
			if (typeof args[0] === "string") return makeQuery({ ...state, selectFn: selectEvery(args as string[]) })
			// Callback overload: select($ => ({ ... }))
			return makeQuery({ ...state, selectFn: args[0] })
		},

		where(fn) {
			return makeQuery({ ...state, whereFn: appendConditions(state.whereFn, fn) })
		},

		groupBy(...keys) {
			return makeQuery({ ...state, groupByKeys: keys as string[] })
		},

		having(fn) {
			return makeQuery({ ...state, havingFn: appendConditions(state.havingFn, fn) })
		},

		orderBy(...specs) {
			return makeQuery({ ...state, orderBySpecs: specs as Array<[string, "asc" | "desc"]> })
		},

		limit(n) {
			return makeQuery({ ...state, limitValue: n })
		},

		offset(n) {
			return makeQuery({ ...state, offsetValue: n })
		},

		format(fmt) {
			return makeQuery({ ...state, formatValue: fmt })
		},

		distinct() {
			return makeQuery({ ...state, distinct: true })
		},

		distinctOn(...keys) {
			return makeQuery({ ...state, distinct: keys as ReadonlyArray<string> })
		},

		forUpdate(options = {}) {
			return makeQuery({ ...state, lock: { strength: "UPDATE", ...options } })
		},

		forNoKeyUpdate(options = {}) {
			return makeQuery({ ...state, lock: { strength: "NO KEY UPDATE", ...options } })
		},

		forShare(options = {}) {
			return makeQuery({ ...state, lock: { strength: "SHARE", ...options } })
		},

		forKeyShare(options = {}) {
			return makeQuery({ ...state, lock: { strength: "KEY SHARE", ...options } })
		},

		route(route) {
			return makeQuery({ ...state, routeValue: route })
		},

		crossTenant() {
			return makeQuery({ ...state, crossTenant: true })
		},

		// Type-safe joins with Table

		innerJoin(table, alias, onFn) {
			return makeQuery({
				...state,
				typedJoins: [
					...state.typedJoins,
					{
						type: "INNER",
						tableName: table.name,
						alias,
						on: onFn,
						tenantColumn: table.tenantColumn,
						columns: table.columns,
					},
				],
			}) as any
		},

		leftJoin(table, alias, onFn) {
			return makeQuery({
				...state,
				typedJoins: [
					...state.typedJoins,
					{
						type: "LEFT",
						tableName: table.name,
						alias,
						on: onFn,
						tenantColumn: table.tenantColumn,
						columns: table.columns,
					},
				],
			}) as any
		},

		crossJoin(table, alias) {
			return makeQuery({
				...state,
				typedJoins: [
					...state.typedJoins,
					{
						type: "CROSS",
						tableName: table.name,
						alias,
						tenantColumn: table.tenantColumn,
						columns: table.columns,
					},
				],
			}) as any
		},

		// Type-safe joins with subquery (CHQuery)

		innerJoinQuery(query, alias, onFn) {
			return makeQuery({
				...state,
				typedJoins: [...state.typedJoins, { type: "INNER", innerQuery: query, alias, on: onFn }],
			}) as any
		},

		leftJoinQuery(query, alias, onFn) {
			return makeQuery({
				...state,
				typedJoins: [...state.typedJoins, { type: "LEFT", innerQuery: query, alias, on: onFn }],
			}) as any
		},

		crossJoinQuery(query, alias) {
			return makeQuery({
				...state,
				typedJoins: [...state.typedJoins, { type: "CROSS", innerQuery: query, alias }],
			}) as any
		},

		withCTE(
			name: string,
			sqlOrQuery: string | CHQuery<any, any, any>,
			options?: { tenantScope?: TenantScope },
		): any {
			// The query arm is compiled lazily in compileCH (like `fromQuery`), so
			// its scope is derived there rather than taken from the caller.
			const cte =
				typeof sqlOrQuery === "string"
					? { name, sql: sqlOrQuery, tenantScope: options?.tenantScope }
					: { name, query: sqlOrQuery }
			return makeQuery({ ...state, ctes: [...state.ctes, cte] })
		},
	}
}

// Entry points

export function from<Name extends string, Cols extends ColumnDefs>(
	table: Table<Name, Cols>,
	alias?: string,
): CHQuery<Cols, {}, {}, undefined> {
	return makeQuery({
		tableName: table.name,
		tableAlias: alias,
		columns: table.columns,
		tenantColumn: table.tenantColumn,
		groupByKeys: [],
		orderBySpecs: [],
		typedJoins: [],
		ctes: [],
	})
}

/**
 * Start a query from another query's output (type-safe subquery in FROM).
 *
 * The alias names the derived table in SQL; it does NOT namespace the accessor.
 * Inner columns are reached flat (`$.traceId`) — `$.sub.traceId` is undefined
 * and throws when compiled.
 *
 * Usage:
 *   const inner = CH.from(Events).select($ => ({ id: $.Id }))
 *   const outer = CH.fromQuery(inner, "sub")
 *     .select($ => ({ id: $.id })) // fully typed!
 */
export function fromQuery<
	InnerCols extends ColumnDefs,
	InnerOutput extends Record<string, any>,
	InnerJoins extends Record<string, ColumnDefs>,
	Alias extends string,
	InnerParams = never,
>(
	query: CHQuery<InnerCols, InnerOutput, InnerJoins, string | undefined, InnerParams> & NeedsSelect<InnerOutput>,
	alias: Alias,
): CHQuery<OutputToColumnDefs<InnerOutput>, {}, {}, undefined, InnerParams> {
	return makeQuery({
		tableName: alias,
		columns: {},
		groupByKeys: [],
		orderBySpecs: [],
		typedJoins: [],
		ctes: [],
		// An outer re-filter on the same column name is still a tenant predicate;
		// if the inner SELECT renamed it, no such column exists to filter on.
		tenantColumn: query._state.tenantColumn,
		fromQuery: query,
		fromQueryAlias: alias,
	})
}

/**
 * Start a query from a UNION ALL of typed branches (type-safe subquery in
 * FROM). Use this when you need an outer aggregation/grouping over multiple
 * branches that share an Output shape — for example combining a sealed
 * hourly-MV branch with a live raw-table fallback for the in-progress hour,
 * then re-aggregating across the union.
 *
 * Usage:
 *   const branchA = CH.from(MvTable).select(...).where(...).groupBy(...)
 *   const branchB = CH.from(RawTable).select(...).where(...).groupBy(...)
 *   const combined = CH.unionAll(branchA, branchB)
 *   const outer = CH.fromUnion(combined, "edges")
 *     .select($ => ({ ..., total: CH.sum($.edges.partial) }))
 *     .groupBy("...")
 */
export function fromUnion<Output extends Record<string, any>, Alias extends string, UnionParams = never>(
	union: import("./union").CHUnionQuery<Output, UnionParams>,
	alias: Alias,
): CHQuery<OutputToColumnDefs<Output>, {}, {}, undefined, UnionParams> {
	return makeQuery({
		tableName: alias,
		columns: {},
		groupByKeys: [],
		orderBySpecs: [],
		typedJoins: [],
		ctes: [],
		fromUnion: union,
		fromQueryAlias: alias,
	})
}
