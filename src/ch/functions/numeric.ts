import { numericResultSchema, firstTypedNonNull } from "../define-fn"
import type { Expr, ParamsIn } from "../expr"
import * as T from "../types"
import { builtins } from "./builtin"

const { compileTypedFnCall, defineFn } = builtins("clickhouse", "scalar")

// Type conversion (defineFn one-liners)

// Inf/NaN and overflowing numeric strings parse successfully and decode as NaN.
export const toFloat64OrZero = <Q = never>(expr: Expr<string, Q>): Expr<number, Q> =>
	compileTypedFnCall("toFloat64OrZero", T.CHFloatResult, expr)
export const toFloat64 = <N extends number | null, Q = never>(expr: Expr<N, Q>): Expr<number | Extract<N, null>, Q> =>
	compileTypedFnCall("toFloat64", numericResultSchema(expr), expr)
export const toUInt16OrZero = defineFn<[Expr<string>], number>("toUInt16OrZero", T.uint16)
export const toUInt64 = defineFn<[Expr<number> | Expr<string>], number>("toUInt64", T.uint64)
export const toInt64 = <N extends number | null, Q = never>(expr: Expr<N, Q>): Expr<number | Extract<N, null>, Q> =>
	compileTypedFnCall("toInt64", numericResultSchema(expr), expr)

// Arithmetic (compileFnCall wrappers for mixed arg types)

export function intDiv<Q1 = never, Q2 = never>(a: Expr<number, Q1>, b: number | Expr<number, Q2>): Expr<number, Q1 | Q2> {
	return compileTypedFnCall<number>("intDiv", T.int64.schema, a, b)
}

export function round_<T extends number | null, Q = never>(
	expr: Expr<T, Q>,
	decimals?: number,
): Expr<number | Extract<T, null>, Q> {
	return decimals != null
		? compileTypedFnCall("round", numericResultSchema(expr), expr, decimals)
		: compileTypedFnCall("round", numericResultSchema(expr), expr)
}

// Variadic numeric functions

type Extremum<Args extends Expr<number | null>[]> =
	Extract<Args[number], Expr<number>> extends never ? number | null : number

export function least_<const Args extends Expr<number | null>[]>(...exprs: Args): Expr<Extremum<Args>, ParamsIn<Args[number]>> {
	return compileTypedFnCall("least", firstTypedNonNull<Args, Extremum<Args>>()(...exprs), ...exprs)
}

export function greatest_<const Args extends Expr<number | null>[]>(...exprs: Args): Expr<Extremum<Args>, ParamsIn<Args[number]>> {
	return compileTypedFnCall("greatest", firstTypedNonNull<Args, Extremum<Args>>()(...exprs), ...exprs)
}

export function cityHash64<const Args extends Expr<any>[]>(...exprs: Args): Expr<number, ParamsIn<Args[number]>> {
	return compileTypedFnCall<number>("cityHash64", T.uint64.schema, ...exprs)
}
