import { DateTime } from "effect"
import { noTransactions, type Dialect } from "../ch/dialect"
import { QueryBuilderError } from "../ch/errors"
import { fail } from "../ch/failure"
import { PARAM_MARKER_PREFIX } from "../ch/param"
import { SqliteTimestampLiteral, sqliteTimestampLiteral, sqliteTimestampText } from "./timestamp"

const hex = (value: Uint8Array): string =>
	Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * Hex text keeps the compiler's reserved param marker out of SQL text. U+0000
 * is refused: SQLite stores it, but its drivers end text there, so the value
 * would read back cut short.
 */
const quoteString = (value: string): string =>
	value.includes("\0")
		? fail(new QueryBuilderError({ code: "InvalidLiteral", message: "a string literal contains U+0000, which SQLite drivers end text at; the value would read back cut short" }), "''")
		: value.includes(PARAM_MARKER_PREFIX)
			? `CAST(X'${hex(new TextEncoder().encode(value))}' AS TEXT)`
			: `'${value.replace(/'/g, "''")}'`

const literal = (value: unknown, context: string): string => {
	if (value === null) return "NULL"
	if (typeof value === "string") return quoteString(value)
	if (typeof value === "boolean") return value ? "1" : "0"
	if (typeof value === "number" && Number.isFinite(value)) return String(value)
	if (value instanceof Uint8Array) return `X'${hex(value)}'`
	return fail(new QueryBuilderError({ code: "InvalidLiteral", message: `${context}: cannot write this value as a SQLite literal` }), "NULL")
}

/** SQLite with positional bindings and transactions supplied by the caller's SqlClient. */
export const sqliteDialect: Dialect = {
	name: "sqlite",
	functions: "sqlite",
	ilike: false,
	likeEscape: true,
	inexactNumberText: true,
	integerComparesFraction: true,
	quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
	quoteString,
	literal,
	dateTimeLiteral: (value) => {
		try {
			return quoteString(sqliteTimestampText(DateTime.toEpochMillis(value)))
		} catch (error) {
			return fail(new QueryBuilderError({ code: "InvalidLiteral", message: (error as Error).message }), "NULL")
		}
	},
	params: { _tag: "bind", placeholder: () => "?", reuse: false, maxParameters: 32766, nulInText: false },
	clauses: {
		format: false,
		derivedTableAlias: true,
		groupByAlias: false,
		parenthesizeUnionBranches: false,
		wrapUnionBranches: true,
		offsetRequiresLimit: true,
		returning: true,
		onConflict: true,
		onConflictConstraint: false,
		insertSelectNeedsWhere: true,
		defaultInValues: false,
		distinctOn: false,
	},
	paramCodecs: {
		dateTime: SqliteTimestampLiteral,
		dateTimeSeconds: sqliteTimestampLiteral((millis) => Math.floor(millis / 1000) * 1000),
	},
	transactions: {
		support: "full",
		savepoints: true,
		isolationLevels: ["serializable"],
		accessModes: false,
		deferrable: false,
		setTransaction: () => undefined,
	},
}

/** D1 executes SQLite SQL, limits each statement to 100 bindings, and has no interactive transactions. */
export const d1Dialect: Dialect = {
	...sqliteDialect,
	name: "d1",
	params: { ...sqliteDialect.params, _tag: "bind", placeholder: () => "?", reuse: false, maxParameters: 100 },
	transactions: noTransactions,
}
