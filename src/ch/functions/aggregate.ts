import { numericResultSchema, overflowResultSchema } from "../define-fn"
import { QueryBuilderError } from "../errors"
import { makeExpr } from "../expr"
import { compile } from "../../sql/sql-fragment"
import type { Expr, Condition, ParamsIn } from "../expr"
import { type DateTime, Schema } from "effect"
import * as T from "../types"

import { schemaOf } from "../define-fn"
import { builtins } from "./builtin"

const { compileTypedFnCall, defineFn, lazy } = builtins("clickhouse", "aggregate")

/** `groupUniqArrayIf(x, cond)` collects `x`s, so it decodes as an array of `x`. */
const arraySchemaOf = <T>(expr: unknown) => {
	const element = schemaOf<T>(expr)
	return element ? Schema.Array(element) : undefined
}

// Standard aggregates (defineFn one-liners)

export const count = defineFn<[], number>("count", T.uint64)
export const avg = defineFn<[Expr<number | null>], number | null>("avg", T.nullable(T.float64))
// A finite Float64 input can overflow during accumulation; the resulting
// infinity decodes as NaN (see `overflowResultSchema`).
export const sum = <N extends number | null, Q = never>(expr: Expr<N, Q>): Expr<number | Extract<N, null>, Q> =>
	compileTypedFnCall("sum", overflowResultSchema(expr), expr)

// Condition-taking aggregates

export const countIf = defineFn<[Condition], number>("countIf", T.uint64)
export const sumIf = <N extends number | null, Q1 = never, Q2 = never>(
	expr: Expr<N, Q1>,
	condition: Condition<Q2>,
): Expr<number | Extract<N, null>, Q1 | Q2> => compileTypedFnCall("sumIf", overflowResultSchema(expr), expr, condition)
export const avgIf = defineFn<[Expr<number | null>, Condition], number | null>("avgIf", T.nullable(T.float64))
export const maxIf = <N extends number | null, Q1 = never, Q2 = never>(
	expr: Expr<N, Q1>,
	condition: Condition<Q2>,
): Expr<number | Extract<N, null>, Q1 | Q2> => compileTypedFnCall("maxIf", numericResultSchema(expr), expr, condition)
export const minIf = <N extends number | null, Q1 = never, Q2 = never>(
	expr: Expr<N, Q1>,
	condition: Condition<Q2>,
): Expr<number | Extract<N, null>, Q1 | Q2> => compileTypedFnCall("minIf", numericResultSchema(expr), expr, condition)

// Generic aggregates (compileFnCall for type preservation)

// These hand back one of their arguments unchanged, so they decode as it does.
// `sameAs(0)` is that rule by name — each of them used to carry its own copy.
//
// min/max over a Nullable column stay nullable: ClickHouse skips NULLs but
// returns NULL when every contributing value is NULL, so stripping the `| null`
// here (as an earlier version did with `NonNullable<T>`) lied to every caller
// while `sameAs(0)` kept the nullable runtime codec.

export const min_ = <T, Q = never>(expr: Expr<T, Q>): Expr<T, Q> => compileTypedFnCall("min", schemaOf<T>(expr), expr)

export const max_ = <T, Q = never>(expr: Expr<T, Q>): Expr<T, Q> => compileTypedFnCall("max", schemaOf<T>(expr), expr)

export const any_ = <T, Q = never>(expr: Expr<T, Q>): Expr<T, Q> => compileTypedFnCall("any", schemaOf<T>(expr), expr)

export const anyIf = <T, Q1 = never, Q2 = never>(expr: Expr<T, Q1>, cond: Condition<Q2>): Expr<T, Q1 | Q2> =>
	compileTypedFnCall("anyIf", schemaOf<T>(expr), expr, cond)

export const uniq = <T, Q = never>(expr: Expr<T, Q>): Expr<number, Q> => compileTypedFnCall("uniq", T.uint64.schema, expr)

/**
 * `uniqIf(value, condition)` — distinct `value`s among the rows matching
 * `condition`.
 *
 * The conditional counterpart to {@link uniq}, and the one to reach for over
 * `countIf` on a `ReplacingMergeTree`: un-merged duplicate rows for the same
 * key would inflate a `countIf` but not a `uniqIf` on that key.
 */
export const uniqIf = <T, Q1 = never, Q2 = never>(expr: Expr<T, Q1>, cond: Condition<Q2>): Expr<number, Q1 | Q2> =>
	compileTypedFnCall("uniqIf", T.uint64.schema, expr, cond)

/**
 * `uniqExact(value)` — the exact distinct count, where {@link uniq} estimates.
 *
 * Costs more memory than the HLL `uniq` and is the right one wherever the
 * number sits next to the rows it counts: a facet count that disagrees with the
 * visible list reads as a bug, not as an approximation.
 */
export const uniqExact = <T, Q = never>(expr: Expr<T, Q>): Expr<number, Q> =>
	compileTypedFnCall("uniqExact", T.uint64.schema, expr)

export const groupUniqArray = <T, Q = never>(expr: Expr<T, Q>): Expr<ReadonlyArray<T>, Q> =>
	compileTypedFnCall("groupUniqArray", arraySchemaOf<T>(expr), expr)

/**
 * `groupUniqArrayArray(arrayColumn)` — flatten arrays across rows into one
 * distinct set.
 *
 * The `-Array` combinator form of {@link groupUniqArray}: the argument is
 * already an array per row. This is also the merge function a
 * `SimpleAggregateFunction(groupUniqArrayArray, Array(T))` column is declared
 * with, so reading such a column back uses the same name.
 */
export const groupUniqArrayArray = <T, Q = never>(expr: Expr<ReadonlyArray<T>, Q>): Expr<ReadonlyArray<T>, Q> =>
	compileTypedFnCall("groupUniqArrayArray", schemaOf<ReadonlyArray<T>>(expr), expr)

/** `argMin(value, orderBy)` — the `value` from the row with the smallest `orderBy`. */
export const argMin = <T, Q1 = never, Q2 = never>(value: Expr<T, Q1>, orderBy: Expr<any, Q2>): Expr<T, Q1 | Q2> =>
	compileTypedFnCall("argMin", schemaOf<T>(value), value, orderBy)

/** `argMax(value, orderBy)` — the `value` from the row with the largest `orderBy`. */
export const argMax = <T, Q1 = never, Q2 = never>(value: Expr<T, Q1>, orderBy: Expr<any, Q2>): Expr<T, Q1 | Q2> =>
	compileTypedFnCall("argMax", schemaOf<T>(value), value, orderBy)

export const argMaxMerge = <T, Q = never>(expr: Expr<T, Q>): Expr<T, Q> =>
	compileTypedFnCall("argMaxMerge", schemaOf<T>(expr), expr)

// Curried / parametric aggregates (handwritten — custom SQL syntax)

export function quantile(q: number) {
	return <Q = never>(expr: Expr<number | null, Q>): Expr<number | null, Q> =>
		makeExpr(lazy(() => `quantile(${q})(${compile(expr.toFragment())})`), T.nullable(T.float64).schema)
}

/**
 * `groupUniqArrayIf(maxSize)(value, condition)` — up to `maxSize` distinct
 * values from the rows matching `condition`.
 *
 * The size is a *parameter* of the aggregate, not an argument, hence the
 * curried shape: `groupUniqArrayIf(3)(x, cond)` → `groupUniqArrayIf(3)(x, cond)`.
 */
export function groupUniqArrayIf(maxSize: number) {
	return <T, Q1 = never, Q2 = never>(expr: Expr<T, Q1>, cond: Condition<Q2>): Expr<ReadonlyArray<T>, Q1 | Q2> =>
		makeExpr(
			lazy(() =>
				`groupUniqArrayIf(${Math.round(maxSize)})(` +
					`${compile(expr.toFragment())}, ${compile(cond.toFragment())})`,
			),
			arraySchemaOf<T>(expr),
		)
}

/** The optional `windowFunnel` matching modes — see the ClickHouse docs. */
export type WindowFunnelMode = "strict_order" | "strict_deduplication" | "strict_increase"

/**
 * `windowFunnel(window[, mode])(timestamp, cond1, cond2, …)` — the ClickHouse
 * funnel aggregate: per group, the length of the longest prefix of
 * `cond1..condN` that occurred in that order within `window` of the `cond1`
 * event.
 *
 * `window` is in the unit of `timestamp`, whatever that unit happens to be —
 * seconds for a `Date`/`DateTime` column, but ClickHouse rejects `DateTime64`
 * outright, so a sub-second-precision column has to be projected to an integer
 * first and `window` then follows THAT unit. Projecting with
 * `toUInt64(toUnixTimestamp64Milli(ts))` means passing `windowSeconds * 1000`;
 * passing bare seconds against a millisecond timestamp silently yields a window
 * 1000x too short and a funnel that converts almost nobody past step 1.
 * Ordering within a group happens inside the aggregate; no `ORDER BY` is needed
 * on the input.
 *
 * Curried like {@link quantile}: the window and mode are *parameters* of the
 * aggregate, the timestamp and conditions are its arguments.
 */
export function windowFunnel(window: number, mode?: WindowFunnelMode) {
	const params = mode === undefined ? `${Math.round(window)}` : `${Math.round(window)}, '${mode}'`
	return <Q = never, C extends ReadonlyArray<Condition> = ReadonlyArray<Condition>>(
		timestamp: Expr<number | string | DateTime.Utc, Q>,
		...conditions: C
	): Expr<number, Q | ParamsIn<C[number]>> => {
		// Reported, not thrown: the number of conditions is the number of steps a
		// funnel has, and that count comes from data as often as from source.
		if (conditions.length === 0) {
			throw new QueryBuilderError({
				code: "InvalidArguments",
				message: "windowFunnel requires at least one condition",
			})
		}
		const args = () => [timestamp.toFragment(), ...conditions.map((c) => c.toFragment())]
			.map(compile)
			.join(", ")
		return makeExpr(lazy(() => `windowFunnel(${params})(${args()})`), T.uint8.schema)
	}
}

/**
 * `sequenceMatch(pattern)(timestamp, cond1, cond2, …)` — 1 when the events
 * matching `cond1..condN` occur in the order the pattern describes
 * (`'(?1)(?2)'`, `'(?1)(?t<3600)(?2)'`, …), else 0. ClickHouse returns a
 * `UInt8`, exposed as an `Expr<number>` for `sumIf`/`countIf`-style use.
 *
 * The pattern is embedded verbatim — it is ClickHouse's pattern grammar, not
 * user input, so only quote-free literals are accepted.
 */
export function sequenceMatch(pattern: string) {
	return <Q = never, C extends ReadonlyArray<Condition> = ReadonlyArray<Condition>>(
		timestamp: Expr<number | string | DateTime.Utc, Q>,
		...conditions: C
	): Expr<number, Q | ParamsIn<C[number]>> => {
		// An injection guard, so it reports rather than crashes: the pattern is
		// embedded verbatim, and "not user input" is a claim about the caller that
		// the caller is exactly who might get wrong.
		//
		// Checked here rather than when the factory is called, so that a hoisted
		// `const matcher = sequenceMatch(pattern)` fails inside the compile that
		// uses it rather than throwing at module scope, where nothing can catch it.
		if (pattern.includes("'") || pattern.includes("\\")) {
			throw new QueryBuilderError({
				code: "InvalidArguments",
				message: "sequenceMatch pattern must not contain quotes or backslashes",
			})
		}
		if (conditions.length === 0) {
			throw new QueryBuilderError({
				code: "InvalidArguments",
				message: "sequenceMatch requires at least one condition",
			})
		}
		const args = () => [timestamp.toFragment(), ...conditions.map((c) => c.toFragment())]
			.map(compile)
			.join(", ")
		return makeExpr(lazy(() => `sequenceMatch('${pattern}')(${args()})`), T.uint8.schema)
	}
}
