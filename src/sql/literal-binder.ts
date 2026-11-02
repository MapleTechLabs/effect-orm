// Where a compile for a dialect that binds params sends literal values.
//
// A value compared with a typed column is encoded deep inside expression code,
// as a literal. Postgres binds params, and should bind those values too: kept
// out of the statement text, they stay out of logs and traces, and one query
// shape is one statement whatever the values. `compile` installs a binder here
// for the duration of the compile, as it installs the dialect's syntax.

import { Context } from "effect"
import { fiberLocal } from "./fiber-local"

/** Takes an encoded wire value; returns the SQL that stands for it. */
export type LiteralBinder = (wire: unknown) => string

// Kept in the compiling fiber's context; see `fiber-local.ts`.
const current = fiberLocal(
	Context.Reference<LiteralBinder | undefined>("@maple-dev/effect-orm/internal/LiteralBinder", {
		defaultValue: () => undefined,
	}),
)

export function withLiteralBinder<A>(binder: LiteralBinder | undefined, body: () => A): A {
	return current.with(binder, body)
}

/** The binder installed by the enclosing compile, if there is one. */
export const activeLiteralBinder = (): LiteralBinder | undefined => current.get()
