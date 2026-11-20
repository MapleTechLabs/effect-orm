// Standard SQL window functions, for the dialects that spell them the SQL way.
//
// Postgres and SQLite write `fn(args) OVER (PARTITION BY … ORDER BY … frame)`
// with the same function names, so one factory builds both sets; each entry
// instantiates it with its own function set, which is the entry its results
// carry (`SqliteOnly`, `PostgresOnly`). The window spec itself (`windowSpec`,
// `rowsBetween`, the bounds) is dialect-neutral and shared with ClickHouse.

import { Schema } from "effect"
import { makeExpr, operandOf, type Comparable, type Expr } from "../expr"
import { fail } from "../failure"
import { schemaOf } from "../define-fn"
import { QueryBuilderDefect } from "../errors"
import { compile } from "../../sql/sql-fragment"
import { builtins, type SetEntry } from "./builtin"
import type { CompiledWindowSpec } from "./window"

const sql = (expr: Expr<unknown, any>): string => compile(expr.toFragment())

/** An offset of `lead`/`lag`: a non-negative whole number, written in the query. */
const offsetSql = (name: string, offset: number): string =>
	Number.isSafeInteger(offset) && offset >= 0
		? String(offset)
		: fail(new QueryBuilderDefect({ message: `${name}: the offset must be a non-negative integer, got ${offset}` }), "1")

/**
 * The window functions of `set`. `integer` decodes the dialect's ranking
 * results (`row_number()` is a bigint on Postgres, sent as text).
 */
export function sqlWindowFunctions<const Set extends "sqlite" | "postgres">(set: Set, integer: Schema.Codec<number, unknown>) {
	type Only = SetEntry<Set>
	const window = builtins(set, "window")

	/**
	 * `expr OVER (spec)`: an aggregate or a window function over a window of
	 * rows. The window changes which rows feed the value, never how it decodes.
	 */
	const over = <T, Q1 = never, Q2 = never>(expr: Expr<T, Q1>, spec: CompiledWindowSpec<Q2>): Expr<T, Q1 | Q2 | Only> =>
		makeExpr(window.lazy(() => `${sql(expr)} OVER (${spec.sql})`, "over"), schemaOf<T>(expr))

	const nullable = <A>(expr: Expr<A, any>): Schema.Codec<A | null, unknown> | undefined => {
		const schema = schemaOf<A>(expr)
		return schema === undefined ? undefined : (Schema.NullOr(schema) as Schema.Codec<A | null, unknown>)
	}

	const shift = (name: "lead" | "lag") => {
		function shifted<A, Q = never>(expr: Expr<A, Q>, offset?: number): Expr<A | null, Q | Only>
		function shifted<A, Q = never, Q3 = never>(
			expr: Expr<A, Q>,
			offset: number,
			fallback: Comparable<NonNullable<A>> | Expr<A, Q3> | Expr<NonNullable<A>, Q3>,
		): Expr<A, Q | Q3 | Only>
		function shifted(expr: Expr<unknown, any>, offset?: number, ...rest: ReadonlyArray<unknown>): Expr<unknown, any> {
			const hasFallback = rest.length > 0
			return makeExpr(
				window.lazy(() => {
					const args = [sql(expr)]
					if (offset !== undefined || hasFallback) args.push(offsetSql(name, offset ?? 1))
					// A plain fallback is written the way a comparison with `expr` writes it: through its column's codec.
					if (hasFallback) args.push(compile(operandOf(expr, rest[0])))
					return `${name}(${args.join(", ")})`
				}, name),
				// Past the partition's edge there is no row: NULL, unless a fallback fills it.
				hasFallback ? schemaOf(expr) : nullable(expr),
			)
		}
		return shifted
	}

	/** `lead(expr, offset, fallback)`: `expr` of the row `offset` (1) rows ahead in the window; NULL past the end unless `fallback` is given. Use in `over`. */
	const lead = shift("lead")
	/** `lag(expr, offset, fallback)`: as `lead`, `offset` rows behind. Use in `over`. */
	const lag = shift("lag")

	/** `row_number()`: the row's 1-based position in its partition. Use in `over`. */
	const rowNumber = (): Expr<number, Only> => makeExpr(window.lazy(() => "row_number()", "row_number"), integer)
	/** `rank()`: the row's rank, with gaps after ties. Use in `over`. */
	const rank = (): Expr<number, Only> => makeExpr(window.lazy(() => "rank()", "rank"), integer)
	/** `dense_rank()`: the row's rank, without gaps after ties. Use in `over`. */
	const denseRank = (): Expr<number, Only> => makeExpr(window.lazy(() => "dense_rank()", "dense_rank"), integer)
	/** `first_value(expr)`: `expr` of the window frame's first row. Use in `over`. */
	const firstValue = <A, Q = never>(expr: Expr<A, Q>): Expr<A, Q | Only> =>
		makeExpr(window.lazy(() => `first_value(${sql(expr)})`, "first_value"), schemaOf<A>(expr))
	/** `last_value(expr)`: `expr` of the window frame's last row (the current row, under the default frame). Use in `over`. */
	const lastValue = <A, Q = never>(expr: Expr<A, Q>): Expr<A, Q | Only> =>
		makeExpr(window.lazy(() => `last_value(${sql(expr)})`, "last_value"), schemaOf<A>(expr))

	return { over, lead, lag, rowNumber, rank, denseRank, firstValue, lastValue }
}
