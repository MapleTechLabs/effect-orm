import { makeCond, makeExpr, toFragment } from "../expr"
import { str, compile } from "../../sql/sql-fragment"
import type { Condition, Expr, ParamsIn } from "../expr"
import { Schema } from "effect"
import * as T from "../types"
import { elementSchema, mergeResultSchemas, schemaOf } from "../define-fn"
import { builtins } from "./builtin"

const { compileTypedFnCall, lazy } = builtins("clickhouse", "scalar")

// Array constructors (handwritten — bracket syntax, not fn() call)

export function arrayOf<T, E extends ReadonlyArray<Expr<T>> = ReadonlyArray<Expr<T>>>(
	...exprs: E & ReadonlyArray<Expr<T>>
): Expr<ReadonlyArray<T>, ParamsIn<E[number]>> {
	const args = () => exprs.map((e) => compile(e.toFragment())).join(", ")
	const element = mergeResultSchemas(exprs.map((expr) => expr.schema))
	return makeExpr(lazy(() => `[${args()}]`), element && Schema.Array(element))
}

// Array functions (handwritten — polymorphic or special syntax)

export function arrayStringConcat<const Parts extends ReadonlyArray<Expr<string>> | Expr<ReadonlyArray<string>>>(
	parts: Parts,
	sep: string,
): Expr<string, ParamsIn<Parts extends ReadonlyArray<Expr<string>> ? Parts[number] : Parts>> {
	if (Array.isArray(parts)) {
		const arr = () => parts.map((p: Expr<string>) => compile(p.toFragment())).join(", ")
		return makeExpr(lazy(() => `arrayStringConcat([${arr()}], ${compile(str(sep))})`), T.string.schema)
	}
	const expr = parts as Expr<ReadonlyArray<string>>
	return makeExpr(
		lazy(() => `arrayStringConcat(${compile(expr.toFragment())}, ${compile(str(sep))})`),
		T.string.schema,
	)
}

export function arrayFilter<T, Q = never>(fn: string, arr: Expr<ReadonlyArray<T>, Q>): Expr<ReadonlyArray<T>, Q> {
	return makeExpr(lazy(() => `arrayFilter(${fn}, ${compile(arr.toFragment())})`), schemaOf<ReadonlyArray<T>>(arr))
}

/** `arrayJoin` unnests, so the row value is one element of the array. */
export const arrayJoin = <T, Q = never>(arr: Expr<ReadonlyArray<T>, Q>): Expr<T, Q> =>
	compileTypedFnCall("arrayJoin", elementSchema<T>(schemaOf<ReadonlyArray<T>>(arr)), arr)

/**
 * Array functions that hand back the array they were given, reordered or
 * filtered — so the result decodes exactly as the input does.
 */
export const arraySort = <T, Q = never>(arr: Expr<ReadonlyArray<T>, Q>): Expr<ReadonlyArray<T>, Q> =>
	compileTypedFnCall("arraySort", schemaOf<ReadonlyArray<T>>(arr), arr)

export const arrayReverseSort = <T, Q = never>(arr: Expr<ReadonlyArray<T>, Q>): Expr<ReadonlyArray<T>, Q> =>
	compileTypedFnCall("arrayReverseSort", schemaOf<ReadonlyArray<T>>(arr), arr)

export const arrayDistinct = <T, Q = never>(arr: Expr<ReadonlyArray<T>, Q>): Expr<ReadonlyArray<T>, Q> =>
	compileTypedFnCall("arrayDistinct", schemaOf<ReadonlyArray<T>>(arr), arr)

export const arrayPushFront = <T, Q1 = never, Q2 = never>(
	arr: Expr<ReadonlyArray<T>, Q1>,
	element: Expr<T, Q2>,
): Expr<ReadonlyArray<T>, Q1 | Q2> => {
	const item = mergeResultSchemas([elementSchema(arr.schema), element.schema])
	return compileTypedFnCall("arrayPushFront", item && Schema.Array(item), arr, element)
}

/** `arrayElement(arr, n)` — ClickHouse's 1-indexed subscript. The result is one
 *  element, so it decodes as the array's element type. */
export const arrayElement = <T, Q1 = never, Q2 = never>(
	arr: Expr<ReadonlyArray<T>, Q1>,
	index: number | Expr<number, Q2>,
): Expr<T, Q1 | Q2> => compileTypedFnCall("arrayElement", elementSchema<T>(schemaOf<ReadonlyArray<T>>(arr)), arr, index)

export function has<T, Q1 = never, Q2 = never>(arr: Expr<ReadonlyArray<T>, Q1>, value: Expr<T, Q2> | T): Condition<Q1 | Q2> {
	const valueFragment = toFragment(value)
	return makeCond(lazy(() => `has(${compile(arr.toFragment())}, ${compile(valueFragment)})`))
}
