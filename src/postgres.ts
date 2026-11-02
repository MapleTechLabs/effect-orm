// @maple-dev/effect-orm/postgres
//
// Everything for Postgres from one import: column types, tables with their
// DDL, Postgres functions, the query builder and a `compile` that defaults to
// the Postgres dialect. ClickHouse has the same shape under `/clickhouse`. See
// docs/postgres.md.

import {
	compileCH,
	compileCHUnsafe,
	compileUnion as compileUnionCH,
	compileUnionUnsafe as compileUnionUnsafeCH,
	type Compile,
	type CompileUnion,
	type CompileUnionUnsafe,
	type CompileUnsafe,
} from "./ch/compile"
import { activeDialect, type Dialect } from "./ch/dialect"
import { postgresDialect } from "./pg/dialect"
import { Effect } from "effect"

export * from "./core"
export * from "./pg/types"
export * from "./pg/functions"
// Portable: renders the same SQL on both dialects.
export { nullIf } from "./ch/functions"
export { postgresDialect }

// Tables and their DDL. `table` is the only way to declare a table: it carries
// the keys, indexes, unique constraints and foreign keys `effect-orm generate`
// diffs. `enumType` is a column type and a schema object both.
export {
	table,
	column,
	index,
	uniqueIndex,
	unique,
	foreignKey,
	defaultForeignKeyName,
	enumType,
	type EnumOptions,
	type PgEnum,
	type UniqueColumnOptions,
	type UniqueOptions,
	type UniqueSpec,
	type ColumnInput,
	type ColumnOptions,
	type ColumnSpec,
	type ColumnsOf,
	type DefaultedColumnsOf,
	type DdlPredicate,
	type ForeignKeySpec,
	type IndexOptions,
	type IndexSpec,
	type PgSchemaTable,
	type ReferentialAction,
	type TableDdl,
	type TableDefinition,
	type ExternalTableDefinition,
} from "./schema/pg-define"
export { SchemaDefinitionError, type DefinitionProblem, type DdlExpr, type DdlKey } from "./schema/define"

/** The dialect a `/postgres` compile writes for: `options.dialect`, else `CurrentDialect`, else Postgres. */
const pgOptions = <O extends { readonly dialect?: Dialect | undefined } | undefined>(options: O) => ({
	...options,
	dialect: options?.dialect ?? activeDialect() ?? postgresDialect,
})

/** `compile`, for Postgres unless `options.dialect` or `CurrentDialect` says otherwise. */
// Typed through `any` and cast: `compileCH` is overloaded (queries and inserts),
// and an overloaded type gives an arrow's parameters no contextual type. The
// dialect is read when the Effect runs, from the fiber that runs it.
export const compile = ((query: any, params?: any, options?: any) =>
	Effect.suspend(() => compileCH(query, params, pgOptions(options)))) as Compile<"postgres">

/** `compileUnsafe` for Postgres. */
export const compileUnsafe = ((query: any, params?: any, options?: any) =>
	compileCHUnsafe(query, params, pgOptions(options))) as CompileUnsafe<"postgres">

/** `compileUnion` for Postgres. */
export const compileUnion: CompileUnion<"postgres"> = (union, params, options) =>
	Effect.suspend(() => compileUnionCH(union, params, pgOptions(options)))

/** `compileUnionUnsafe` for Postgres. */
export const compileUnionUnsafe: CompileUnionUnsafe<"postgres"> = (union, params, options) =>
	compileUnionUnsafeCH(union, params, pgOptions(options))
