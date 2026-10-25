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

export const renderSubquery = (query: string | CHQuery<any, any, any>, fallback: RenderSubquery): string =>
	(current.get() ?? fallback)(query)
