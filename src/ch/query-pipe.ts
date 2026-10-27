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
import type { Condition, Expr, ParamsIn } from "./expr"
import type { CHQuery, FreshAlias, InferOutput, JoinedColumnAccessor, JoinOnCallback, RowCount, SelectRecord } from "./query"
import type { Table } from "./table"
import type { ColumnDefs, InferTS, NullableColumnDefs } from "./types"

export { from, fromQuery, fromUnion } from "./query"

/** `true` for a query, the first argument of a data-first call. */
const isQuery = (u: unknown): u is CHQuery<any, any, any, any, any> =>
	typeof u === "object" && u !== null && "_state" in u && typeof (u as { pipe?: unknown }).pipe === "function"

/** `query.where(fn)`: conditions AND-joined with the earlier ones. */
export const where: {
	<Cols extends ColumnDefs, Joins extends Record<string, ColumnDefs>, const C extends ReadonlyArray<Condition | undefined>>(
		fn: ($: JoinedColumnAccessor<Cols, Joins>) => C,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
	) => CHQuery<Cols, Output, Joins, Route, Params | ParamsIn<C[number]>>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Route extends string | undefined,
		Params,
		const C extends ReadonlyArray<Condition | undefined>,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
		fn: ($: JoinedColumnAccessor<Cols, Joins>) => C,
	): CHQuery<Cols, Output, Joins, Route, Params | ParamsIn<C[number]>>
} = dual(2, (self: CHQuery<any, any, any, any, any>, fn: any) => self.where(fn))

/**
 * `query.select(...)`, in its three forms: every column (`select()`), columns by
 * name (`select("Id", "Name")`) or a callback (`select(($) => ({ ... }))`).
 * Replaces an earlier projection.
 */
export const select: {
	(): <Cols extends ColumnDefs, Output extends Record<string, any>, Joins extends Record<string, ColumnDefs>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
	) => CHQuery<Cols, { readonly [K in keyof Cols]: InferTS<Cols[K]> }, Joins, Route, Params>
	<Cols extends ColumnDefs, Joins extends Record<string, ColumnDefs>, S extends SelectRecord>(
		fn: ($: JoinedColumnAccessor<Cols, Joins>) => S,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
	) => CHQuery<Cols, InferOutput<S>, Joins, Route, Params | ParamsIn<S[keyof S]>>
	<Cols extends ColumnDefs, K extends keyof Cols & string>(
		...columns: [K, ...Array<K>]
	): <Output extends Record<string, any>, Joins extends Record<string, ColumnDefs>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
	) => CHQuery<Cols, { readonly [P in K]: InferTS<Cols[P]> }, Joins, Route, Params>
	<Cols extends ColumnDefs, Output extends Record<string, any>, Joins extends Record<string, ColumnDefs>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
	): CHQuery<Cols, { readonly [K in keyof Cols]: InferTS<Cols[K]> }, Joins, Route, Params>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Route extends string | undefined,
		Params,
		S extends SelectRecord,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
		fn: ($: JoinedColumnAccessor<Cols, Joins>) => S,
	): CHQuery<Cols, InferOutput<S>, Joins, Route, Params | ParamsIn<S[keyof S]>>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Route extends string | undefined,
		Params,
		K extends keyof Cols & string,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
		...columns: [K, ...Array<K>]
	): CHQuery<Cols, { readonly [P in K]: InferTS<Cols[P]> }, Joins, Route, Params>
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
	<Cols extends ColumnDefs, Joins extends Record<string, ColumnDefs>, Q = never>(
		fn: ($: JoinedColumnAccessor<Cols, Joins>) => ReadonlyArray<readonly [Expr<any, Q>, Direction]>,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
	) => CHQuery<Cols, Output, Joins, Route, Params | Q>
	<K extends string>(
		...specs: [readonly [K, Direction], ...Array<readonly [K, Direction]>]
	): <
		Cols extends ColumnDefs,
		Output extends Record<K, any>,
		Joins extends Record<string, ColumnDefs>,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
	) => CHQuery<Cols, Output, Joins, Route, Params>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Route extends string | undefined,
		Params,
		Q = never,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
		fn: ($: JoinedColumnAccessor<Cols, Joins>) => ReadonlyArray<readonly [Expr<any, Q>, Direction]>,
	): CHQuery<Cols, Output, Joins, Route, Params | Q>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
		...specs: [readonly [keyof Output & string, Direction], ...Array<readonly [keyof Output & string, Direction]>]
	): CHQuery<Cols, Output, Joins, Route, Params>
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
		Route extends string | undefined,
		Params,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
	) => CHQuery<Cols, Output, Joins, Route, Params>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Route extends string | undefined,
		Params,
		N extends number,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
		n: RowCount<N>,
	): CHQuery<Cols, Output, Joins, Route, Params>
} = dual(2, (self: CHQuery<any, any, any, any, any>, n: number) => self.limit(n))

/** `query.innerJoin(table, alias, on)`: `$.<alias>` reads the joined table. */
export const innerJoin: {
	<
		Cols extends ColumnDefs,
		Joins extends Record<string, ColumnDefs>,
		JName extends string,
		JCols extends ColumnDefs,
		Alias extends string,
		OnParams = never,
	>(
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, JCols, OnParams>,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
	) => CHQuery<Cols, Output, Joins & { readonly [K in Alias]: JCols }, Route, Params | OnParams>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Route extends string | undefined,
		Params,
		JName extends string,
		JCols extends ColumnDefs,
		Alias extends string,
		OnParams = never,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, JCols, OnParams>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: JCols }, Route, Params | OnParams>
} = dual(4, (self: CHQuery<any, any, any, any, any>, table: Table<any, any>, alias: any, on: any) =>
	self.innerJoin(table, alias, on),
)

/** `query.leftJoin(table, alias, on)`: as `innerJoin`, with the joined columns nullable. */
export const leftJoin: {
	<
		Cols extends ColumnDefs,
		Joins extends Record<string, ColumnDefs>,
		JName extends string,
		JCols extends ColumnDefs,
		Alias extends string,
		OnParams = never,
	>(
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, JCols, OnParams>,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
	) => CHQuery<Cols, Output, Joins & { readonly [K in Alias]: NullableColumnDefs<JCols> }, Route, Params | OnParams>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Route extends string | undefined,
		Params,
		JName extends string,
		JCols extends ColumnDefs,
		Alias extends string,
		OnParams = never,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
		on: JoinOnCallback<Cols, JCols, OnParams>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: NullableColumnDefs<JCols> }, Route, Params | OnParams>
} = dual(4, (self: CHQuery<any, any, any, any, any>, table: Table<any, any>, alias: any, on: any) =>
	self.leftJoin(table, alias, on),
)

/** `query.crossJoin(table, alias)`: every pair of rows. */
export const crossJoin: {
	<Cols extends ColumnDefs, Joins extends Record<string, ColumnDefs>, JName extends string, JCols extends ColumnDefs, Alias extends string>(
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
	): <Output extends Record<string, any>, Route extends string | undefined, Params>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
	) => CHQuery<Cols, Output, Joins & { readonly [K in Alias]: JCols }, Route, Params>
	<
		Cols extends ColumnDefs,
		Output extends Record<string, any>,
		Joins extends Record<string, ColumnDefs>,
		Route extends string | undefined,
		Params,
		JName extends string,
		JCols extends ColumnDefs,
		Alias extends string,
	>(
		self: CHQuery<Cols, Output, Joins, Route, Params>,
		table: Table<JName, JCols>,
		alias: FreshAlias<Alias, Cols, Joins>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: JCols }, Route, Params>
} = dual(3, (self: CHQuery<any, any, any, any, any>, table: Table<any, any>, alias: any) => self.crossJoin(table, alias))
