// Syntax of the dialect being compiled for.
//
// Identifiers and literals are written while a query's callbacks run, deep
// inside expression code that has no dialect argument to read. `compile`
// installs the dialect's syntax in its fiber for the duration of the compile instead,
// the same way `withSubqueryCompiler` hands down the subquery renderer. A leaf
// module so the fragment renderer can read it without importing the builder.

import { Context, type DateTime } from "effect"
import { fiberLocal } from "./fiber-local"

export interface SqlSyntax {
	/** The dialect's name (`clickhouse`, `postgres`, …), for the few choices expression code makes per dialect. */
	readonly dialect: string
	/** One identifier (a column, alias, table or schema name), quoted as needed. */
	readonly quoteIdent: (name: string) => string
	/** A string as a quoted literal. */
	readonly quoteString: (value: string) => string
	/** An encoded wire value (string, number, boolean, null, arrays and records
	 *  of those) as a literal. Throws for a value it cannot write. */
	readonly literal: (value: unknown, context: string) => string
	/** A point in time compared against an expression with no declared type. */
	readonly dateTimeLiteral: (value: DateTime.Utc) => string
}

// Kept in the compiling fiber's context (see `fiber-local.ts`). Save/restore
// makes nested compilations independent, including when a callback throws.
const current = fiberLocal(
	Context.Reference<SqlSyntax | undefined>("@maple-dev/effect-orm/internal/SqlSyntax", { defaultValue: () => undefined }),
)

export function withSqlSyntax<A>(syntax: SqlSyntax, body: () => A): A {
	return current.with(syntax, body)
}

/** The syntax installed by the enclosing compile, if there is one. */
export const activeSqlSyntax = (): SqlSyntax | undefined => current.get()
