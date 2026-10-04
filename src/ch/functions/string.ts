import { acceptsSqlNull } from "../define-fn"
import { Schema } from "effect"
import { makeCond } from "../expr"
import { compile, str } from "../../sql/sql-fragment"
import type { Condition, Expr } from "../expr"
import * as T from "../types"
import { builtins } from "./builtin"

const { compileFnCall, compileTypedFnCall, defineFn, lazy } = builtins("clickhouse", "scalar")
const portable = builtins("portable", "scalar")

// Standard string functions (defineFn one-liners)

const stringResult = <A>(name: string, expr: Expr<A>): Expr<string | Extract<A, null>> =>
	compileTypedFnCall(name,
		(expr.schema && acceptsSqlNull(expr.schema) ? Schema.NullOr(T.string.schema) : T.string.schema) as Schema.Codec<string | Extract<A, null>, any>,
		expr)

export const toString_ = <A>(expr: Expr<A>): Expr<string | Extract<A, null>> => stringResult("toString", expr)
export const length_ = defineFn<[Expr<string>], number>("length", T.uint64)
export const lower_ = portable.defineFn<[Expr<string>], string>("lower", T.string)
export const positionCaseInsensitive = defineFn<[Expr<string>, Expr<string>], number>(
	"positionCaseInsensitive",
	T.uint64,
)
export const left_ = defineFn<[Expr<string>, Expr<number>], string>("left", T.string)

// URL functions
//
// ClickHouse parses these without a full URL library: `domain` returns the host
// without scheme, port, or userinfo (and `''` for an unparseable input rather
// than throwing), and `path` returns the pathname only — query string and
// fragment are already excluded, so a path grouped with `path_` carries no
// query-parameter PII. `cutQueryString` is the variant that keeps scheme and
// host, for when the full URL minus its query is wanted.

/** `hex(x)` — the hex rendering of any value's bytes, as a String. The usual
 *  reason to reach for it is making a hash printable. */
export const hex = <A>(expr: Expr<A>): Expr<string | Extract<A, null>> => stringResult("hex", expr)

export const domain_ = defineFn<[Expr<string>], string>("domain", T.string)
export const path_ = defineFn<[Expr<string>], string>("path", T.string)
export const cutQueryString = defineFn<[Expr<string>], string>("cutQueryString", T.string)

// Mixed Expr + literal args (compileFnCall wrappers)

export function position_(haystack: Expr<string>, needle: string): Expr<number> {
	return compileTypedFnCall<number>("position", T.uint64.schema, haystack, needle)
}

export function extract_(expr: Expr<string>, pattern: string): Expr<string> {
	return compileTypedFnCall<string>("extract", T.string.schema, expr, pattern)
}

export function replaceOne(haystack: Expr<string>, pattern: string, replacement: string): Expr<string> {
	return compileTypedFnCall<string>("replaceOne", T.string.schema, haystack, pattern, replacement)
}

/**
 * `match(haystack, pattern)` — RE2 regex test, returning UInt8.
 *
 * The numeric form is what you want when the result is a *value*: aggregating
 * it (`max(match(…))`) or projecting it as a 0/1 flag. Use {@link matchCond}
 * where a predicate is wanted, so the SQL reads as a condition rather than
 * `match(…) = 1`.
 */
export function match_(haystack: Expr<string>, pattern: string): Expr<number> {
	return compileTypedFnCall<number>("match", T.uint8.schema, haystack, pattern)
}

/** `match(haystack, pattern)` as a predicate — see {@link match_}. */
export function matchCond(haystack: Expr<string>, pattern: string): Condition {
	return makeCond(lazy(() => `match(${compile(haystack.toFragment())}, ${compile(str(pattern))})`))
}

// Variadic string functions

export function concat(...exprs: Array<Expr<string> | string>): Expr<string> {
	return compileTypedFnCall<string>("concat", T.string.schema, ...exprs)
}

/**
 * `multiSearchAnyCaseInsensitive(haystack, [needles])` as a predicate — true
 * when the haystack contains any needle, matched case-insensitively.
 *
 * One scan of the haystack against all needles at once, rather than the OR of N
 * `positionCaseInsensitive(...) > 0` calls it replaces. The difference is the
 * whole point of reaching for it: ClickHouse compiles a Volnitsky/Aho-Corasick
 * automaton over the needle set, so cost grows with the haystack rather than
 * with N, and the emitted SQL stays one function call instead of N nested ORs.
 *
 * Needles are literals by design — the multi-search family requires a constant
 * array, so there is no expression-valued overload to offer.
 */
export function multiSearchAnyCaseInsensitive(haystack: Expr<string>, needles: readonly string[]): Condition {
	const array = needles.map((needle) => compile(str(needle))).join(", ")
	return makeCond(lazy(() => `multiSearchAnyCaseInsensitive(${compile(haystack.toFragment())}, [${array}])`))
}

export function hasToken(haystack: Expr<string>, token: Expr<string> | string): Condition {
	const call = compileFnCall<boolean>("hasToken", haystack, token)
	return makeCond(call.toFragment())
}

export function hasAllTokens(haystack: Expr<string>, tokens: Expr<string> | string): Condition {
	const call = compileFnCall<boolean>("hasAllTokens", haystack, tokens)
	return makeCond(call.toFragment())
}
