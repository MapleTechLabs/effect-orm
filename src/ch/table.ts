// Table Schema Definition
//
// A Table carries its name and column definitions at both the type level
// (for inference) and runtime (for SQL generation).

import type { Effect } from "effect"
import type { ColumnDefs, InferTS } from "./types"

/**
 * Columns the client fills, as an Effect per column: `insert` runs for a
 * column an insert leaves out, `update` for a column an update does not set.
 * `Database.run` runs them; see `fillDefaults`.
 */
export interface ClientDefaults {
	readonly insert: Readonly<Record<string, Effect.Effect<unknown, never, any>>>
	readonly update: Readonly<Record<string, Effect.Effect<unknown, never, any>>>
}

/**
 * `Defaulted` and `Computed` describe inserts: the columns an insert may leave
 * out because the database fills them, and the ones it may not write at all
 * (ClickHouse `MATERIALIZED` and `ALIAS`). Both default to `string`, read as
 * "unknown", so a `Table` with more of either still satisfies a `Table<N, C>`
 * written without them; the insert row type treats a bare `string` as none.
 *
 * `InsertR` and `UpdateR` are what the table's client defaults need: the
 * services an insert or an update of it requires to run.
 */
export interface Table<
	Name extends string,
	Columns extends ColumnDefs,
	Defaulted extends string = string,
	Computed extends string = string,
	InsertR = never,
	UpdateR = never,
> {
	readonly _tag: "Table"
	readonly name: Name
	readonly columns: Columns
	/**
	 * The column carrying row-level tenancy, when the schema has one. An
	 * equality or membership test on it marks a query as tenant-scoped
	 * (`CompiledQuery.tenantScope`); a table without one never scopes anything,
	 * so every query over it compiles as `"cross-tenant"`.
	 *
	 * Widened to `string` here on purpose: `TableOptions` checks the name
	 * against the declared columns where the table is defined, and keeping that
	 * narrowing on the interface would make a `Table` with more columns fail to
	 * satisfy a `Table` type declared with fewer.
	 */
	readonly tenantColumn?: string
	/** Columns with a database default, which an insert may leave out. */
	readonly defaults?: ReadonlyArray<Defaulted>
	/** Columns the database computes, which an insert may not write. */
	readonly computed?: ReadonlyArray<Computed>
	/** Columns the client fills with an Effect; see `ClientDefaults`. */
	readonly clientDefaults?: ClientDefaults
	/**
	 * phantom: the requirements of the client defaults. Contravariant, so a
	 * table that needs a service still satisfies a `Table` type written without one.
	 */
	readonly _requirements?: { readonly insert: (r: InsertR) => void; readonly update: (r: UpdateR) => void }
}

export interface TableOptions<
	Columns extends ColumnDefs,
	Defaulted extends keyof Columns & string = never,
	Computed extends keyof Columns & string = never,
> {
	readonly tenantColumn?: keyof Columns & string
	/**
	 * Columns the database fills when an insert leaves them out: a Postgres
	 * `serial` or `DEFAULT now()`, a ClickHouse `DEFAULT`. Nullable columns are
	 * optional in an insert without being listed. each dialect's `table` works this out
	 * from its column options.
	 */
	readonly defaults?: ReadonlyArray<Defaulted>
	/**
	 * Columns the database computes and an insert may not write: a Postgres
	 * `GENERATED ALWAYS` column, a ClickHouse `MATERIALIZED` or `ALIAS` one.
	 * They stay readable. Each dialect's `table` works this out from its column options.
	 */
	readonly computed?: ReadonlyArray<Computed>
}

export function table<
	const Name extends string,
	const Columns extends ColumnDefs,
	const Defaulted extends keyof Columns & string = never,
	const Computed extends keyof Columns & string = never,
>(
	name: Name,
	columns: Columns,
	options?: TableOptions<Columns, Defaulted, Computed>,
): Table<Name, Columns, Defaulted, Computed> {
	return {
		_tag: "Table",
		name,
		columns,
		...(options?.tenantColumn !== undefined ? { tenantColumn: options.tenantColumn } : undefined),
		...(options?.defaults !== undefined && options.defaults.length > 0 ? { defaults: [...options.defaults] } : undefined),
		...(options?.computed !== undefined && options.computed.length > 0 ? { computed: [...options.computed] } : undefined),
	}
}

/**
 * A whole row of a table, as a `SELECT` of every column decodes it: branded
 * columns stay branded, nullable ones carry `| null`, computed ones are
 * included. `SelectRowOf<typeof Dashboards>`, drizzle's `$inferSelect`.
 */
export type SelectRowOf<T> =
	T extends Table<any, infer Cols, any, any> ? { readonly [K in keyof Cols]: InferTS<Cols[K]> } : never
