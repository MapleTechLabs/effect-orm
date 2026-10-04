import { makeCond, makeExpr } from "../expr"
import { raw, str, compile } from "../../sql/sql-fragment"
import type { Expr, Condition, ParamsIn } from "../expr"
import * as T from "../types"
import { builtins } from "./builtin"

const { lazy } = builtins("clickhouse", "scalar")

const STRINGS = T.array(T.string).schema
const STRING_MAP = T.map(T.string, T.string).schema

// Map functions (handwritten — bracket syntax or custom assembly)

export function mapContains<Q = never>(mapExpr: Expr<Record<string, string>, Q>, key: string): Condition<Q> {
	return makeCond(lazy(() => `mapContains(${compile(mapExpr.toFragment())}, ${compile(str(key))})`))
}

export function mapGet<Q = never>(mapExpr: Expr<Record<string, string>, Q>, key: string): Expr<string, Q> {
	return makeExpr(lazy(() => `${compile(mapExpr.toFragment())}[${compile(str(key))}]`), T.string.schema)
}

export function mapKeys<Q = never>(mapExpr: Expr<Record<string, string>, Q>): Expr<ReadonlyArray<string>, Q> {
	return makeExpr(lazy(() => `mapKeys(${compile(mapExpr.toFragment())})`), STRINGS)
}

export function mapValues<Q = never>(mapExpr: Expr<Record<string, string>, Q>): Expr<ReadonlyArray<string>, Q> {
	return makeExpr(lazy(() => `mapValues(${compile(mapExpr.toFragment())})`), STRINGS)
}

export function mapLiteral<
	Pairs extends ReadonlyArray<readonly [string, Expr<string>]> = ReadonlyArray<readonly [string, Expr<string>]>,
>(...pairs: Pairs): Expr<Record<string, string>, ParamsIn<Pairs[number][1]>> {
	if (pairs.length === 0) return makeExpr(lazy(() => "map()", "map"), STRING_MAP)
	const args = () => pairs.map(([k, v]) => `${compile(str(k))}, ${compile(v.toFragment())}`).join(", ")
	return makeExpr(lazy(() => `map(${args()})`), STRING_MAP)
}
