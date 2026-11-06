// @maple-dev/effect-orm/mysql
//
// MySQL 8.0+ and MariaDB 10.6+ from one import: column types, MySQL functions,
// the query builder and a `compile` that defaults to the MySQL dialect. Pass
// (or provide) `mariadbDialect` for MariaDB. See docs/mysql.md.
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
import { mysqlDialect } from "./mysql/dialect"
import { Effect } from "effect"

export * from "./core"
export * from "./mysql/types"
export * from "./mysql/functions"
export { table, type TableOptions } from "./ch/table"
export { mysqlDialect, mariadbDialect } from "./mysql/dialect"
export { type Casing } from "./schema/casing"

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
