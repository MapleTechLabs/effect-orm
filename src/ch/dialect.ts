// SQL Dialects
//
// What a compiled query needs to know about the database it is written for.
// The builder, the tenant analysis, and row decoding are the same for every
// database; a dialect is the part that is not: how identifiers and literals are
// written, how resolved param values reach the server, which clauses exist, and
// how a portable param kind encodes. See `design/dialects.md`.

import { Context, type Schema } from "effect"
import { fiberLocal } from "../sql/fiber-local"
import { quoteClickHouseString } from "../sql/sql-fragment"
import { activeSqlSyntax, withSqlSyntax, type SqlSyntax } from "../sql/sql-syntax"
import { QueryBuilderError } from "./errors"
import { sqlLiteral } from "./literal"
import { PARAM_MARKER_PREFIX } from "./param"
import { chDateTimeLiteral } from "./types"
import { fail } from "./failure"

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
			/**
			 * False where the driver ends text at U+0000 (SQLite's), so a bound
			 * string containing one would arrive cut short. Such a value fails to
			 * compile instead.
			 */
			readonly nulInText?: boolean
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
	/** SQLite preserves branch-local ORDER BY/LIMIT by selecting from each branch. */
	readonly wrapUnionBranches?: boolean
	/** SQLite requires LIMIT -1 before OFFSET when the caller omitted a limit. */
	readonly offsetRequiresLimit?: boolean
	/** `RETURNING` after an INSERT. Absent means no: an insert with
	 *  `.returning()` fails to compile for the dialect. */
	readonly returning?: boolean
	/** `ON CONFLICT ... DO NOTHING / DO UPDATE` after an INSERT. Absent means
	 *  no: an insert with `onConflict*` fails to compile for the dialect. */
	readonly onConflict?: boolean
	/** Whether ON CONFLICT can name a constraint rather than columns. */
	readonly onConflictConstraint?: boolean
	/** SQLite disambiguates INSERT SELECT ... ON CONFLICT with a WHERE. */
	readonly insertSelectNeedsWhere?: boolean
	/** Whether a VALUES tuple can contain DEFAULT for a missing cell. */
	readonly defaultInValues?: boolean
	/** Whether SELECT DISTINCT ON is supported. Undefined preserves existing dialects. */
	readonly distinctOn?: boolean
	/** `SETTINGS` on an INSERT, UPDATE or DELETE (ClickHouse). Absent means
	 *  no: a write with `.settings()` fails to compile for the dialect. */
	readonly writeSettings?: boolean
	/** Row locking on a SELECT (`FOR UPDATE`, `FOR SHARE`, `SKIP LOCKED`). Absent
	 *  means no: a query with `.forUpdate()` and the like fails to compile. */
	readonly locking?: boolean
	/** UPDATE is written `ALTER TABLE t UPDATE ... WHERE ...`, a ClickHouse
	 *  mutation, rather than `UPDATE t SET ... WHERE ...`. */
	readonly alterTableUpdate?: boolean
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
export interface Dialect extends Omit<SqlSyntax, "dialect"> {
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
	/**
	 * Which built-in function set renders correctly here: `clickhouse` (the
	 * `/clickhouse` entry's functions) or `postgres` (`@maple-dev/effect-orm/postgres`).
	 * A built-in function from another set fails to compile. Absent means
	 * unchecked: a custom dialect says which set it renders, if either.
	 */
	readonly functions?: string
	/**
	 * The ORDER BY keys for a numeric UNION ALL column whose branches may have
	 * different types. ClickHouse has no common type for `UInt64` and `Int64`
	 * (or `Int64` and `Float64`): the column is a `Variant`, which ORDER BY
	 * refuses as a key. The values are left as they are (an INSERT ... SELECT or
	 * an IN over the union keeps them exact); only the sort key is converted.
	 * Absent: the dialect orders such a column as it is.
	 */
	readonly unionNumberOrderKeys?: (column: string) => ReadonlyArray<string>
}

/** ClickHouse, with params written into the SQL as literals. The default. */
export const clickhouseDialect: Dialect = {
	name: "clickhouse",
	quoteIdent: (name) => name,
	quoteString: quoteClickHouseString,
	literal: sqlLiteral,
	dateTimeLiteral: (value) => quoteClickHouseString(chDateTimeLiteral(value)),
	params: { _tag: "inline" },
	clauses: {
		format: true,
		derivedTableAlias: false,
		groupByAlias: true,
		parenthesizeUnionBranches: false,
		returning: false,
		onConflict: false,
		writeSettings: true,
		alterTableUpdate: true,
	},
	transactions: noTransactions,
	functions: "clickhouse",
	// CAST, not toFloat64: ClickHouse 26.2's toFloat64 refuses a Variant. Float64 orders every number; the Int128 tiebreak keeps integers past 2^53 (one Float64) in exact order.
	unionNumberOrderKeys: (column) => [`CAST(${column} AS Nullable(Float64))`, `accurateCastOrNull(${column}, 'Int128')`],
}

/**
 * The dialect a compile writes SQL for, when it is not passed as `options.dialect`.
 *
 * Provide it to an Effect (`Effect.provideService(CurrentDialect, postgresDialect)`)
 * and every `compile` inside writes for that dialect. Each fiber has its own, so
 * compiles for two dialects can run at the same time. A compile also installs its
 * own dialect here for the queries nested in it. Absent, `compile` uses its
 * entry's dialect: ClickHouse from `/clickhouse`, Postgres from `/postgres`.
 */
export const CurrentDialect = Context.Reference<Dialect | undefined>("@maple-dev/effect-orm/CurrentDialect", {
	defaultValue: () => undefined,
})

// Beside the syntax installed for the fragment renderer, with the same
// save/restore discipline as `withSqlSyntax`.
const current = fiberLocal(CurrentDialect)

/** The dialect of the enclosing compile, or ClickHouse outside one. */
export const currentDialect = (): Dialect => current.get() ?? clickhouseDialect

/** The dialect of the enclosing compile, or `undefined` outside one. */
export const activeDialect = (): Dialect | undefined => current.get()

/** Run `body` with `dialect`'s syntax installed, literals checked as above. */
export function withDialect<A>(dialect: Dialect, body: () => A): A {
	// A nested compile for the dialect already installed keeps the checked
	// syntax that is there instead of wrapping it again.
	if (current.get() === dialect && activeSqlSyntax() !== undefined) return body()
	return current.with(dialect, () => withSqlSyntax(checkedSyntax(dialect), body))
}

/** `dialect.literal`, checked as above. For params written in after the
 *  callbacks have run, outside any installed syntax. */
export const checkedLiteral = (dialect: Dialect, value: unknown, context: string): string =>
	checked(dialect, dialect.literal(value, context), context)

const checkedSyntax = (dialect: Dialect): SqlSyntax => ({
	dialect: dialect.name,
	ilike: dialect.ilike,
	likeEscape: dialect.likeEscape,
	inexactNumberText: dialect.inexactNumberText,
	integerComparesFraction: dialect.integerComparesFraction,
	quoteIdent: dialect.quoteIdent,
	quoteString: (value) => checked(dialect, dialect.quoteString(value), "a string literal"),
	literal: (value, context) => checkedLiteral(dialect, value, context),
	dateTimeLiteral: (value) => checked(dialect, dialect.dateTimeLiteral(value), "a DateTime literal"),
})

const checked = (dialect: Dialect, sql: string, context: string): string => {
	if (sql.includes(PARAM_MARKER_PREFIX)) {
		return fail(new QueryBuilderError({
			code: "InvalidLiteral",
			message: `${context}: the ${dialect.name} dialect wrote a literal containing the reserved param marker \`${PARAM_MARKER_PREFIX}\``,
		}), "NULL")
	}
	return sql
}
