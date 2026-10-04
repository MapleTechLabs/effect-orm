// Subquery conditions
//
// These live here rather than in `expr.ts` because they need `compileCH`, and
// `expr.ts` is imported by both `query.ts` and `compile.ts`. Putting the import
// there would close the cycle `expr → compile → query → expr`, which survives
// today only because everything crossing it is a hoisted `function` declaration
// — one top-level `const` away from a TDZ crash in the bundle.

import { renderSubquery } from "./subquery-context"
import { compileCHUnsafe } from "./compile"
import { type Condition, type Expr, makeCond, makeExpr, makeUntypedExpr } from "./expr"
import type { CHQuery, NeedsSelect, SingleColumnOf } from "./query"
import type { CHType } from "./types"
import { compile, lazy } from "../sql/sql-fragment"

/**
 * A subquery, either as a builder query or as SQL someone compiled elsewhere.
 *
 * The string arm exists for the handful of places that genuinely hold only SQL
 * (a CTE body read from a catalog, say). Prefer the query arm: it keeps the
 * inner query's params, table names and column types checked.
 */
export type Subquery = string | CHQuery<any, any, any>

/**
 * Render in the owning compiler so params, visible CTEs, and tenant scope stay
 * connected. Standalone fragment rendering defers params for a later compile.
 */
const toSql = (subquery: Subquery): string =>
	renderSubquery(subquery, (query) =>
		typeof query === "string"
			? query
			: compileCHUnsafe(query, {}, { skipFormat: true, deferParams: true }).sql,
	)

// Subqueries contribute their own source scope, never a binding on outer rows.
// An inner tenant filter cannot confine an otherwise unfiltered outer source.

/** `EXISTS (subquery)` — for correlated subqueries (see `outerRef`). */
export function exists<O extends Record<string, any>>(subquery: string | (CHQuery<any, O, any, any> & NeedsSelect<O>)): Condition {
	return makeCond(lazy(() => `EXISTS (${toSql(subquery)})`))
}

/**
 * `expr IN (subquery)`. The subquery must select exactly one column, of a type
 * `expr` can be compared with. The SQL-string arm is unchecked.
 */
export function inSubquery<T, O extends Record<string, any>>(
	expr: Expr<T>,
	subquery: string | (CHQuery<any, O, any, any> & SingleColumnOf<O, T>),
): Condition {
	return makeCond(lazy(() => `${compile(expr.toFragment())} IN (${toSql(subquery)})`))
}

/**
 * `expr NOT IN (subquery)` — an anti-join expressed as a predicate.
 *
 * Note ClickHouse's NULL semantics: if the subquery yields any NULL, `NOT IN`
 * is never true. Project a non-nullable column, or filter the NULLs inside.
 */
export function notInSubquery<T, O extends Record<string, any>>(
	expr: Expr<T>,
	subquery: string | (CHQuery<any, O, any, any> & SingleColumnOf<O, T>),
): Condition {
	return makeCond(lazy(() => `${compile(expr.toFragment())} NOT IN (${toSql(subquery)})`))
}

// Spliced sub-SELECTs
//
// The three conditions above put a subquery where SQL expects a subquery. These
// put its *SQL text* somewhere the builder has no syntax for — inside an
// aggregate, a CTE reference, a tuple comparison — which is a real need and the
// reason `compileCHUnsafe` used to be called from query-definition code.
//
// Doing that eagerly is the problem: a query definition that compiles an inner
// query is running the compiler outside the `Effect` its own `compile` will run
// in, so an unencodable value handed to the inner query throws synchronously
// from the *builder*. Both constructors below defer the inner compile to the
// outer one, which is what puts the failure back in the error channel.

/**
 * An inner query's SQL spliced into an expression, compiled with the outer
 * query.
 *
 * `wrap` receives the inner SQL and returns the expression text — it is where
 * the aggregate or subquery syntax the builder cannot express goes. It runs
 * during the outer `compile`, so a `QueryBuilderError` raised by the inner
 * query surfaces as the outer compilation's typed failure.
 *
 * ```ts
 * const cutoff = subqueryExpr(cheapScan, T.dateTimeString, (sql) => `(SELECT min(ts) FROM (${sql}))`)
 * ```
 *
 * Params are deferred: placeholders inside the spliced SQL are resolved by the
 * outer query's substitution pass, with the outer params.
 *
 * Expression composition preserves deferred rendering, including when a caller
 * builds the expression or condition before the outer query.
 */
export function subqueryExpr<T>(
	subquery: Subquery,
	type: CHType<string, T, any>,
	wrap: (sql: string) => string = (sql) => `(${sql})`,
): Expr<T> {
	return makeExpr<T>(
		lazy(() => wrap(toSql(subquery))),
		type.schema,
	)
}

/** {@link subqueryExpr} for a spliced value with no declared result type — a
 *  sort tuple, an `argMin` tiebreaker. Selecting one costs the query its row
 *  schema, the same as `untypedExpr`. */
export function untypedSubqueryExpr<T = unknown>(
	subquery: Subquery,
	wrap: (sql: string) => string = (sql) => `(${sql})`,
): Expr<T> {
	return makeUntypedExpr<T>(lazy(() => wrap(toSql(subquery))))
}

/** {@link subqueryExpr} as a predicate — for the `IN`/`EXISTS` shapes the three
 *  conditions above do not cover, such as `x IN (SELECT k FROM (<inner>))`. */
export function subqueryCond(subquery: Subquery, wrap: (sql: string) => string): Condition {
	return makeCond(lazy(() => wrap(toSql(subquery))))
}
