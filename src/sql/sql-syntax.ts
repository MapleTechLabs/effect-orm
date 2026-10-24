// Syntax of the dialect being compiled for.
//
// Identifiers and literals are written while a query's callbacks run, deep
// inside expression code that has no dialect argument to read. `compile`
// installs the dialect's syntax here for the duration of the compile instead,
// the same way `withSubqueryCompiler` hands down the subquery renderer. A leaf
// module so the fragment renderer can read it without importing the builder.

import type { DateTime } from "effect"

export interface SqlSyntax {
	/** The dialect's name (`clickhouse`, `postgres`, …), for the few choices expression code makes per dialect. */
	readonly dialect: string
	/** False when the dialect has no ILIKE operator. */
	readonly ilike?: boolean
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

// Compilation is synchronous. Save/restore makes nested compilations
// independent, including when a callback throws.
let current: SqlSyntax | undefined

export function withSqlSyntax<A>(syntax: SqlSyntax, body: () => A): A {
	const previous = current
	current = syntax
	try {
		return body()
	} finally {
		current = previous
	}
}

/** The syntax installed by the enclosing compile, if there is one. */
export const activeSqlSyntax = (): SqlSyntax | undefined => current
