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
} from "./ch/compile"
import { postgresDialect } from "./pg/dialect"

export * from "./core"
export * from "./pg/types"
export * from "./pg/functions"
// Portable: renders the same SQL on both dialects.
export { nullIf } from "./ch/functions"
export { postgresDialect }

// Tables and their DDL. `table` is the only way to declare a table: it carries
// the keys, indexes and foreign keys `effect-orm generate` diffs.
export {
	table,
	column,
	index,
	uniqueIndex,
	foreignKey,
	defaultForeignKeyName,
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

/** `compile`, for Postgres unless `options.dialect` says otherwise. */
// Typed through `any` and cast: `compileCH` is overloaded (queries and inserts),
// and an overloaded type gives an arrow's parameters no contextual type.
export const compile = ((query: any, params?: any, options?: any) =>
	compileCH(query, params, { ...options, dialect: options?.dialect ?? postgresDialect })) as typeof compileCH

/** `compileUnsafe` for Postgres. */
export const compileUnsafe = ((query: any, params?: any, options?: any) =>
	compileCHUnsafe(query, params, { ...options, dialect: options?.dialect ?? postgresDialect })) as typeof compileCHUnsafe

/** `compileUnion` for Postgres. */
export const compileUnion: typeof compileUnionCH = (union, params, options) =>
	compileUnionCH(union, params, { ...options, dialect: options?.dialect ?? postgresDialect })

/** `compileUnionUnsafe` for Postgres. */
export const compileUnionUnsafe: typeof compileUnionUnsafeCH = (union, params, options) =>
	compileUnionUnsafeCH(union, params, { ...options, dialect: options?.dialect ?? postgresDialect })
