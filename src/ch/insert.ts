// Insert Builder
//
// `insertInto(table).values(rows)` describes an INSERT the way `from(table)`
// describes a SELECT: an immutable value read by `compile`, which writes it for
// the dialect it is given. Values are encoded through each column's own codec,
// the same one that decodes it. See `design/writes.md`.
//
// Usage:
//   const insert = CH.insertInto(ApiKeys).values({
//     id: CH.param.string("id"),
//     orgId: CH.param.string("orgId"),
//     name: "default",
//   })
//   yield* Database.run(insert, { id, orgId })

import type { Comparable, Condition, Expr, Widen } from "./expr"
import type { CHQuery, ColumnAccessor, InferOutput } from "./query"
import type { Table } from "./table"
import type { CHUnionQuery } from "./union"
import type { CHType, ColumnDefs, InferTS } from "./types"

/**
 * What an insert may write into a column: a value of the column's type, a
 * `param.*` of it, or any expression of it (`CH.now()`, `rawExpr(...)`).
 *
 * A value is the decoded type (a branded id stays branded), plus the extra
 * forms a comparison accepts (`Date` or a string for a `DateTime`). A param or
 * expression may be of the widened primitive, as in a comparison, so a branded
 * column takes `param.string`.
 */
export type InsertValue<Col extends CHType<string, any, any>> =
	| Comparable<InferTS<Col>>
	| Expr<InferTS<Col>>
	| Expr<Widen<InferTS<Col>>>
	| Expr<Widen<NonNullable<InferTS<Col>>>>

/** A bare `string` means the table did not say, which is read as none. */
type Known<K extends string> = string extends K ? never : K

type NullableKeys<Cols extends ColumnDefs> = {
	[K in keyof Cols]: null extends InferTS<Cols[K]> ? K : never
}[keyof Cols] &
	string

type OptionalKeys<Cols extends ColumnDefs, Defaulted extends string> = Known<Defaulted> | NullableKeys<Cols>

type Simplify<A> = { [K in keyof A]: A[K] } & {}

/**
 * One row of an insert into a table with these columns.
 *
 * A column is optional when it is nullable or the table declares a default for
 * it; leaving it out (or passing `undefined`) writes the column's default.
 * `null` writes NULL and only type-checks on a nullable column. Computed
 * columns (ClickHouse `MATERIALIZED` and `ALIAS`) are not in the row at all.
 */
export type InsertRow<Cols extends ColumnDefs, Defaulted extends string = never, Computed extends string = never> = Simplify<
	{
		readonly [K in Exclude<keyof Cols & string, OptionalKeys<Cols, Defaulted> | Known<Computed>>]: InsertValue<Cols[K]>
	} & {
		readonly [K in Exclude<OptionalKeys<Cols, Defaulted> & keyof Cols, Known<Computed>>]?: InsertValue<Cols[K]> | undefined
	}
>

type RequiredKeys<Cols extends ColumnDefs, Defaulted extends string, Computed extends string> = Exclude<
	keyof Cols & string,
	OptionalKeys<Cols, Defaulted> | Known<Computed>
>

/** The row a query or union selects. */
type SelectedRow<Q> = Q extends { readonly _phantom?: { readonly output: infer Output } } ? Output : never

/** Selected columns the table cannot take: not an insertable column, or of another type. */
export type InsertSelectMisfits<Output, Cols extends ColumnDefs, Computed extends string = never> = {
	[K in keyof Output]: K extends Exclude<keyof Cols & string, Known<Computed>>
		? [Output[K]] extends [InferTS<Cols[K]>]
			? never
			: K
		: K
}[keyof Output]

/** Required columns of the table the query does not select. */
export type InsertSelectMissing<
	Output,
	Cols extends ColumnDefs,
	Defaulted extends string = never,
	Computed extends string = never,
> = Exclude<RequiredKeys<Cols, Defaulted, Computed>, keyof Output>

/**
 * `unknown` when a query's row fits the table, otherwise a property naming
 * what does not, so the error says which columns to fix.
 */
type SelectFits<Output, Cols extends ColumnDefs, Defaulted extends string, Computed extends string> = ([
	InsertSelectMisfits<Output, Cols, Computed>,
] extends [never]
	? unknown
	: { readonly targetCannotTake: InsertSelectMisfits<Output, Cols, Computed> }) &
	([InsertSelectMissing<Output, Cols, Defaulted, Computed>] extends [never]
		? unknown
		: { readonly missingColumns: InsertSelectMissing<Output, Cols, Defaulted, Computed> })

/** A ClickHouse setting's value, as `SETTINGS name = value` writes it. */
export type InsertSettingValue = string | number | boolean

/** The insert row of a table value: `InsertRowOf<typeof ApiKeys>`. */
export type InsertRowOf<T> =
	T extends Table<any, infer Cols, infer Defaulted, infer Computed> ? InsertRow<Cols, Defaulted, Computed> : never

/**
 * The unique index or constraint a conflict is detected on: column names
 * (Postgres infers the index from them), or a constraint by name.
 */
export type ConflictTarget<Cols extends ColumnDefs> =
	| ReadonlyArray<keyof Cols & string>
	| { readonly constraint: string }

/**
 * What `ON CONFLICT DO UPDATE` writes into the existing row: any insertable
 * column, as a value, param or expression. A key left out (or `undefined`)
 * keeps the existing value.
 */
export type ConflictSet<Cols extends ColumnDefs, Computed extends string = never> = {
	readonly [K in Exclude<keyof Cols & string, Known<Computed>>]?: InsertValue<Cols[K]> | undefined
}

export interface OnConflictDoNothing<Cols extends ColumnDefs> {
	/** Omit to skip a row that conflicts on any unique index or constraint. */
	readonly target?: ConflictTarget<Cols>
	/** The partial index's predicate, for a target on a partial unique index. */
	readonly targetWhere?: ($: ColumnAccessor<Cols>) => Condition
}

export interface OnConflictDoUpdate<Cols extends ColumnDefs, Computed extends string = never> {
	/** Required: Postgres must know which index the update is for. */
	readonly target: ConflictTarget<Cols>
	readonly targetWhere?: ($: ColumnAccessor<Cols>) => Condition
	/**
	 * The columns to write into the existing row. As a callback, `$` is the
	 * existing row and `excluded` the row that was proposed for insertion:
	 * `(($, excluded) => ({ count: $.count.add(excluded.count) }))`.
	 */
	readonly set:
		| ConflictSet<Cols, Computed>
		| (($: ColumnAccessor<Cols>, excluded: ColumnAccessor<Cols>) => ConflictSet<Cols, Computed>)
	/** Update only the existing rows this holds for; the others are skipped. */
	readonly where?: ($: ColumnAccessor<Cols>, excluded: ColumnAccessor<Cols>) => Condition
}

/** @internal — what an insert does on conflict. */
export type ConflictClause =
	| ({ readonly action: "nothing" } & OnConflictDoNothing<any>)
	| ({ readonly action: "update" } & OnConflictDoUpdate<any, any>)

/** @internal — runtime insert state */
export interface CHInsertState {
	readonly table: Table<string, ColumnDefs>
	/** Set by `values`. Compiling without it or `selectQuery` is a defect. */
	readonly rows?: ReadonlyArray<Readonly<Record<string, unknown>>>
	/** Set by `select`, which clears `rows` (and `values` clears it). */
	readonly selectQuery?: CHQuery<any, any, any, any> | CHUnionQuery<any>
	/** Set by `settings`: ClickHouse `SETTINGS` for this insert. */
	readonly settings?: Readonly<Record<string, InsertSettingValue>>
	/** Set by `returning`: the RETURNING list, as a select callback. */
	readonly returningFn?: ($: any) => Record<string, Expr<any>>
	/** Set by `onConflictDoNothing` / `onConflictDoUpdate`. */
	readonly conflict?: ConflictClause
}

export interface CHInsert<
	Cols extends ColumnDefs = ColumnDefs,
	Defaulted extends string = never,
	Computed extends string = never,
	Output = never,
> {
	readonly _tag: "CHInsert"
	/** @internal — runtime insert state */
	readonly _state: CHInsertState
	/** phantom. `output` is the row `Database.run` returns: none without RETURNING. */
	readonly _phantom?: { readonly cols: Cols; readonly output: Output }

	/**
	 * The rows to insert: one row or an array. Calling it again replaces the
	 * rows. Columns are written in table order whatever the key order, and a
	 * column some rows leave out is written as `DEFAULT` in those rows.
	 */
	values(
		rows: InsertRow<Cols, Defaulted, Computed> | ReadonlyArray<InsertRow<Cols, Defaulted, Computed>>,
	): CHInsert<Cols, Defaulted, Computed, Output>

	/**
	 * `INSERT ... SELECT`: insert the rows a query (or union) selects. Each
	 * selected alias names the column it is written to, so the query must
	 * select every required column, and only columns the table can take, of
	 * their types. Replaces any `values`.
	 */
	select<Q extends CHQuery<any, any, any, any> | CHUnionQuery<any>>(
		query: Q & SelectFits<SelectedRow<Q>, Cols, Defaulted, Computed>,
	): CHInsert<Cols, Defaulted, Computed, Output>

	/**
	 * ClickHouse `SETTINGS` for this insert, such as
	 * `{ async_insert: 1, wait_for_async_insert: 1 }`. Names must be plain
	 * identifiers; values are written as literals. Calling it again replaces
	 * them. On a dialect without insert settings (Postgres) compiling is a defect.
	 */
	settings(settings: Readonly<Record<string, InsertSettingValue>>): CHInsert<Cols, Defaulted, Computed, Output>

	/**
	 * Return the inserted rows: column names, or a callback building an
	 * expression per alias, as in `select`. `Database.run` then decodes them
	 * through the derived row schema. Postgres only; on a dialect without
	 * RETURNING (ClickHouse) compiling is a defect. Calling it again replaces
	 * the list.
	 */
	returning<K extends keyof Cols & string>(
		...columns: K[]
	): CHInsert<Cols, Defaulted, Computed, { readonly [P in K]: InferTS<Cols[P]> }>
	returning<S extends Record<string, Expr<any>>>(
		fn: ($: ColumnAccessor<Cols>) => S,
	): CHInsert<Cols, Defaulted, Computed, InferOutput<S>>

	/**
	 * `ON CONFLICT DO NOTHING`: skip a row that conflicts. With `returning`, a
	 * skipped row returns nothing. Postgres only; replaces any earlier
	 * `onConflict*`.
	 */
	onConflictDoNothing(options?: OnConflictDoNothing<Cols>): CHInsert<Cols, Defaulted, Computed, Output>

	/**
	 * `ON CONFLICT (target) DO UPDATE SET ...`: an upsert. Postgres only;
	 * replaces any earlier `onConflict*`.
	 */
	onConflictDoUpdate(options: OnConflictDoUpdate<Cols, Computed>): CHInsert<Cols, Defaulted, Computed, Output>
}

const makeInsert = <Cols extends ColumnDefs, Defaulted extends string, Computed extends string, Output>(
	state: CHInsertState,
): CHInsert<Cols, Defaulted, Computed, Output> => ({
	_tag: "CHInsert",
	_state: state,
	values: (rows) =>
		makeInsert({
			...state,
			selectQuery: undefined,
			// Copied, so a caller pushing to its array later does not change the insert.
			rows: Array.isArray(rows) ? [...rows] : [rows as Readonly<Record<string, unknown>>],
		}),
	select: (query) => makeInsert({ ...state, rows: undefined, selectQuery: query }),
	settings: (settings) => makeInsert({ ...state, settings: { ...settings } }),
	returning: ((...args: ReadonlyArray<unknown>) => {
		const [first] = args
		const returningFn =
			typeof first === "function"
				? (first as ($: any) => Record<string, Expr<any>>)
				: ($: any) => Object.fromEntries((args as ReadonlyArray<string>).map((column) => [column, $[column]]))
		return makeInsert({ ...state, returningFn })
	}) as CHInsert<Cols, Defaulted, Computed, Output>["returning"],
	onConflictDoNothing: (options = {}) => makeInsert({ ...state, conflict: { action: "nothing", ...options } }),
	onConflictDoUpdate: (options) => makeInsert({ ...state, conflict: { action: "update", ...options } }),
})

/** Start an INSERT into `table`. Give its rows with `values`. */
export function insertInto<Name extends string, Cols extends ColumnDefs, Defaulted extends string, Computed extends string>(
	table: Table<Name, Cols, Defaulted, Computed>,
): CHInsert<Cols, Defaulted, Computed> {
	return makeInsert({ table: table as Table<string, ColumnDefs> })
}

export const isInsert = (value: unknown): value is CHInsert<any, any, any, any> =>
	typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === "CHInsert"
