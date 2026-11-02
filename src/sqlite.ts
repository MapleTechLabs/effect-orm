// @maple-dev/effect-orm/sqlite
//
// SQLite and Cloudflare D1 from one import: column types, tables with their
// DDL, SQLite functions, the query builder and a `compile` that defaults to
// the SQLite dialect. Migrations stay with the caller for now. See
// docs/sqlite.md.
import { compileCH, compileCHRaw, compileCHUnsafe, compileUnion as compileUnionCH, compileUnionUnsafe as compileUnionUnsafeCH } from "./ch/compile"
import { compiled, compiledUnsafe } from "./ch/failure"
import { table as queryTable, type Table, type TableOptions } from "./ch/table"
import type { ColumnDefs } from "./ch/types"
import {
	externalSqliteTable,
	isTableDefinition,
	sqliteTable,
	type ColumnInput,
	type ColumnsOf,
	type DefaultedColumnsOf,
	type ExternalTableDefinition,
	type SqliteSchemaTable,
	type TableDefinition,
} from "./schema/sqlite-define"
import { sqliteDialect } from "./sqlite/dialect"

export * from "./core"
export * from "./sqlite/types"
export * from "./sqlite/functions"
export type { TableOptions }
export {
	column,
	index,
	uniqueIndex,
	type ColumnInput,
	type ColumnOptions,
	type ColumnSpec,
	type ColumnsOf,
	type DefaultedColumnsOf,
	type ExternalTableDefinition,
	type IndexSpec,
	type SqliteSchemaTable,
	type TableDdl,
	type TableDefinition,
} from "./schema/sqlite-define"
export { SchemaDefinitionError, type DefinitionProblem, type DdlExpr, type DdlKey } from "./schema/define"

/**
 * A SQLite table. With `{ columns, primaryKey, indexes }` it carries its DDL
 * (`renderSqliteSchema` from `/schema` writes it). With `{ external: true, columns }`,
 * or a bare record of columns and query options, it is a query schema only.
 */
export function table<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: ExternalTableDefinition<Columns>,
): Table<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>, never>
export function table<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: TableDefinition<Columns>,
): SqliteSchemaTable<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>>
export function table<
	const Name extends string,
	const Columns extends ColumnDefs,
	const Defaulted extends keyof Columns & string = never,
	const Computed extends keyof Columns & string = never,
>(name: Name, columns: Columns, options?: TableOptions<Columns, Defaulted, Computed>): Table<Name, Columns, Defaulted, Computed>
export function table(name: string, definition: any, options?: TableOptions<any, any, any>): Table<string, any, any, any> {
	if (options !== undefined || !isTableDefinition(definition)) return queryTable(name, definition, options)
	if ("external" in definition && definition.external === true) return externalSqliteTable(name, definition as ExternalTableDefinition<any>)
	return sqliteTable(name, definition as TableDefinition<any>)
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
