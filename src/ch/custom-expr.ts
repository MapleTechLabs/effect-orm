// Expressions a caller builds from SQL fragments.
//
// The public `makeExpr` / `makeUntypedExpr` / `makeCond`. The builder's own
// functions use the unchecked ones in `./expr`, whose signatures carry their
// arguments' params; a caller's fragment is a closure the type cannot see
// into, so these take the expressions it interpolates as `uses`, carry their
// params in the type, and check when compiling that the rendered SQL holds no
// param beyond theirs. A param can then never be in a query without being in
// its type: either `uses` names it, or compiling fails and says so.

import { fail } from "./failure"
import { type Condition, type Expr, makeCond as makeCondUnchecked, makeExpr as makeExprUnchecked, type ParamsIn } from "./expr"
import { QueryBuilderDefect } from "./errors"
import { PARAM_PLACEHOLDER_PATTERN } from "./param"
import { compile, lazy, type SqlFragment } from "../sql/sql-fragment"
import { untracked } from "../sql/render-tracker"
import type { Schema } from "effect"

/** The `param.*` placeholders in rendered SQL. */
const placeholders = (sql: string): ReadonlySet<string> =>
	new Set([...sql.matchAll(new RegExp(PARAM_PLACEHOLDER_PATTERN.source, "g"))].map((match) => match[0]))

const fragmentOf = (value: unknown): SqlFragment | undefined =>
	typeof value === "object" && value !== null && "toFragment" in value && typeof value.toFragment === "function"
		? (value as { toFragment(): SqlFragment }).toFragment()
		: undefined

/** `fragment`, refusing at render a param that none of `uses` holds. */
const checked = (what: string, fragment: SqlFragment, uses: ReadonlyArray<unknown>): SqlFragment =>
	lazy(() => {
		const sql = compile(fragment)
		const found = placeholders(sql)
		if (found.size === 0) return sql
		// Rendered again only to read their placeholders, outside the render track.
		const declared = new Set(
			untracked(() =>
				uses.flatMap((use) => {
					const f = fragmentOf(use)
					return f === undefined ? [] : [...placeholders(compile(f))]
				}),
			),
		)
		const undeclared = [...found].filter((p) => !declared.has(p))
		if (undeclared.length > 0) {
			return fail(new QueryBuilderDefect({
				message: `${what}: the SQL holds a param (${undeclared.join(", ")}) that no expression in \`uses\` carries; pass the expressions you interpolate as \`uses\` so the query's type requires their params`,
			}), "NULL")
		}
		return sql
	})

/**
 * An expression from a fragment and the codec its value decodes with.
 *
 * `uses` lists the expressions the fragment interpolates: their params become
 * the result's, so `compile` requires them. A param in the SQL that no `uses`
 * entry carries fails to compile.
 *
 * `uses` is the first type parameter so that it is always inferred: the value
 * type comes from `schema`, and an explicit `makeExpr<number>(…)` is an error
 * rather than a call that silently stops reading `uses`.
 */
export function makeExpr<const U extends ReadonlyArray<unknown> = [], T = unknown>(
	fragment: SqlFragment,
	schema: Schema.Codec<T, any> | undefined,
	literal?: (value: unknown) => SqlFragment,
	uses?: U,
): Expr<T, ParamsIn<U[number]>> {
	return makeExprUnchecked<T>(checked("makeExpr", fragment, uses ?? []), schema, literal)
}

/** {@link makeExpr} with no declared result type: selecting it costs the query its row schema. */
export function makeUntypedExpr<const U extends ReadonlyArray<unknown> = [], T = unknown>(
	fragment: SqlFragment,
	literal?: (value: unknown) => SqlFragment,
	uses?: U,
): Expr<T, ParamsIn<U[number]>> {
	return makeExprUnchecked<T>(checked("makeUntypedExpr", fragment, uses ?? []), undefined, literal)
}

/** A condition from a fragment. `uses` as for {@link makeExpr}. */
export function makeCond<const U extends ReadonlyArray<unknown> = []>(
	fragment: SqlFragment,
	uses?: U,
): Condition<ParamsIn<U[number]>> {
	return makeCondUnchecked(checked("makeCond", fragment, uses ?? []))
}
