// Update and Delete Builders
//
// `update(table).set(...).where(...)` and `deleteFrom(table).where(...)`
// describe writes the way `insertInto` does: immutable values read by
// `compile`, which writes them for the dialect it is given. SET values are
// encoded through each column's own codec. See `design/writes.md`.
//
// A write with no WHERE changes every row, so it has to say so with
// `allRows()`; compiling one that does not is a defect.
//
// Usage:
//   CH.update(Counters)
//     .set(($) => ({ count: $.count.add(1) }))
//     .where(($) => [$.key.eq(CH.param.string("key"))])
//     .returning("count")
//
//   CH.deleteFrom(ApiKeys).where(($) => [$.orgId.eq(CH.param.string("orgId"))])

import type { ClauseEntry, Condition, Expr, ParamsIn } from "./expr"
import type { ConflictSet, InsertSettingValue, OnlyColumns, WritableColumns } from "./insert"
import {
	appendConditions,
	type BindSources,
	type CHQuery,
	type ColumnAccessor,
	type FreshAlias,
	type InferOutput,
	type JoinedColumnAccessor,
	type NeedsSelect,
	type RowCount,
} from "./query"
import { isTableFunction, type Table, type TableFunction } from "./table"
import type { SqlFragment } from "../sql/sql-fragment"
import type { ColumnDefs, InferTS, OutputToColumnDefs } from "./types"

/**
 * What an UPDATE writes: any insertable column, as a value, param or
 * expression. A key left out (or `undefined`) keeps the existing value.
 */
export type UpdateSet<Cols extends ColumnDefs, Computed extends string = never> = ConflictSet<Cols, Computed>

/** The SET record of a table value: `UpdateSetOf<typeof ApiKeys>`. */
export type UpdateSetOf<T> = T extends Table<any, infer Cols, any, infer Computed> ? UpdateSet<Cols, Computed> : never

type WhereFn<Cols extends ColumnDefs, C, Joins extends Record<string, ColumnDefs> = {}> = ($: JoinedColumnAccessor<Cols, Joins>) => C

/**
 * What `update(...).from(...)` adds to an update's params: `UPDATE ... FROM`
 * is Postgres and SQLite (3.33+) syntax, so `compile` and `run` for another
 * dialect refuse it in the type, as the compile does at run time.
 */
export type UpdateFromClause = ClauseEntry<"UPDATE ... FROM", "postgres" | "sqlite">

/**
 * What a write's `orderBy` or `limit` adds to its params: `UPDATE ... ORDER BY
 * ... LIMIT n` and `DELETE ... ORDER BY ... LIMIT n` are MySQL and MariaDB
 * single-table syntax, so `compile` and `run` for another dialect refuse them
 * in the type, as the compile does at run time. SQLite has them only when
 * built with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, which is not assumed.
 */
export type WriteLimitClause = ClauseEntry<"UPDATE/DELETE ... ORDER BY/LIMIT", "mysql">

/** A write's `orderBy` by column name: `["createdAt", "asc"]`. */
export type WriteOrderBySpec<Cols extends ColumnDefs> = readonly [keyof Cols & string, "asc" | "desc"]

/** @internal — the source of `update(...).from(source, alias)`. */
export interface UpdateFromSource {
	readonly alias: string
	readonly columns: ColumnDefs
	readonly tableName?: string
	readonly tenantColumn?: string
	readonly fragment?: SqlFragment
	readonly query?: CHQuery<any, any, any, any>
}

/** @internal — what UPDATE and DELETE share. */
interface WriteState {
	readonly table: Table<string, ColumnDefs>
	readonly whereFn?: ($: any) => ReadonlyArray<Condition | undefined>
	/** Set by `allRows()`: the write is meant to touch every row. */
	readonly allRows?: boolean
	readonly returningFn?: ($: any) => Record<string, Expr<any>>
	readonly settings?: Readonly<Record<string, InsertSettingValue>>
	/** Set by `crossTenant()`. */
	readonly crossTenant?: boolean
	/** Set by `orderBy` with column names. */
	readonly orderBySpecs?: ReadonlyArray<readonly [string, "asc" | "desc"]>
	/** Set by `orderBy` with a callback. */
	readonly orderByFn?: ($: any) => ReadonlyArray<readonly [Expr<any, any>, "asc" | "desc"]>
	/** Set by `limit`: at most this many rows, bound as a parameter. */
	readonly limitValue?: number
}

/** @internal — runtime update state */
export interface CHUpdateState extends WriteState {
	readonly set?: ConflictSet<any, any> | (($: any) => ConflictSet<any, any>)
	/** Set by `from`: `UPDATE ... FROM source AS alias`. */
	readonly from?: UpdateFromSource
	/** Set by a second `from`, which the types refuse: compiling it is a defect. */
	readonly fromTwice?: true
}

/** @internal — runtime delete state */
export type CHDeleteState = WriteState

type AllColumns<Cols extends ColumnDefs> = { readonly [P in keyof Cols & string]: InferTS<Cols[P]> }

/**
 * Whether a write says which rows it changes. One without `where` or
 * `allRows` cannot be compiled or run: an unfiltered UPDATE or DELETE has to
 * say that it means every row.
 */
export type WriteReady = "ready" | "needs where() or allRows()"

type Conditions = ReadonlyArray<Condition | undefined>

export interface CHUpdate<
	Cols extends ColumnDefs = ColumnDefs,
	Computed extends string = never,
	Output = never,
	Ready extends WriteReady = "ready",
	Params = never,
	Req = never,
	/** The `from` source, under its alias: `$.<alias>` in `set` and `where`. */
	Joins extends Record<string, ColumnDefs> = {},
> {
	readonly _tag: "CHUpdate"
	/** @internal — runtime update state */
	readonly _state: CHUpdateState
	/**
	 * phantom. `output` is the row `Database.run` returns: none without
	 * RETURNING. `requirements` is what the table's `onUpdate` defaults need.
	 */
	readonly _phantom?: {
		readonly cols: Cols
		readonly output: Output
		readonly ready: Ready
		readonly params: (entries: Params) => void
		readonly requirements: Req
	}

	/**
	 * Replace the SET record. It must set at least one column, and only columns
	 * the table can write. After `from`, the callback reads the source's
	 * columns as `$.<alias>.<column>`.
	 */
	set<S extends UpdateSet<Cols, Computed>>(
		set:
			| (S & NonEmptySet<S> & OnlyColumns<S, WritableColumns<Cols, Computed>>)
			| (($: JoinedColumnAccessor<Cols, Joins>) => S & NonEmptySet<S> & OnlyColumns<S, WritableColumns<Cols, Computed>>),
	): CHUpdate<Cols, Computed, Output, Ready, Params | BindSources<ParamsIn<S[keyof S]>, keyof Joins & string>, Req, Joins>

	/**
	 * The rows to change, as in a query's `where`: conditions AND-joined, an
	 * `undefined` one skipped. Calling it again adds conditions, ANDed with the
	 * earlier ones.
	 */
	where<const C extends Conditions>(
		fn: WhereFn<Cols, C, Joins>,
	): CHUpdate<Cols, Computed, Output, "ready", Params | BindSources<ParamsIn<C[number]>, keyof Joins & string>, Req, Joins>
	/** Change every row. Without it (or `where`), the write cannot be compiled or run. */
	allRows(): CHUpdate<Cols, Computed, Output, "ready", Params, Req, Joins>
	/**
	 * ClickHouse `SETTINGS` for this write, such as `{ mutations_sync: 2 }` so an
	 * `ALTER TABLE ... UPDATE` waits for the mutation. Postgres refuses them.
	 */
	settings(settings: Readonly<Record<string, InsertSettingValue>>): CHUpdate<Cols, Computed, Output, Ready, Params, Req, Joins>

	/** The changed rows, as for an insert: every column, the named ones, or a callback. Postgres only. */
	returning(): CHUpdate<Cols, Computed, AllColumns<Cols>, Ready, Params, Req, Joins>
	returning<K extends keyof Cols & string>(
		...columns: [K, ...Array<K>]
	): CHUpdate<Cols, Computed, { readonly [P in K]: InferTS<Cols[P]> }, Ready, Params, Req, Joins>
	returning<S extends Record<string, Expr<any>>>(
		fn: ($: ColumnAccessor<Cols>) => S,
	): CHUpdate<Cols, Computed, InferOutput<S>, Ready, Params | ParamsIn<S[keyof S]>, Req, Joins>

	/**
	 * The order the rows are changed in: column names, or a callback giving
	 * `[expression, "asc" | "desc"]` pairs. Calling it again replaces the order.
	 * MySQL and MariaDB only, and only on a single-table write: with `limit`,
	 * it says which rows a chunk takes.
	 */
	orderBy(...specs: [WriteOrderBySpec<Cols>, ...Array<WriteOrderBySpec<Cols>>]): CHUpdate<Cols, Computed, Output, Ready, Params | WriteLimitClause, Req, Joins>
	orderBy<const O extends ReadonlyArray<readonly [Expr<any>, "asc" | "desc"]>>(
		fn: ($: ColumnAccessor<Cols>) => O,
	): CHUpdate<Cols, Computed, Output, Ready, Params | ParamsIn<O[number][0]> | WriteLimitClause, Req, Joins>
	/**
	 * Change at most `n` rows (a non-negative integer, bound as a parameter):
	 * `UPDATE t SET ... WHERE ... LIMIT ?`. MySQL and MariaDB only. Without
	 * `orderBy`, which rows is up to the server.
	 */
	limit<N extends number>(n: RowCount<N>): CHUpdate<Cols, Computed, Output, Ready, Params | WriteLimitClause, Req, Joins>

	/**
	 * Declare that this update deliberately spans tenants, forcing
	 * `tenantScope: "cross-tenant"` and setting `crossTenantDeclared`. A
	 * database with `requireTenantScope` runs it; see docs/tenant-scoping.md.
	 */
	crossTenant(): CHUpdate<Cols, Computed, Output, Ready, Params, Req, Joins>
}

export interface CHDelete<
	Cols extends ColumnDefs = ColumnDefs,
	Output = never,
	Ready extends WriteReady = "ready",
	Params = never,
> {
	readonly _tag: "CHDelete"
	/** @internal — runtime delete state */
	readonly _state: CHDeleteState
	readonly _phantom?: {
		readonly cols: Cols
		readonly output: Output
		readonly ready: Ready
		readonly params: (entries: Params) => void
	}

	/** The rows to delete, as for an UPDATE. Calling it again ANDs the conditions. */
	where<const C extends Conditions>(fn: WhereFn<Cols, C>): CHDelete<Cols, Output, "ready", Params | ParamsIn<C[number]>>
	/** Delete every row. Without it (or `where`), the delete cannot be compiled or run. */
	allRows(): CHDelete<Cols, Output, "ready", Params>
	/** ClickHouse `SETTINGS`, such as `{ lightweight_deletes_sync: 2 }`. Postgres refuses them. */
	settings(settings: Readonly<Record<string, InsertSettingValue>>): CHDelete<Cols, Output, Ready, Params>

	/** The deleted rows, as for an insert: every column, the named ones, or a callback. Postgres only. */
	returning(): CHDelete<Cols, AllColumns<Cols>, Ready, Params>
	returning<K extends keyof Cols & string>(
		...columns: [K, ...Array<K>]
	): CHDelete<Cols, { readonly [P in K]: InferTS<Cols[P]> }, Ready, Params>
	returning<S extends Record<string, Expr<any>>>(
		fn: ($: ColumnAccessor<Cols>) => S,
	): CHDelete<Cols, InferOutput<S>, Ready, Params | ParamsIn<S[keyof S]>>

	/** The order the rows are deleted in, as for an UPDATE. MySQL and MariaDB only. */
	orderBy(...specs: [WriteOrderBySpec<Cols>, ...Array<WriteOrderBySpec<Cols>>]): CHDelete<Cols, Output, Ready, Params | WriteLimitClause>
	orderBy<const O extends ReadonlyArray<readonly [Expr<any>, "asc" | "desc"]>>(
		fn: ($: ColumnAccessor<Cols>) => O,
	): CHDelete<Cols, Output, Ready, Params | ParamsIn<O[number][0]> | WriteLimitClause>
	/**
	 * Delete at most `n` rows (a non-negative integer, bound as a parameter):
	 * `DELETE FROM t WHERE ... LIMIT ?`, as a chunked delete loops on until a
	 * chunk deletes fewer than `n`. MySQL and MariaDB only.
	 */
	limit<N extends number>(n: RowCount<N>): CHDelete<Cols, Output, Ready, Params | WriteLimitClause>

	/**
	 * Declare that this delete deliberately spans tenants, forcing
	 * `tenantScope: "cross-tenant"` and setting `crossTenantDeclared`. A
	 * database with `requireTenantScope` runs it; see docs/tenant-scoping.md.
	 */
	crossTenant(): CHDelete<Cols, Output, Ready, Params>
}

/**
 * `unknown` when a SET record names at least one column. A record whose keys
 * are all optional (as every SET key is) still has to set something: `SET`
 * with nothing after it is not SQL. A record built at runtime is checked when
 * compiling.
 */
export type NonEmptySet<S> = [keyof S] extends [never] ? { readonly setAtLeastOneColumn: true } : unknown

/**
 * An update with no SET yet: only `set`, and `from` before it, so it cannot be
 * compiled before it says what to write.
 */
export type CHUpdateStart<
	Cols extends ColumnDefs = ColumnDefs,
	Computed extends string = never,
	Req = never,
	Joins extends Record<string, ColumnDefs> = {},
	Params = never,
> = Pick<CHUpdate<Cols, Computed, never, "needs where() or allRows()", Params, Req, Joins>, "set"> & {
	/**
	 * `UPDATE target SET … FROM source AS alias WHERE …`: `set` and `where`
	 * read the source's columns as `$.<alias>.<column>`, and the target's
	 * columns are written qualified (`"target"."col"`). The source is a table,
	 * a table-valued function (`SQLite.jsonEach(rows)`) or a query
	 * (`SQLite.jsonRows(rows, columns)`). Postgres and SQLite 3.33+.
	 */
	from<JName extends string, JCols extends ColumnDefs, Alias extends string, TParams = never>(
		source: Table<JName, JCols> | TableFunction<JName, JCols, TParams>,
		alias: FreshAlias<Alias, Cols, Joins>,
	): CHUpdateFromStart<Cols, Computed, Req, Joins & { readonly [K in Alias]: JCols }, Params | TParams | UpdateFromClause>
	from<JOutput extends Record<string, any>, Alias extends string, JParams = never>(
		source: CHQuery<any, JOutput, any, string | undefined, JParams> & NeedsSelect<JOutput>,
		alias: FreshAlias<Alias, Cols, Joins>,
	): CHUpdateFromStart<Cols, Computed, Req, Joins & { readonly [K in Alias]: OutputToColumnDefs<JOutput> }, Params | JParams | UpdateFromClause>
}

/**
 * An update after `from`, with no SET yet: only `set`. An UPDATE has one FROM
 * source, so a second `from` is not offered (and is a defect past the types).
 */
export type CHUpdateFromStart<
	Cols extends ColumnDefs,
	Computed extends string,
	Req,
	Joins extends Record<string, ColumnDefs>,
	Params,
> = Pick<CHUpdate<Cols, Computed, never, "needs where() or allRows()", Params, Req, Joins>, "set">

/** `returning(...)`'s arguments as a select callback, shared with inserts. */
export const returningFnOf =
	(table: Table<string, ColumnDefs>) =>
	(args: ReadonlyArray<unknown>): (($: any) => Record<string, Expr<any>>) => {
		const [first] = args
		if (typeof first === "function") return first as ($: any) => Record<string, Expr<any>>
		const columns = args.length === 0 ? Object.keys(table.columns) : (args as ReadonlyArray<string>)
		return ($: any) => Object.fromEntries(columns.map((column) => [column, $[column]]))
	}

const writeClauses = <State extends WriteState, Self>(state: State, make: (state: State) => Self) => ({
	where: (whereFn: ($: any) => ReadonlyArray<Condition | undefined>) =>
		make({ ...state, whereFn: appendConditions(state.whereFn, whereFn) }),
	allRows: () => make({ ...state, allRows: true }),
	settings: (settings: Readonly<Record<string, InsertSettingValue>>) => make({ ...state, settings: { ...settings } }),
	returning: (...args: ReadonlyArray<unknown>) => make({ ...state, returningFn: returningFnOf(state.table)(args) }),
	crossTenant: () => make({ ...state, crossTenant: true }),
	orderBy: (...specs: ReadonlyArray<unknown>) =>
		typeof specs[0] === "function"
			? make({ ...state, orderBySpecs: undefined, orderByFn: specs[0] as WriteState["orderByFn"] })
			: make({ ...state, orderBySpecs: specs as WriteState["orderBySpecs"], orderByFn: undefined }),
	limit: (n: number) => make({ ...state, limitValue: n }),
})

const makeUpdate = (state: CHUpdateState): CHUpdate<any, any, any, any, any, any, any> & Pick<CHUpdateStart<any, any, any, any, any>, "from"> => ({
	_tag: "CHUpdate",
	_state: state,
	...writeClauses(state, makeUpdate),
	set: (set: CHUpdateState["set"]) => makeUpdate({ ...state, set }),
	from: ((source: any, alias: string) =>
		makeUpdate({ ...state, from: updateFromSource(source, alias), ...(state.from === undefined ? undefined : { fromTwice: true as const }) })) as any,
})

const updateFromSource = (
	source: Table<string, ColumnDefs> | TableFunction<string, ColumnDefs, unknown> | CHQuery<any, any, any, any>,
	alias: string,
): UpdateFromSource => {
	if ("_state" in source) return { alias, columns: {}, query: source }
	if (isTableFunction(source)) return { alias, columns: source.columns, fragment: source.fragment }
	return { alias, columns: source.columns, tableName: source.name, tenantColumn: source.tenantColumn }
}

const makeDelete = (state: CHDeleteState): CHDelete<any, any, any, any> => ({
	_tag: "CHDelete",
	_state: state,
	...writeClauses(state, makeDelete),
})

/**
 * Start an UPDATE of `table`. Give what to write with `set`, and the rows with
 * `where` or `allRows`. The update requires what the table's `onUpdate`
 * defaults need (`Req`).
 */
export function update<Name extends string, Cols extends ColumnDefs, Computed extends string, Req = never>(
	table: Table<Name, Cols, any, Computed, never, Req>,
): CHUpdateStart<Cols, Computed, Req> {
	return makeUpdate({ table: table as Table<string, ColumnDefs> }) as unknown as CHUpdateStart<Cols, Computed, Req>
}

/** Start a DELETE from `table`. Give the rows with `where` or `allRows`. */
export function deleteFrom<Name extends string, Cols extends ColumnDefs>(
	table: Table<Name, Cols, any, any>,
): CHDelete<Cols, never, "needs where() or allRows()"> {
	return makeDelete({ table: table as Table<string, ColumnDefs> }) as CHDelete<Cols, never, "needs where() or allRows()">
}

export const isUpdate = (value: unknown): value is CHUpdate<any, any, any, any, any, any, any> =>
	typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === "CHUpdate"

export const isDelete = (value: unknown): value is CHDelete<any, any, any, any> =>
	typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === "CHDelete"
