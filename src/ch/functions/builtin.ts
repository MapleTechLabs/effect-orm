// The builder's own functions.
//
// Every built-in function renders through one of these sets, which does two
// things a caller-declared function cannot:
//
// - It refuses to render for a dialect whose function set it is not from:
//   ClickHouse's `count()` is an error on Postgres, which wants `count(*)`,
//   and most ClickHouse functions do not exist there at all. Outside a
//   compile nothing is checked.
// - It tells the render tracker what it is (`render-tracker.ts`): a scalar
//   function whose arguments it may count, an aggregate, or a window, whose
//   insides it does not count. That is what lets `compile` refuse an aggregate
//   in WHERE, or a column next to an aggregate that is not grouped.

import type { Schema } from "effect"
import { compile, known, type SqlFragment } from "../../sql/sql-fragment"
import { hidden, inAggregate } from "../../sql/render-tracker"
import { activeDialect } from "../dialect"
import { QueryBuilderDefect } from "../errors"
import { type Condition, type Expr, makeCond, makeExpr, makeUntypedExpr, type ParamsIn, toFragment } from "../expr"
import type { FnResult } from "../define-fn"

export type FunctionSet = "clickhouse" | "postgres"
export type BuiltinKind = "scalar" | "aggregate" | "window"

const setLabel: Record<FunctionSet, string> = {
	clickhouse: "a ClickHouse function (from @maple-dev/effect-orm/clickhouse)",
	postgres: "a Postgres function (from @maple-dev/effect-orm/postgres)",
}

const assertSet = (set: FunctionSet | "portable", name: string | undefined): void => {
	if (set === "portable") return
	const dialect = activeDialect()
	if (dialect === undefined) return
	if (dialect.functions !== undefined && dialect.functions !== set) {
		throw new QueryBuilderDefect({
			message: `${name === undefined ? "this function" : `${name}()`} is ${setLabel[set]} and has no meaning for the ${dialect.name} dialect; use that dialect's own function`,
		})
	}
}

/** Built-in functions of one set and kind. `portable` renders for every dialect. */
export function builtins(set: FunctionSet | "portable", kind: BuiltinKind) {
	const wrap =
		kind === "aggregate" ? inAggregate : kind === "window" ? hidden : (render: () => string): string => render()

	/** A built-in function's SQL, rendered lazily. */
	const lazy = (render: () => string, name?: string): SqlFragment =>
		known(() => {
			assertSet(set, name)
			return wrap(render)
		})

	const call = (name: string, args: ReadonlyArray<unknown>): SqlFragment =>
		lazy(() => `${name}(${args.map((a) => compile(toFragment(a))).join(", ")})`, name)

	// The call helpers leave params to the signature of the function that uses
	// them (`any` here); `defineFn` and `defineCondFn` carry their arguments'
	// params on to their result.

	function compileTypedFnCall<R>(name: string, schema: Schema.Codec<R, unknown> | undefined, ...args: unknown[]): Expr<R, any> {
		return makeExpr<R>(call(name, args), schema)
	}

	function compileFnCall<R>(name: string, ...args: unknown[]): Expr<R, any> {
		return makeUntypedExpr<R>(call(name, args))
	}

	function compileFnCallCond(name: string, ...args: unknown[]): Condition<any> {
		return makeCond(call(name, args))
	}

	function defineFn<Args extends unknown[], R>(
		name: string,
		result: FnResult<Args, R>,
	): <A extends Args>(...args: A) => Expr<R, ParamsIn<A[number]>> {
		return <A extends Args>(...args: A) =>
			compileTypedFnCall<R>(
				name,
				typeof result === "function" ? result(...args) : (result.schema as Schema.Codec<R, unknown>),
				...args,
			)
	}

	function defineCondFn<Args extends unknown[]>(name: string): <A extends Args>(...args: A) => Condition<ParamsIn<A[number]>> {
		return <A extends Args>(...args: A) => compileFnCallCond(name, ...args)
	}

	return { lazy, compileTypedFnCall, compileFnCall, compileFnCallCond, defineFn, defineCondFn }
}
