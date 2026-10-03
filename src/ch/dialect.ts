// SQL Dialects
//
// What a compiled query needs to know about the database it is written for.
// The builder, the tenant analysis, and row decoding are the same for every
// database; a dialect is the part that is not: how identifiers and literals are
// written, how resolved param values reach the server, which clauses exist, and
// how a portable param kind encodes. See `design/dialects.md`.

import type { Schema } from "effect"
import { quoteClickHouseString } from "../sql/sql-fragment"
import { activeSqlSyntax, withSqlSyntax, type SqlSyntax } from "../sql/sql-syntax"
import { QueryBuilderError } from "./errors"
import { sqlLiteral } from "./literal"
import { PARAM_MARKER_PREFIX } from "./param"
import { chDateTimeLiteral } from "./types"

/**
 * How resolved param values reach the server.
 *
 * `inline` writes each value into the SQL text with the dialect's `literal`,
 * which is what ClickHouse over HTTP has always done here. `bind` leaves a
 * placeholder in the SQL and returns the encoded values in
 * `CompiledQuery.parameters`, in placeholder order, for a driver that binds
 * them (`$1` for Postgres, `?` for MySQL and SQLite).
 */
export type ParamStyle =
	| { readonly _tag: "inline" }
	| {
			readonly _tag: "bind"
			/** The placeholder for the value at 1-based `index`, bound for a param
			 *  of `kind` (`string`, `int`, `float`, `bool`, `dateTime`, ...). */
			readonly placeholder: (index: number, kind: string) => string
			/**
			 * Whether one placeholder may stand for every use of the same param.
			 *
			 * True for numbered placeholders (`$1` can appear twice); false for
			 * positional ones (`?` binds the next value each time it appears), where
			 * a param used twice is bound twice.
			 */
			readonly reuse: boolean
			/**
			 * The most values one statement may bind, when the server has a limit
			 * (Postgres: 65535). A statement over it fails to compile, rather than
			 * at the server or by being split into several statements.
			 */
			readonly maxParameters?: number
	  }

/** Clauses that exist in some dialects and not others. */
export interface DialectClauses {
	/** `FORMAT <name>` after a statement. A query with `.format()` fails to
	 *  compile for a dialect without it. */
	readonly format: boolean
	/** Whether a subquery in FROM needs an alias (`SELECT * FROM (…) AS u`). */
	readonly derivedTableAlias: boolean
	/** Whether GROUP BY resolves a select alias before an input column of the
	 *  same name. Where it does not, keys are written by select-list position. */
	readonly groupByAlias: boolean
	/** Whether each `UNION ALL` branch is wrapped in parentheses. Postgres needs
	 *  it for a branch with its own WITH, ORDER BY or LIMIT. */
	readonly parenthesizeUnionBranches: boolean
}

/** A transaction isolation level. `read uncommitted` is left out: Postgres runs it as `read committed`. */
export type IsolationLevel = "read committed" | "repeatable read" | "serializable"

/** What a transaction starts with. Every field is optional; an empty value changes nothing. */
export interface TransactionSettings {
	readonly isolationLevel?: IsolationLevel | undefined
	readonly accessMode?: "read write" | "read only" | undefined
	/** Postgres: wait for a safe snapshot. Only meaningful with `serializable` and `read only`. */
	readonly deferrable?: boolean | undefined
}

/**
 * What transactions a dialect supports. Read by `@maple-dev/effect-orm/database`
 * before any statement is sent, so an unsupported request fails instead of
 * pretending. See `design/transactions.md`.
 */
export interface DialectTransactions {
	/**
	 * `none`: a transaction fails with `TransactionUnsupported`. ClickHouse is
	 * `none`: its transactions are experimental, need a server flag and an HTTP
	 * session, and a BEGIN without a session is silently a no-op.
	 */
	readonly support: "none" | "full"
	/** Whether a nested transaction becomes a savepoint. Without it, nesting fails. */
	readonly savepoints: boolean
	readonly isolationLevels: ReadonlyArray<IsolationLevel>
	readonly accessModes: boolean
	readonly deferrable: boolean
	/**
	 * The statement that applies `settings`, run as the first statement of a
	 * transaction, or `undefined` when there is nothing to apply.
	 */
	readonly setTransaction: (settings: TransactionSettings) => string | undefined
}

/** No transactions. What a dialect without a `transactions` entry gets. */
export const noTransactions: DialectTransactions = {
	support: "none",
	savepoints: false,
	isolationLevels: [],
	accessModes: false,
	deferrable: false,
	setTransaction: () => undefined,
}

/**
 * A database the builder writes SQL for.
 *
 * `quoteString` and `literal` must escape so that no value can spell the param
 * marker (`__PARAM_`) in the rendered SQL: params are resolved by rewriting the
 * finished text, so a value that spelled one would be rewritten too. A literal
 * that does is refused at compile time rather than trusted.
 */
export interface Dialect extends SqlSyntax {
	/** Shown in errors. */
	readonly name: string
	readonly params: ParamStyle
	readonly clauses: DialectClauses
	/**
	 * The codec a portable param kind encodes with here, where it differs from
	 * the ClickHouse one: `param.bool` is `1`/`0` for ClickHouse and a boolean
	 * for Postgres, `param.dateTime` a zoneless string for one and an ISO-8601
	 * instant for the other. Kinds not listed use the ClickHouse codec.
	 */
	readonly paramCodecs?: Readonly<Record<string, Schema.Codec<any, any>>>
	/** Transaction support. Absent means none. */
	readonly transactions?: DialectTransactions
}

/** ClickHouse, with params written into the SQL as literals. The default. */
export const clickhouseDialect: Dialect = {
	name: "clickhouse",
	quoteIdent: (name) => name,
	quoteString: quoteClickHouseString,
	literal: sqlLiteral,
	dateTimeLiteral: (value) => quoteClickHouseString(chDateTimeLiteral(value)),
	params: { _tag: "inline" },
	clauses: { format: true, derivedTableAlias: false, groupByAlias: true, parenthesizeUnionBranches: false },
	transactions: noTransactions,
}

// The dialect of the enclosing compile, beside the syntax installed for the
// fragment renderer. Same save/restore discipline as `withSqlSyntax`.
let current: Dialect | undefined

/** The dialect of the enclosing compile, or ClickHouse outside one. */
export const currentDialect = (): Dialect => current ?? clickhouseDialect

/** Run `body` with `dialect`'s syntax installed, literals checked as above. */
export function withDialect<A>(dialect: Dialect, body: () => A): A {
	// A nested compile for the dialect already installed keeps the checked
	// syntax that is there instead of wrapping it again.
	if (current === dialect && activeSqlSyntax() !== undefined) return body()
	const previous = current
	current = dialect
	try {
		return withSqlSyntax(checkedSyntax(dialect), body)
	} finally {
		current = previous
	}
}

/** `dialect.literal`, checked as above. For params written in after the
 *  callbacks have run, outside any installed syntax. */
export const checkedLiteral = (dialect: Dialect, value: unknown, context: string): string =>
	checked(dialect, dialect.literal(value, context), context)

const checkedSyntax = (dialect: Dialect): SqlSyntax => ({
	quoteIdent: dialect.quoteIdent,
	quoteString: (value) => checked(dialect, dialect.quoteString(value), "a string literal"),
	literal: (value, context) => checkedLiteral(dialect, value, context),
	dateTimeLiteral: (value) => checked(dialect, dialect.dateTimeLiteral(value), "a DateTime literal"),
})

const checked = (dialect: Dialect, sql: string, context: string): string => {
	if (sql.includes(PARAM_MARKER_PREFIX)) {
		throw new QueryBuilderError({
			code: "InvalidLiteral",
			message: `${context}: the ${dialect.name} dialect wrote a literal containing the reserved param marker \`${PARAM_MARKER_PREFIX}\``,
		})
	}
	return sql
}
