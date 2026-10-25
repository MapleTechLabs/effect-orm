// What the fuzz suites need to know about a dialect: one value per dialect,
// registered in `./index.ts`. Every suite loops over the registry, so adding a
// dialect is one file here and one line there, not an edit in every suite.
//
// A dialect has one or more *targets*: a database the compiled SQL runs on, with
// the semantics the reference model needs for it (ClickHouse is two targets,
// because `join_use_nulls` changes what a LEFT JOIN fills). See ../README.md.
import { Cause, Effect, Exit } from "effect"
import type * as CH from "@maple-dev/effect-orm/clickhouse"
import type { CoreContext } from "../../core-cases"
import type { LiteralType } from "../values"

export type Outcome =
	| { readonly _tag: "Rows"; readonly rows: ReadonlyArray<unknown>; readonly wire: ReadonlyArray<unknown> }
	| { readonly _tag: "DatabaseError"; readonly message: string; readonly wire?: undefined }
	| { readonly _tag: "DecodeError"; readonly message: string; readonly wire: ReadonlyArray<unknown> }

/** Decode wire rows with the compiled query's own decoder, as `Database.run` would. */
export const decode = async (compiled: CH.CompiledQuery<any>, wire: ReadonlyArray<unknown>): Promise<Outcome> => {
	const exit = await Effect.runPromiseExit(compiled.decodeRows(wire as ReadonlyArray<Record<string, unknown>>))
	return Exit.isSuccess(exit)
		? { _tag: "Rows", rows: exit.value, wire }
		: { _tag: "DecodeError", message: Cause.pretty(exit.cause), wire }
}

/** Run raw SQL text and report a database refusal as an outcome, not an exception. */
export const runWith = async (
	compiled: CH.CompiledQuery<any>,
	query: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<ReadonlyArray<unknown>> | ReadonlyArray<unknown>,
): Promise<Outcome> => {
	let wire: ReadonlyArray<unknown>
	try {
		wire = await query(compiled.sql, compiled.parameters)
	} catch (error) {
		return { _tag: "DatabaseError", message: error instanceof Error ? error.message : String(error) }
	}
	return decode(compiled, wire)
}

/**
 * Where a database answers differently from another, and the difference is the
 * database's, not the builder's. The reference model reads only these, never a
 * target's name, so a new target states its semantics instead of patching the model.
 */
export interface Semantics {
	/** A column of an unmatched LEFT JOIN row: SQL NULL, or the column type's default (`''`, `0`). */
	readonly missingJoinColumn: "null" | "default"
	/** `/` over two integers: truncating integer division, or float division. */
	readonly integerDivision: "truncate" | "float"
	/**
	 * `%`: `truncate` is JS `%` on any operands; `clickhouse` declines what ClickHouse computes its own
	 * way (signed with unsigned, floats); `integer` casts both operands to integers first (SQLite).
	 */
	readonly modulo: "truncate" | "clickhouse" | "integer"
	/** Where NULL sorts, per direction, when ORDER BY names no NULLS FIRST/LAST. */
	readonly nulls: { readonly asc: "first" | "last"; readonly desc: "first" | "last" }
	/** sum/min/max over no rows in a global aggregate: NULL, or a default the model does not predict. */
	readonly emptyAggregate: "null" | "unmodelled"
	/** Whether `LIKE` ignores ASCII case (SQLite does). */
	readonly likeIgnoresCase: boolean
}

export interface FuzzTarget {
	/** Unique across dialects; appears in property names and `known-issues.ts`. */
	readonly name: string
	/** False when the database is not reachable here (an env var is unset): the target's live tests skip. */
	readonly available: boolean
	readonly semantics: Semantics
	readonly run: (compiled: CH.CompiledQuery<any>) => Promise<Outcome>
}

/** The parts of a dialect entry (`/clickhouse`, `/postgres`, …) the suites drive. */
export interface DialectModule {
	readonly compile: (query: any, params?: Record<string, unknown>) => Effect.Effect<CH.CompiledQuery<any>, unknown>
	readonly table: (name: string, definition: any) => CH.Table<string, any>
	readonly from: typeof CH.from
	readonly param: typeof CH.param
	readonly lit: typeof CH.lit
	readonly and: typeof CH.and
	readonly or: typeof CH.or
	readonly not: typeof CH.not
	readonly rawCond: typeof CH.rawCond
	readonly fromQuery: typeof CH.fromQuery
}

export interface FuzzDialect {
	readonly name: string
	readonly module: DialectModule
	/** The fixture tables as CTEs over literal rows, so the same plan reads the same rows everywhere. */
	readonly context: CoreContext
	/** What strings the dialect can store and hand back unchanged (see `nastyString`). */
	readonly strings: StringRules
	/** Whether the dialect has `ILIKE`; plans use it only where it exists. */
	readonly ilike: boolean
	/**
	 * Checks the placeholders in compiled SQL line up with its parameters, or
	 * returns why not. Skipped when a plan's own strings could contain one.
	 */
	readonly checkPlaceholders?: (sql: string, parameterCount: number) => string | undefined
	/** Column types the literal round-trip property covers. */
	readonly literals: ReadonlyArray<LiteralType>
	/** The databases this dialect's SQL runs on. The first is the literal suite's. */
	readonly targets: ReadonlyArray<FuzzTarget>
	/** Release a connection or process the targets opened. */
	readonly close?: () => Promise<void>
}

export interface StringRules {
	/** Whether a string may contain U+0000. */
	readonly nul: boolean
	/** Whether a string may start with a BOM (some drivers strip it). */
	readonly leadingBom: boolean
}
