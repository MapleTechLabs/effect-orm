// @maple-dev/effect-orm/mysql
//
// MySQL 8.0+ and MariaDB 10.6+ from one import: column types, tables with their
// DDL, MySQL functions, the query builder and a `compile` that defaults to the
// MySQL dialect. Pass (or provide) `mariadbDialect` for MariaDB. Migrations
// are generated, not applied, for now. See docs/mysql.md.
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
import { mysqlDialect } from "./mysql/dialect"
import {
	externalMysqlTable,
	isTableDefinition,
	mysqlTable,
	type ColumnInput,
	type ColumnsOf,
	type DefaultedColumnsOf,
	type ExternalTableDefinition,
	type InsertRequirementsOf,
	type MysqlSchemaTable,
	type TableDefinition,
	type UpdateRequirementsOf,
} from "./schema/mysql-define"
import { Effect } from "effect"

export * from "./core"
export * from "./mysql/types"
export * from "./mysql/functions"
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
	type MysqlSchemaTable,
	type TableDdl,
	type TableDefinition,
} from "./schema/mysql-define"
export { SchemaDefinitionError, type DefinitionProblem, type DdlExpr } from "./schema/define"
export { mysqlDialect, mariadbDialect } from "./mysql/dialect"
export { type Casing } from "./schema/casing"

/**
 * A MySQL table. With `{ columns, primaryKey, indexes }` it carries its DDL
 * (`renderMysqlSchema` from `/schema` writes it). With `{ external: true, columns }`,
 * or a bare record of columns and query options, it is a query schema only.
 */
export function table<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: ExternalTableDefinition<Columns>,
): Table<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>, never, InsertRequirementsOf<Columns>, UpdateRequirementsOf<Columns>>
export function table<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: TableDefinition<Columns>,
): MysqlSchemaTable<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>, InsertRequirementsOf<Columns>, UpdateRequirementsOf<Columns>>
export function table<
	const Name extends string,
	const Columns extends ColumnDefs,
	const Defaulted extends keyof Columns & string = never,
	const Computed extends keyof Columns & string = never,
>(name: Name, columns: Columns, options?: TableOptions<Columns, Defaulted, Computed>): Table<Name, Columns, Defaulted, Computed>
export function table(name: string, definition: any, options?: TableOptions<any, any, any>): Table<string, any, any, any> {
	if (options !== undefined || !isTableDefinition(definition)) return queryTable(name, definition, options)
	if ("external" in definition && definition.external === true) return externalMysqlTable(name, definition as ExternalTableDefinition<any>)
	return mysqlTable(name, definition as TableDefinition<any>)
}

/** The dialect a `/mysql` compile writes for: `options.dialect`, else `CurrentDialect`, else MySQL. */
const mysqlOptions = <O extends { readonly dialect?: Dialect | undefined } | undefined>(options: O) => ({
	...options,
	dialect: options?.dialect ?? activeDialect() ?? mysqlDialect,
})

/**
 * The shared compiler, for MySQL unless `options.dialect` or `CurrentDialect`
 * says otherwise. The dialect is read when the Effect runs, from the fiber
 * that runs it. Its type checks a query's functions and clauses against MySQL
 * (see `DialectSatisfied`).
 */
// Typed through `any` and cast, as in `/postgres`: `Compile` is overloaded.
export const compile = ((query: any, params?: any, options?: any) =>
	compiled(() => compileCHRaw(query, params, mysqlOptions(options)))) as Compile<"mysql">

/** Compile immediately, throwing on a failed compile. */
export const compileUnsafe = ((query: any, params?: any, options?: any) =>
	compiledUnsafe(() => compileCHRaw(query, params, mysqlOptions(options)))) as CompileUnsafe<"mysql">

export const compileUnion: CompileUnion<"mysql"> = (query, params, options) =>
	Effect.suspend(() => compileUnionCH(query, params, mysqlOptions(options)))
export const compileUnionUnsafe: CompileUnionUnsafe<"mysql"> = (query, params, options) =>
	compileUnionUnsafeCH(query, params, mysqlOptions(options))
