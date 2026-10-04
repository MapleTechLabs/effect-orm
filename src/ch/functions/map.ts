import { makeCond, makeExpr } from "../expr"
import { raw, str, compile } from "../../sql/sql-fragment"
import type { Expr, Condition } from "../expr"
import * as T from "../types"
import { builtins } from "./builtin"

const { lazy } = builtins("clickhouse", "scalar")

const STRINGS = T.array(T.string).schema
const STRING_MAP = T.map(T.string, T.string).schema

// Map functions (handwritten — bracket syntax or custom assembly)

export function mapContains(mapExpr: Expr<Record<string, string>>, key: string): Condition {
	return makeCond(lazy(() => `mapContains(${compile(mapExpr.toFragment())}, ${compile(str(key))})`))
}

export function mapGet(mapExpr: Expr<Record<string, string>>, key: string): Expr<string> {
	return makeExpr(lazy(() => `${compile(mapExpr.toFragment())}[${compile(str(key))}]`), T.string.schema)
}

export function mapKeys(mapExpr: Expr<Record<string, string>>): Expr<ReadonlyArray<string>> {
	return makeExpr(lazy(() => `mapKeys(${compile(mapExpr.toFragment())})`), STRINGS)
}

export function mapValues(mapExpr: Expr<Record<string, string>>): Expr<ReadonlyArray<string>> {
	return makeExpr(lazy(() => `mapValues(${compile(mapExpr.toFragment())})`), STRINGS)
}

export function mapLiteral(...pairs: Array<[string, Expr<string>]>): Expr<Record<string, string>> {
	if (pairs.length === 0) return makeExpr(lazy(() => "map()", "map"), STRING_MAP)
	const args = () => pairs.map(([k, v]) => `${compile(str(k))}, ${compile(v.toFragment())}`).join(", ")
	return makeExpr(lazy(() => `map(${args()})`), STRING_MAP)
}
