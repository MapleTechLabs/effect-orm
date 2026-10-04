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

import type { Condition, Expr, ParamsIn } from "./expr"
import type { ConflictSet, InsertSettingValue, OnlyColumns, WritableColumns } from "./insert"
import { appendConditions, type ColumnAccessor, type InferOutput } from "./query"
import type { Table } from "./table"
import type { ColumnDefs, InferTS } from "./types"

/**
 * What an UPDATE writes: any insertable column, as a value, param or
 * expression. A key left out (or `undefined`) keeps the existing value.
 */
export type UpdateSet<Cols extends ColumnDefs, Computed extends string = never> = ConflictSet<Cols, Computed>

/** The SET record of a table value: `UpdateSetOf<typeof ApiKeys>`. */
export type UpdateSetOf<T> = T extends Table<any, infer Cols, any, infer Computed> ? UpdateSet<Cols, Computed> : never

type WhereFn<Cols extends ColumnDefs, C> = ($: ColumnAccessor<Cols>) => C

/** @internal — what UPDATE and DELETE share. */
interface WriteState {
	readonly table: Table<string, ColumnDefs>
	readonly whereFn?: ($: any) => ReadonlyArray<Condition | undefined>
	/** Set by `allRows()`: the write is meant to touch every row. */
	readonly allRows?: boolean
	readonly returningFn?: ($: any) => Record<string, Expr<any>>
	readonly settings?: Readonly<Record<string, InsertSettingValue>>
}

/** @internal — runtime update state */
export interface CHUpdateState extends WriteState {
	readonly set?: ConflictSet<any, any> | (($: any) => ConflictSet<any, any>)
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
> {
	readonly _tag: "CHUpdate"
	/** @internal — runtime update state */
	readonly _state: CHUpdateState
	/** phantom. `output` is the row `Database.run` returns: none without RETURNING. */
	readonly _phantom?: {
		readonly cols: Cols
		readonly output: Output
		readonly ready: Ready
		readonly params: (entries: Params) => void
	}

	/** Replace the SET record. It must set at least one column, and only columns the table can write. */
	set<S extends UpdateSet<Cols, Computed>>(
		set:
			| (S & NonEmptySet<S> & OnlyColumns<S, WritableColumns<Cols, Computed>>)
			| (($: ColumnAccessor<Cols>) => S & NonEmptySet<S> & OnlyColumns<S, WritableColumns<Cols, Computed>>),
	): CHUpdate<Cols, Computed, Output, Ready, Params | ParamsIn<S[keyof S]>>

	/**
	 * The rows to change, as in a query's `where`: conditions AND-joined, an
	 * `undefined` one skipped. Calling it again adds conditions, ANDed with the
	 * earlier ones.
	 */
	where<const C extends Conditions>(
		fn: WhereFn<Cols, C>,
	): CHUpdate<Cols, Computed, Output, "ready", Params | ParamsIn<C[number]>>
	/** Change every row. Without it (or `where`), the write cannot be compiled or run. */
	allRows(): CHUpdate<Cols, Computed, Output, "ready", Params>
	/**
	 * ClickHouse `SETTINGS` for this write, such as `{ mutations_sync: 2 }` so an
	 * `ALTER TABLE ... UPDATE` waits for the mutation. Postgres refuses them.
	 */
	settings(settings: Readonly<Record<string, InsertSettingValue>>): CHUpdate<Cols, Computed, Output, Ready, Params>

	/** The changed rows, as for an insert: every column, the named ones, or a callback. Postgres only. */
	returning(): CHUpdate<Cols, Computed, AllColumns<Cols>, Ready, Params>
	returning<K extends keyof Cols & string>(
		...columns: [K, ...Array<K>]
	): CHUpdate<Cols, Computed, { readonly [P in K]: InferTS<Cols[P]> }, Ready, Params>
	returning<S extends Record<string, Expr<any>>>(
		fn: ($: ColumnAccessor<Cols>) => S,
	): CHUpdate<Cols, Computed, InferOutput<S>, Ready, Params | ParamsIn<S[keyof S]>>
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
}

/**
 * `unknown` when a SET record names at least one column. A record whose keys
 * are all optional (as every SET key is) still has to set something: `SET`
 * with nothing after it is not SQL. A record built at runtime is checked when
 * compiling.
 */
export type NonEmptySet<S> = [keyof S] extends [never] ? { readonly setAtLeastOneColumn: true } : unknown

/** An update with no SET yet: only `set`, so it cannot be compiled before it says what to write. */
export type CHUpdateStart<Cols extends ColumnDefs = ColumnDefs, Computed extends string = never> = Pick<
	CHUpdate<Cols, Computed, never, "needs where() or allRows()">,
	"set"
>

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
})

const makeUpdate = (state: CHUpdateState): CHUpdate<any, any, any, any, any> => ({
	_tag: "CHUpdate",
	_state: state,
	...writeClauses(state, makeUpdate),
	set: (set: CHUpdateState["set"]) => makeUpdate({ ...state, set }),
})

const makeDelete = (state: CHDeleteState): CHDelete<any, any, any, any> => ({
	_tag: "CHDelete",
	_state: state,
	...writeClauses(state, makeDelete),
})

/** Start an UPDATE of `table`. Give what to write with `set`, and the rows with `where` or `allRows`. */
export function update<Name extends string, Cols extends ColumnDefs, Computed extends string>(
	table: Table<Name, Cols, any, Computed>,
): CHUpdateStart<Cols, Computed> {
	return makeUpdate({ table: table as Table<string, ColumnDefs> }) as CHUpdateStart<Cols, Computed>
}

/** Start a DELETE from `table`. Give the rows with `where` or `allRows`. */
export function deleteFrom<Name extends string, Cols extends ColumnDefs>(
	table: Table<Name, Cols, any, any>,
): CHDelete<Cols, never, "needs where() or allRows()"> {
	return makeDelete({ table: table as Table<string, ColumnDefs> }) as CHDelete<Cols, never, "needs where() or allRows()">
}

export const isUpdate = (value: unknown): value is CHUpdate<any, any, any, any, any> =>
	typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === "CHUpdate"

export const isDelete = (value: unknown): value is CHDelete<any, any, any, any> =>
	typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === "CHDelete"
