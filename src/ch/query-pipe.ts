// The pipeable, data-last query API: `Query.where`, `Query.orderBy`, … next to
// the fluent builder. Each function is a `dual` that calls the fluent method, so
// both styles share one implementation and write the same SQL.
//
//   Query.from(Users).pipe(
//     Query.select(($) => ({ id: $.Id })),
//     Query.where(($) => [$.OrgId.eq(orgId)]),
//     Query.orderBy(["id", "asc"]),
//   )
//
// A data-last function learns the query's column types from where `pipe` puts
// it, so `$` in a callback is typed as in the fluent form.

import { dual } from "effect/Function"
import type { AllFacts, Condition, Expr, ParamsIn } from "./expr"
import type { TenantScope } from "./compile"
import type {
	BindSources,
	CHQuery,
	FreshAlias,
	InferOutput,
	JoinedColumnAccessor,
	JoinOnCallback,
	JoinParams,
	LockOptions,
	NarrowJoins,
	NeedsSelect,
	OwnSources,
	RowCount,
	RowLock,
	SelectRecord,
} from "./query"
import type { Table } from "./table"
import type { ColumnDefs, InferTS, NullableColumnDefs, OutputToColumnDefs } from "./types"

export { from, fromQuery, fromUnion } from "./query"

/** `true` for a query, the first argument of a data-first call. */
const isQuery = (u: unknown): u is CHQuery<any, any, any, any, any> =>
	typeof u === "object" && u !== null && "_state" in u && typeof (u as { pipe?: unknown }).pipe === "function"

/** `query.where(fn)`: conditions AND-joined with the earlier ones. */
export const where: {
	<Cols extends ColumnDefs, Joins extends Record<string, ColumnDefs>, Source extends string, const C extends ReadonlyArray<Condition | undefined>>(
		fn: ($: JoinedColumnAccessor<Cols, Joins, Source>) => C,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, NarrowJoins<Joins, AllFacts<C>>, Route, Params | BindSources<ParamsIn<C[number]>, OwnSources<Source, Joins>>, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		const C extends ReadonlyArray<Condition | undefined>,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		fn: ($: JoinedColumnAccessor<Cols, Joins, Source>) => C,
	): CHQuery<Cols, Output, NarrowJoins<Joins, AllFacts<C>>, Route, Params | BindSources<ParamsIn<C[number]>, OwnSources<Source, Joins>>, Source>
} = dual(2, (self: CHQuery<any, any, any, any, any>, fn: any) => self.where(fn))

/**
 * `query.select(...)`, in its three forms: every column (`select()`), columns by
 * name (`select("Id", "Name")`) or a callback (`select(($) => ({ ... }))`).
 * Replaces an earlier projection.
 */
export const select: {
	(): <Cols extends ColumnDefs, Output extends Record<string, any>, Joins extends Record<string, ColumnDefs>, Source extends string, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, { readonly [K in keyof Cols]: InferTS<Cols[K]> }, Joins, Route, Params, Source>
	<Cols extends ColumnDefs, Joins extends Record<string, ColumnDefs>, Source extends string, S extends SelectRecord>(
		fn: ($: JoinedColumnAccessor<Cols, Joins, Source>) => S,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, InferOutput<S>, Joins, Route, Params | BindSources<ParamsIn<S[keyof S]>, OwnSources<Source, Joins>>, Source>
	<Cols extends ColumnDefs, K extends keyof Cols & string>(
		...columns: [K, ...Array<K>]
	): <Output extends Record<string, any>, Joins extends Record<string, ColumnDefs>, Source extends string, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, { readonly [P in K]: InferTS<Cols[P]> }, Joins, Route, Params, Source>
	<Cols extends ColumnDefs, Output extends Record<string, any>, Joins extends Record<string, ColumnDefs>, Source extends string, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	): CHQuery<Cols, { readonly [K in keyof Cols]: InferTS<Cols[K]> }, Joins, Route, Params, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		S extends SelectRecord,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		fn: ($: JoinedColumnAccessor<Cols, Joins, Source>) => S,
	): CHQuery<Cols, InferOutput<S>, Joins, Route, Params | BindSources<ParamsIn<S[keyof S]>, OwnSources<Source, Joins>>, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		K extends keyof Cols & string,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		...columns: [K, ...Array<K>]
	): CHQuery<Cols, { readonly [P in K]: InferTS<Cols[P]> }, Joins, Route, Params, Source>
} = dual(
	(args) => isQuery(args[0]),
	(self: CHQuery<any, any, any, any, any>, ...args: Array<any>) => (self.select as (...args: Array<any>) => unknown)(...args),
)

type Direction = "asc" | "desc"

/**
 * `query.orderBy(...)`: by output keys (`orderBy(["at", "desc"])`) or by
 * expressions of the source's columns (`orderBy(($) => [[$.CreatedAt, "desc"]])`).
 * Replaces an earlier order. Data-last, a key the query does not select is a
 * type error where the function meets the query in `pipe`.
 */
export const orderBy: {
	<Cols extends ColumnDefs, Joins extends Record<string, ColumnDefs>, Source extends string, Q = never>(
		fn: ($: JoinedColumnAccessor<Cols, Joins, Source>) => ReadonlyArray<readonly [Expr<any, Q>, Direction]>,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, Joins, Route, Params | BindSources<Q, OwnSources<Source, Joins>>, Source>
	<K extends string>(
		...specs: [readonly [K, Direction], ...Array<readonly [K, Direction]>]
	): <
		Cols extends ColumnDefs,
		Output extends Record<K, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, Joins, Route, Params, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		Q = never,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		fn: ($: JoinedColumnAccessor<Cols, Joins, Source>) => ReadonlyArray<readonly [Expr<any, Q>, Direction]>,
	): CHQuery<Cols, Output, Joins, Route, Params | BindSources<Q, OwnSources<Source, Joins>>, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		...specs: [readonly [keyof Output & string, Direction], ...Array<readonly [keyof Output & string, Direction]>]
	): CHQuery<Cols, Output, Joins, Route, Params, Source>
} = dual(
	(args) => isQuery(args[0]),
	(self: CHQuery<any, any, any, any, any>, ...args: Array<any>) => (self.orderBy as (...args: Array<any>) => unknown)(...args),
)

/** `query.limit(n)`: at most `n` rows, a non-negative integer. Replaces an earlier limit. */
export const limit: {
	<N extends number>(
		n: RowCount<N>,
	): <
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, Joins, Route, Params, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		N extends number,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		n: RowCount<N>,
	): CHQuery<Cols, Output, Joins, Route, Params, Source>
} = dual(2, (self: CHQuery<any, any, any, any, any>, n: number) => self.limit(n))

/** `query.innerJoin(table, alias, on)`: `$.<alias>` reads the joined table. */
export const innerJoin: {
	<
		Cols extends ColumnDefs,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		JName extends string,
		JCols extends ColumnDefs,
		Alias extends string,
		OnParams = never,
	>(
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, JCols, OnParams, Source, Alias>,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, Joins & { readonly [K in Alias]: JCols }, Route, JoinParams<Params, OnParams, Source, Joins, Alias>, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		JName extends string,
		JCols extends ColumnDefs,
		Alias extends string,
		OnParams = never,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, JCols, OnParams, Source, Alias>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: JCols }, Route, JoinParams<Params, OnParams, Source, Joins, Alias>, Source>
} = dual(4, (self: CHQuery<any, any, any, any, any>, table: Table<any, any>, alias: any, on: any) =>
	self.innerJoin(table, alias, on),
)

/** `query.leftJoin(table, alias, on)`: as `innerJoin`, with the joined columns nullable. */
export const leftJoin: {
	<
		Cols extends ColumnDefs,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		JName extends string,
		JCols extends ColumnDefs,
		Alias extends string,
		OnParams = never,
	>(
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, JCols, OnParams, Source, Alias>,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, Joins & { readonly [K in Alias]: NullableColumnDefs<JCols> }, Route, JoinParams<Params, OnParams, Source, Joins, Alias>, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		JName extends string,
		JCols extends ColumnDefs,
		Alias extends string,
		OnParams = never,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, JCols, OnParams, Source, Alias>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: NullableColumnDefs<JCols> }, Route, JoinParams<Params, OnParams, Source, Joins, Alias>, Source>
} = dual(4, (self: CHQuery<any, any, any, any, any>, table: Table<any, any>, alias: any, on: any) =>
	self.leftJoin(table, alias, on),
)

/** `query.crossJoin(table, alias)`: every pair of rows. */
export const crossJoin: {
	<Cols extends ColumnDefs, Joins extends Record<string, ColumnDefs>, Source extends string, JName extends string, JCols extends ColumnDefs, Alias extends string>(
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, Joins & { readonly [K in Alias]: JCols }, Route, Params, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		JName extends string,
		JCols extends ColumnDefs,
		Alias extends string,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: JCols }, Route, Params, Source>
} = dual(3, (self: CHQuery<any, any, any, any, any>, table: Table<any, any>, alias: any) => self.crossJoin(table, alias))

/** `query.having(fn)`: post-aggregation conditions, AND-joined with the earlier ones. */
export const having: {
	<Cols extends ColumnDefs, Joins extends Record<string, ColumnDefs>, Source extends string, const C extends ReadonlyArray<Condition | undefined>>(
		fn: ($: JoinedColumnAccessor<Cols, Joins, Source>) => C,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, Joins, Route, Params | BindSources<ParamsIn<C[number]>, OwnSources<Source, Joins>>, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		const C extends ReadonlyArray<Condition | undefined>,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		fn: ($: JoinedColumnAccessor<Cols, Joins, Source>) => C,
	): CHQuery<Cols, Output, Joins, Route, Params | BindSources<ParamsIn<C[number]>, OwnSources<Source, Joins>>, Source>
} = dual(2, (self: CHQuery<any, any, any, any, any>, fn: any) => self.having(fn))

// The data-last half of a method that keeps the query's type.
type Same = <
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
	Joins extends Record<string, ColumnDefs>,
	Source extends string,
	Route extends string | undefined,
	Params,
>(
	self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
) => CHQuery<Cols, Output, Joins, Route, Params, Source>

/**
 * `query.groupBy(...keys)`: group by output keys. Data-last, a key the query
 * does not select is a type error where the function meets the query in `pipe`.
 */
export const groupBy: {
	<K extends string>(
		...keys: Array<K>
	): <
		Cols extends ColumnDefs,
		Output extends Record<K, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, Joins, Route, Params, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		...keys: Array<keyof Output & string>
	): CHQuery<Cols, Output, Joins, Route, Params, Source>
} = dual(
	(args) => isQuery(args[0]),
	(self: CHQuery<any, any, any, any, any>, ...keys: Array<string>) => self.groupBy(...keys),
)

/** `query.distinctOn(...keys)`: the first row of each group of these output keys. */
export const distinctOn: {
	<K extends string>(
		...keys: [K, ...Array<K>]
	): <
		Cols extends ColumnDefs,
		Output extends Record<K, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, Joins, Route, Params, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		...keys: [keyof Output & string, ...Array<keyof Output & string>]
	): CHQuery<Cols, Output, Joins, Route, Params, Source>
} = dual(
	(args) => isQuery(args[0]),
	(self: CHQuery<any, any, any, any, any>, ...keys: [string, ...Array<string>]) => self.distinctOn(...keys),
)

/** `query.offset(n)`: skip `n` rows, a non-negative integer. */
export const offset: {
	<N extends number>(n: RowCount<N>): Same
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		N extends number,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		n: RowCount<N>,
	): CHQuery<Cols, Output, Joins, Route, Params, Source>
} = dual(2, (self: CHQuery<any, any, any, any, any>, n: number) => self.offset(n))

/** `query.format(fmt)`: ClickHouse's `FORMAT` clause. As with the fluent method, other dialects refuse it at compile. */
export const format: {
	(fmt: "JSON" | "JSONEachRow"): Same
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		fmt: "JSON" | "JSONEachRow",
	): CHQuery<Cols, Output, Joins, Route, Params, Source>
} = dual(2, (self: CHQuery<any, any, any, any, any>, fmt: "JSON" | "JSONEachRow") => self.format(fmt))

// A method with no argument but the query: `Query.distinct()` in `pipe`,
// `Query.distinct(query)` data-first.
type Nullary = {
	(): Same
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	): CHQuery<Cols, Output, Joins, Route, Params, Source>
}

/** `query.distinct()`: `SELECT DISTINCT`. */
export const distinct: Nullary = dual(
	(args) => isQuery(args[0]),
	(self: CHQuery<any, any, any, any, any>) => self.distinct(),
)

/** `query.crossTenant()`: declare a deliberate read across every tenant. */
export const crossTenant: Nullary = dual(
	(args) => isQuery(args[0]),
	(self: CHQuery<any, any, any, any, any>) => self.crossTenant(),
)

// A row lock: `Query.forUpdate()` or `Query.forUpdate({ skipLocked: true })` in
// `pipe`, `Query.forUpdate(query, options?)` data-first. As with the fluent
// methods, the clause is a `RowLock` param, so a dialect without row locks
// refuses the query in the type and at compile.
type Lock<Clause extends string> = {
	(options?: LockOptions): <
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, Joins, Route, Params | RowLock<Clause>, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		options?: LockOptions,
	): CHQuery<Cols, Output, Joins, Route, Params | RowLock<Clause>, Source>
}

/** `query.forUpdate(options?)`. */
export const forUpdate: Lock<"FOR UPDATE"> = dual(
	(args) => isQuery(args[0]),
	(self: CHQuery<any, any, any, any, any>, options?: LockOptions) => self.forUpdate(options),
)
/** `query.forNoKeyUpdate(options?)`. */
export const forNoKeyUpdate: Lock<"FOR NO KEY UPDATE"> = dual(
	(args) => isQuery(args[0]),
	(self: CHQuery<any, any, any, any, any>, options?: LockOptions) => self.forNoKeyUpdate(options),
)
/** `query.forShare(options?)`. */
export const forShare: Lock<"FOR SHARE"> = dual(
	(args) => isQuery(args[0]),
	(self: CHQuery<any, any, any, any, any>, options?: LockOptions) => self.forShare(options),
)
/** `query.forKeyShare(options?)`. */
export const forKeyShare: Lock<"FOR KEY SHARE"> = dual(
	(args) => isQuery(args[0]),
	(self: CHQuery<any, any, any, any, any>, options?: LockOptions) => self.forKeyShare(options),
)

/** `query.route(route)`: tag the query with an execution route. */
export const route: {
	<NewRoute extends string>(
		route: NewRoute,
	): <
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, Joins, NewRoute, Params, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		NewRoute extends string,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		route: NewRoute,
	): CHQuery<Cols, Output, Joins, NewRoute, Params, Source>
} = dual(2, (self: CHQuery<any, any, any, any, any>, route: string) => self.route(route))

// The subquery joins take a query as their first data-last argument, so they
// tell the two forms apart by arity, not with `isQuery`.

/** `query.innerJoinQuery(subquery, alias, on)`: `$.<alias>` reads the subquery's output. */
export const innerJoinQuery: {
	<
		Cols extends ColumnDefs,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		JCols extends ColumnDefs,
		JOutput extends Record<string, any>,
		JJoins extends Record<string, ColumnDefs>,
		Alias extends string,
		JParams = never,
		OnParams = never,
	>(
		query: CHQuery<JCols, JOutput, JJoins, string | undefined, JParams> & NeedsSelect<JOutput>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, OutputToColumnDefs<JOutput>, OnParams, Source, Alias>,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, Joins & { readonly [K in Alias]: OutputToColumnDefs<JOutput> }, Route, JoinParams<Params, OnParams, Source, Joins, Alias> | JParams, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		JCols extends ColumnDefs,
		JOutput extends Record<string, any>,
		JJoins extends Record<string, ColumnDefs>,
		Alias extends string,
		JParams = never,
		OnParams = never,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		query: CHQuery<JCols, JOutput, JJoins, string | undefined, JParams> & NeedsSelect<JOutput>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, OutputToColumnDefs<JOutput>, OnParams, Source, Alias>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: OutputToColumnDefs<JOutput> }, Route, JoinParams<Params, OnParams, Source, Joins, Alias> | JParams, Source>
} = dual(4, (self: CHQuery<any, any, any, any, any>, query: any, alias: any, on: any) => self.innerJoinQuery(query, alias, on))

/** `query.leftJoinQuery(subquery, alias, on)`: as `innerJoinQuery`, with the subquery's columns nullable. */
export const leftJoinQuery: {
	<
		Cols extends ColumnDefs,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		JCols extends ColumnDefs,
		JOutput extends Record<string, any>,
		JJoins extends Record<string, ColumnDefs>,
		Alias extends string,
		JParams = never,
		OnParams = never,
	>(
		query: CHQuery<JCols, JOutput, JJoins, string | undefined, JParams> & NeedsSelect<JOutput>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, OutputToColumnDefs<JOutput>, OnParams, Source, Alias>,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<
		Cols,
		Output,
		Joins & { readonly [K in Alias]: NullableColumnDefs<OutputToColumnDefs<JOutput>> },
		Route,
		JoinParams<Params, OnParams, Source, Joins, Alias> | JParams
	>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		JCols extends ColumnDefs,
		JOutput extends Record<string, any>,
		JJoins extends Record<string, ColumnDefs>,
		Alias extends string,
		JParams = never,
		OnParams = never,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		query: CHQuery<JCols, JOutput, JJoins, string | undefined, JParams> & NeedsSelect<JOutput>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, OutputToColumnDefs<JOutput>, OnParams, Source, Alias>,
	): CHQuery<
		Cols,
		Output,
		Joins & { readonly [K in Alias]: NullableColumnDefs<OutputToColumnDefs<JOutput>> },
		Route,
		JoinParams<Params, OnParams, Source, Joins, Alias> | JParams
	>
} = dual(4, (self: CHQuery<any, any, any, any, any>, query: any, alias: any, on: any) => self.leftJoinQuery(query, alias, on))

/** `query.crossJoinQuery(subquery, alias)`: every pair of rows with the subquery's output. */
export const crossJoinQuery: {
	<
		Cols extends ColumnDefs,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		JCols extends ColumnDefs,
		JOutput extends Record<string, any>,
		JJoins extends Record<string, ColumnDefs>,
		Alias extends string,
		JParams = never,
	>(
		query: CHQuery<JCols, JOutput, JJoins, string | undefined, JParams> & NeedsSelect<JOutput>,
		alias: FreshAlias<Alias, Cols, Joins>,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, Joins & { readonly [K in Alias]: OutputToColumnDefs<JOutput> }, Route, BindSources<Params, Alias> | JParams, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		JCols extends ColumnDefs,
		JOutput extends Record<string, any>,
		JJoins extends Record<string, ColumnDefs>,
		Alias extends string,
		JParams = never,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		query: CHQuery<JCols, JOutput, JJoins, string | undefined, JParams> & NeedsSelect<JOutput>,
		alias: FreshAlias<Alias, Cols, Joins>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: OutputToColumnDefs<JOutput> }, Route, BindSources<Params, Alias> | JParams, Source>
} = dual(3, (self: CHQuery<any, any, any, any, any>, query: any, alias: any) => self.crossJoinQuery(query, alias))

/**
 * `query.withCTE(name, query)` or `query.withCTE(name, sql, options?)`. The
 * data-last form starts with the CTE's name, so a query first is data-first.
 */
export const withCTE: {
	<CTEOutput extends Record<string, any>, CTEParams = never>(
		name: string,
		query: CHQuery<any, CTEOutput, any, string | undefined, CTEParams> & NeedsSelect<CTEOutput>,
	): <
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
	) => CHQuery<Cols, Output, Joins, Route, Params | CTEParams, Source>
	(name: string, sql: string, options?: { readonly tenantScope?: TenantScope }): Same
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
		CTEOutput extends Record<string, any>,
		CTEParams = never,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		name: string,
		query: CHQuery<any, CTEOutput, any, string | undefined, CTEParams> & NeedsSelect<CTEOutput>,
	): CHQuery<Cols, Output, Joins, Route, Params | CTEParams, Source>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Source extends string,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params, Source>,
		name: string,
		sql: string,
		options?: { readonly tenantScope?: TenantScope },
	): CHQuery<Cols, Output, Joins, Route, Params, Source>
} = dual(
	(args) => isQuery(args[0]),
	(self: CHQuery<any, any, any, any, any>, ...args: Array<any>) => (self.withCTE as (...args: Array<any>) => unknown)(...args),
)
