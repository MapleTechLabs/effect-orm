// UNION ALL Query Builder
//
// Combines multiple CHQuery instances with UNION ALL. All sub-queries must
// share the same Output type. Supports optional outer ORDER BY / LIMIT /
// OFFSET wrapping.

import type { ColumnDefs } from "./types"
import type { CHQuery, CompatibleTypes, OutputOf, RowCount } from "./query"

// Union state (runtime)

interface CHUnionState {
	readonly queries: ReadonlyArray<CHQuery<any, any, any>>
	readonly outerOrderBySpecs: Array<[string, "asc" | "desc"]>
	readonly outerLimitValue?: number
	readonly outerOffsetValue?: number
	readonly formatValue?: string
}

// CHUnionQuery interface

export interface CHUnionQuery<Output extends Record<string, any> = {}, Params = never> {
	readonly _tag: "CHUnionQuery"
	/** @internal — runtime union state */
	readonly _state: CHUnionState
	/** phantom */
	readonly _phantom?: { output: Output; params: (entries: Params) => void }

	orderBy(...specs: Array<[keyof Output & string, "asc" | "desc"]>): CHUnionQuery<Output, Params>

	limit<N extends number>(n: RowCount<N>): CHUnionQuery<Output, Params>

	offset<N extends number>(n: RowCount<N>): CHUnionQuery<Output, Params>

	format(fmt: "JSON" | "JSONEachRow"): CHUnionQuery<Output, Params>
}

/** Extract the Output type from a CHUnionQuery. */
export type InferUnionOutput<Q> = Q extends CHUnionQuery<infer O> ? O : never

// Implementation

function makeUnionQuery<Output extends Record<string, any>>(state: CHUnionState): CHUnionQuery<Output, any> {
	return {
		_tag: "CHUnionQuery" as const,
		_state: state,

		orderBy(...specs) {
			return makeUnionQuery({
				...state,
				outerOrderBySpecs: specs as Array<[string, "asc" | "desc"]>,
			})
		},

		limit(n) {
			return makeUnionQuery({ ...state, outerLimitValue: n })
		},

		offset(n) {
			return makeUnionQuery({ ...state, outerOffsetValue: n })
		},

		format(fmt) {
			return makeUnionQuery({ ...state, formatValue: fmt })
		},
	}
}

// Entry point

type AnyQuery = CHQuery<ColumnDefs, any, any, any>

/** The aliases branch `O` disagrees with the first branch `O0` on: missing,
 *  extra, or of a type the first branch's column cannot hold. */
type BranchMisfits<O0, O> = {
	[K in keyof O0 | keyof O]: K extends keyof O0
		? K extends keyof O
			? CompatibleTypes<O0[K], O[K]> extends true
				? never
				: K
			: K
		: K
}[keyof O0 | keyof O]

/**
 * `unknown` when every branch selects the first branch's aliases, of types
 * that can share a column; otherwise a property naming the aliases that differ.
 * Branches are matched by alias, not position, so their order may differ.
 */
export type UnionBranchesFit<Q extends ReadonlyArray<AnyQuery>> = [keyof OutputOf<Q[0]>] extends [never]
	? { readonly selectRequired: "every unionAll branch needs a select()" }
	: [{ [I in keyof Q]: BranchMisfits<OutputOf<Q[0]>, OutputOf<Q[I]>> }[number]] extends [never]
		? unknown
		: { readonly unionColumnsDiffer: { [I in keyof Q]: BranchMisfits<OutputOf<Q[0]>, OutputOf<Q[I]>> }[number] }

/** The `ParamEntry`s of a query, union or write; `never` when it has none. */
export type QueryParams<Q> = Q extends { readonly _phantom?: { readonly params: (entries: infer P) => void } }
	? 0 extends 1 & P
		? never
		: P
	: never

/** The union's row: the first branch's aliases, each typed as any branch's. */
export type UnionOutput<Q extends ReadonlyArray<AnyQuery>> = {
	readonly [K in keyof OutputOf<Q[0]>]: OutputOf<Q[number]>[K]
}

export function unionAll<const Q extends readonly [AnyQuery, ...Array<AnyQuery>]>(
	...queries: Q & UnionBranchesFit<Q>
): CHUnionQuery<UnionOutput<Q>, QueryParams<Q[number]>> {
	return makeUnionQuery({
		queries: queries as ReadonlyArray<AnyQuery>,
		outerOrderBySpecs: [],
	})
}
