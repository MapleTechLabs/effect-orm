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

import type { Comparable, Expr, Widen } from "./expr"
import type { Table } from "./table"
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

/** The insert row of a table value: `InsertRowOf<typeof ApiKeys>`. */
export type InsertRowOf<T> =
	T extends Table<any, infer Cols, infer Defaulted, infer Computed> ? InsertRow<Cols, Defaulted, Computed> : never

/** @internal — runtime insert state */
export interface CHInsertState {
	readonly table: Table<string, ColumnDefs>
	/** Set by `values`. Compiling without it is a defect. */
	readonly rows?: ReadonlyArray<Readonly<Record<string, unknown>>>
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
}

const makeInsert = <Cols extends ColumnDefs, Defaulted extends string, Computed extends string, Output>(
	state: CHInsertState,
): CHInsert<Cols, Defaulted, Computed, Output> => ({
	_tag: "CHInsert",
	_state: state,
	values: (rows) =>
		makeInsert({
			...state,
			// Copied, so a caller pushing to its array later does not change the insert.
			rows: Array.isArray(rows) ? [...rows] : [rows as Readonly<Record<string, unknown>>],
		}),
})

/** Start an INSERT into `table`. Give its rows with `values`. */
export function insertInto<Name extends string, Cols extends ColumnDefs, Defaulted extends string, Computed extends string>(
	table: Table<Name, Cols, Defaulted, Computed>,
): CHInsert<Cols, Defaulted, Computed> {
	return makeInsert({ table: table as Table<string, ColumnDefs> })
}

export const isInsert = (value: unknown): value is CHInsert<any, any, any, any> =>
	typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === "CHInsert"
