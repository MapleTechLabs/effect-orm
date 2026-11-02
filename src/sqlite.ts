// @maple-dev/effect-orm/sqlite
//
// SQLite and Cloudflare D1 from one import: column types, tables with their
// DDL, SQLite functions, the query builder and a `compile` that defaults to
// the SQLite dialect. Migrations stay with the caller for now. See
// docs/sqlite.md.
import {
	compileCHRaw,
	compileUnion as compileUnionCH,
	compileUnionUnsafe as compileUnionUnsafeCH,
	type Compile,
	type CompileUnion,
	type CompileUnionUnsafe,
	type CompileUnsafe,
} from "./ch/compile"
import { activeDialect, type Dialect } from "./ch/dialect"
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
	type InsertRequirementsOf,
	type SqliteSchemaTable,
	type TableDefinition,
	type UpdateRequirementsOf,
} from "./schema/sqlite-define"
import { sqliteDialect } from "./sqlite/dialect"
import { Effect } from "effect"

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
export { type Casing } from "./schema/casing"

/**
 * A SQLite table. With `{ columns, primaryKey, indexes }` it carries its DDL
 * (`renderSqliteSchema` from `/schema` writes it). With `{ external: true, columns }`,
 * or a bare record of columns and query options, it is a query schema only.
 */
export function table<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: ExternalTableDefinition<Columns>,
): Table<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>, never, InsertRequirementsOf<Columns>, UpdateRequirementsOf<Columns>>
export function table<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: TableDefinition<Columns>,
): SqliteSchemaTable<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>, InsertRequirementsOf<Columns>, UpdateRequirementsOf<Columns>>
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

/** The dialect a `/sqlite` compile writes for: `options.dialect`, else `CurrentDialect`, else SQLite. */
const sqliteOptions = <O extends { readonly dialect?: Dialect | undefined } | undefined>(options: O) => ({
	...options,
	dialect: options?.dialect ?? activeDialect() ?? sqliteDialect,
})

/**
 * The shared compiler, for SQLite unless `options.dialect` or `CurrentDialect`
 * says otherwise. Pass (or provide) d1Dialect for D1's limits. The dialect is
 * read when the Effect runs, from the fiber that runs it. Its type checks a
 * query's functions and clauses against SQLite (see `DialectSatisfied`).
 */
// Typed through `any` and cast, as in `/postgres`: `Compile` is overloaded.
export const compile = ((query: any, params?: any, options?: any) =>
	compiled(() => compileCHRaw(query, params, sqliteOptions(options)))) as Compile<"sqlite">

/** Compile immediately, throwing on a failed compile. */
export const compileUnsafe = ((query: any, params?: any, options?: any) =>
	compiledUnsafe(() => compileCHRaw(query, params, sqliteOptions(options)))) as CompileUnsafe<"sqlite">

export const compileUnion: CompileUnion<"sqlite"> = (query, params, options) =>
	Effect.suspend(() => compileUnionCH(query, params, sqliteOptions(options)))
export const compileUnionUnsafe: CompileUnionUnsafe<"sqlite"> = (query, params, options) =>
	compileUnionUnsafeCH(query, params, sqliteOptions(options))
