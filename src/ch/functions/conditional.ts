import { makeExpr, toFragment } from "../expr"
import { compile } from "../../sql/sql-fragment"
import type { Expr, Condition, ParamsIn } from "../expr"
import { Schema } from "effect"
import { firstTypedNonNull, mergeResultSchemas, numericResultSchema, schemaOf } from "../define-fn"
import { builtins } from "./builtin"

const { compileTypedFnCall, lazy } = builtins("clickhouse", "scalar")
const portable = builtins("portable", "scalar")

// if / multiIf (handwritten — standard fn shape but special arg types)

/** Either branch can produce the result, including a nullable branch. */
export const if_ = <T, Q1 = never, Q2 = never, Q3 = never>(
	cond: Condition<Q1>,
	then_: Expr<T, Q2>,
	else_: Expr<T, Q3>,
): Expr<T, Q1 | Q2 | Q3> => compileTypedFnCall("if", branchSchema<T>(then_, else_), cond, then_, else_)

export function multiIf<
	T,
	const Cases extends ReadonlyArray<readonly [Condition, Expr<T>]> = ReadonlyArray<readonly [Condition, Expr<T>]>,
	Q = never,
>(cases: Cases & ReadonlyArray<readonly [Condition, Expr<T>]>, else_: Expr<T, Q>): Expr<T, ParamsIn<Cases[number][number]> | Q> {
	const parts = () => cases
		.map(([cond, val]) => `${compile(cond.toFragment())}, ${compile(val.toFragment())}`)
		.join(", ")
	return makeExpr(
		lazy(() => `multiIf(${parts()}, ${compile(else_.toFragment())})`),
		branchSchema<T>(...cases.map(([, value]) => value), else_),
	)
}

// Variadic conditional functions

/** The first argument that is not NULL — non-nullable as soon as one argument
 *  is, which is what {@link firstTypedNonNull} reads off the arguments. */
type ExprValue<E> = E extends Expr<any> ? Exclude<E["_phantom"], undefined> : never
type Coalesced<Args extends readonly Expr<any>[]> = Args extends readonly [
	...Expr<any>[],
	infer Last extends Expr<any>,
]
	? null extends ExprValue<Last>
		? ExprValue<Args[number]>
		: NonNullable<ExprValue<Args[number]>>
	: number extends Args["length"]
		? ExprValue<Args[number]>
		: Args extends readonly [infer Head extends Expr<any>, ...infer Tail extends Expr<any>[]]
			? null extends ExprValue<Head>
				? Exclude<ExprValue<Head>, null> | Coalesced<Tail>
				: ExprValue<Head>
			: null

export const coalesce = <const Args extends Expr<any>[]>(...exprs: Args): Expr<Coalesced<Args>, ParamsIn<Args[number]>> =>
	portable.compileTypedFnCall("coalesce", firstTypedNonNull<Args, Coalesced<Args>>()(...exprs), ...exprs)

/**
 * `ifNull(expr, fallback)` — `expr` unless it is NULL, else `fallback`. The
 * two-argument coalesce; a non-nullable fallback strips the `| null`.
 */
export const ifNull = <T, Q1 = never, Q2 = never>(expr: Expr<T | null, Q1>, fallback: Expr<T, Q2>): Expr<T, Q1 | Q2> =>
	compileTypedFnCall("ifNull", firstTypedNonNull<[Expr<T | null>, Expr<T>], T>()(expr, fallback), expr, fallback)

export function nullIf<T, Q1 = never, Q2 = never>(expr: Expr<T, Q1>, value: Expr<T, Q2> | T): Expr<T | null, Q1 | Q2> {
	// The result is `expr` or NULL, so it decodes as `expr` does — nullably.
	const schema = schemaOf<T>(expr)
	return portable.compileTypedFnCall<T | null>("nullIf", schema && Schema.NullOr(schema), expr, value)
}

/**
 * `ifNotFinite(expr, fallback)` — `expr` unless it is `nan`/`inf`, else
 * `fallback`.
 *
 * SQL NULL passes through unchanged. For a guaranteed numeric result use
 * `ifNull(ifNotFinite(expr, 0), lit(0))`.
 */
export function ifNotFinite<N extends number | null, Q1 = never, Q2 = never>(
	expr: Expr<N, Q1>,
	fallback: number | Expr<number, Q2>,
): Expr<number | Extract<N, null>, Q1 | Q2> {
	return makeExpr<number | Extract<N, null>>(
		lazy(() => `ifNotFinite(${compile(expr.toFragment())}, ${compile(toFragment(fallback))})`),
		numericResultSchema(expr),
	)
}

function branchSchema<T>(...exprs: Expr<T>[]): Schema.Codec<T, any> | undefined {
	return mergeResultSchemas(exprs.map((expr) => expr.schema))
}
