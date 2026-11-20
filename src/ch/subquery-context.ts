import { Context } from "effect"
import { fiberLocal } from "../sql/fiber-local"
import type { CHQuery } from "./query"

type RenderSubquery = (query: string | CHQuery<any, any, any>) => string

// Kept in the compiling fiber's context (see `fiber-local.ts`). Save/restore
// makes nested compilations independent, including when a callback throws.
const current = fiberLocal(
	Context.Reference<RenderSubquery | undefined>("@maple-dev/effect-orm/internal/SubqueryCompiler", {
		defaultValue: () => undefined,
	}),
)

export function withSubqueryCompiler<A>(render: RenderSubquery, body: () => A): A {
	return current.with(render, body)
}

// Set while a subquery renders, so a column of an enclosing write's target
// table (written bare in the write itself) can qualify itself there: a bare
// `"userId"` inside `(SELECT … FROM "membership_index" AS "mi" WHERE …)`
// would name the subquery's column, not the target's.
const nested = fiberLocal(
	Context.Reference<boolean>("@maple-dev/effect-orm/internal/InSubquery", { defaultValue: () => false }),
)

export const renderSubquery = (query: string | CHQuery<any, any, any>, fallback: RenderSubquery): string =>
	nested.with(true, () => (current.get() ?? fallback)(query))

/** Whether a subquery is rendering, inside the statement that holds it. */
export const inSubquery = (): boolean => nested.get()
