// SQLite queries and codecs. DDL/migrations stay with the caller for now.
import { compileCH, compileCHRaw, compileCHUnsafe, compileUnion as compileUnionCH, compileUnionUnsafe as compileUnionUnsafeCH } from "./ch/compile"
import { compiled, compiledUnsafe } from "./ch/failure"
import { sqliteDialect } from "./sqlite/dialect"

export * from "./core"
export * from "./sqlite/types"
export { table, type TableOptions } from "./ch/table"
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
