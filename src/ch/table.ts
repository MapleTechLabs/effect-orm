// Table Schema Definition
//
// A Table carries its name and column definitions at both the type level
// (for inference) and runtime (for SQL generation).

import type { ColumnDefs } from "./types"

/**
 * `Defaulted` and `Computed` describe inserts: the columns an insert may leave
 * out because the database fills them, and the ones it may not write at all
 * (ClickHouse `MATERIALIZED` and `ALIAS`). Both default to `string`, read as
 * "unknown", so a `Table` with more of either still satisfies a `Table<N, C>`
 * written without them; the insert row type treats a bare `string` as none.
 */
export interface Table<
	Name extends string,
	Columns extends ColumnDefs,
	Defaulted extends string = string,
	Computed extends string = string,
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
}

export interface TableOptions<Columns extends ColumnDefs, Defaulted extends keyof Columns & string = never> {
	readonly tenantColumn?: keyof Columns & string
	/**
	 * Columns the database fills when an insert leaves them out: a Postgres
	 * `serial` or `DEFAULT now()`, a ClickHouse `DEFAULT`. Nullable columns are
	 * optional in an insert without being listed. `defineTable` works this out
	 * from its column options.
	 */
	readonly defaults?: ReadonlyArray<Defaulted>
}

export function table<
	const Name extends string,
	const Columns extends ColumnDefs,
	const Defaulted extends keyof Columns & string = never,
>(name: Name, columns: Columns, options?: TableOptions<Columns, Defaulted>): Table<Name, Columns, Defaulted, never> {
	return {
		_tag: "Table",
		name,
		columns,
		...(options?.tenantColumn !== undefined ? { tenantColumn: options.tenantColumn } : undefined),
		...(options?.defaults !== undefined && options.defaults.length > 0 ? { defaults: [...options.defaults] } : undefined),
	}
}
