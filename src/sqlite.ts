// @maple-dev/effect-orm/sqlite
//
// SQLite and Cloudflare D1 queries, codecs, functions and execution through an
// Effect SqlClient. `table` is a query schema only: this entry writes no DDL
// and generates no migrations yet. See docs/sqlite.md.
import { compileCH, compileCHRaw, compileCHUnsafe, compileUnion as compileUnionCH, compileUnionUnsafe as compileUnionUnsafeCH } from "./ch/compile"
import { compiled, compiledUnsafe } from "./ch/failure"
import { table as queryTable, type Table, type TableOptions } from "./ch/table"
import type { ColumnDefs } from "./ch/types"
import { sqliteDialect } from "./sqlite/dialect"

export * from "./core"
export * from "./sqlite/types"
export * from "./sqlite/functions"
export type { TableOptions }

/** A table another tool owns, as on `/clickhouse` and `/postgres`. */
export interface ExternalTableDefinition<Columns extends ColumnDefs> {
	readonly external: true
	readonly columns: Columns
	readonly tenantColumn?: keyof Columns & string
}

/**
 * A SQLite query schema: `table(name, columns, options?)`, or
 * `table(name, { external: true, columns, tenantColumn? })`. Neither carries DDL.
 */
export function table<const Name extends string, const Columns extends ColumnDefs>(
	name: Name,
	definition: ExternalTableDefinition<Columns>,
): Table<Name, Columns, never, never>
export function table<
	const Name extends string,
	const Columns extends ColumnDefs,
	const Defaulted extends keyof Columns & string = never,
	const Computed extends keyof Columns & string = never,
>(name: Name, columns: Columns, options?: TableOptions<Columns, Defaulted, Computed>): Table<Name, Columns, Defaulted, Computed>
export function table(name: string, definition: any, options?: TableOptions<any, any, any>): Table<string, any, any, any> {
	if (options === undefined && definition.external === true && typeof definition.columns === "object") {
		return queryTable(name, definition.columns, definition.tenantColumn === undefined ? undefined : { tenantColumn: definition.tenantColumn })
	}
	return queryTable(name, definition, options)
}
export { sqliteDialect, d1Dialect } from "./sqlite/dialect"

/** The shared compiler, defaulting to SQLite. Pass d1Dialect for D1's limits. */
export const compile: typeof compileCH = (
	query: Parameters<typeof compileCHRaw>[0],
	params?: Record<string, unknown>,
	options?: Parameters<typeof compileCHRaw>[2],
) => compiled(() => compileCHRaw(query, params, { ...options, dialect: options?.dialect ?? sqliteDialect }))

/** Compile immediately, throwing on a failed compile. */
export const compileUnsafe: typeof compileCHUnsafe = (
	query: Parameters<typeof compileCHRaw>[0],
	params?: Record<string, unknown>,
	options?: Parameters<typeof compileCHRaw>[2],
) => compiledUnsafe(() => compileCHRaw(query, params, { ...options, dialect: options?.dialect ?? sqliteDialect }))

export const compileUnion: typeof compileUnionCH = (query, params, options) =>
	compileUnionCH(query, params, { ...options, dialect: options?.dialect ?? sqliteDialect })
export const compileUnionUnsafe: typeof compileUnionUnsafeCH = (query, params, options) =>
	compileUnionUnsafeCH(query, params, { ...options, dialect: options?.dialect ?? sqliteDialect })
