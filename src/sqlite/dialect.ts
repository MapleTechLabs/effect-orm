import { DateTime } from "effect"
import { noTransactions, type Dialect } from "../ch/dialect"
import { QueryBuilderError } from "../ch/errors"
import { fail } from "../ch/failure"
import { PARAM_MARKER_PREFIX } from "../ch/param"
import { PgTimestampLiteral, timestampLiteral } from "../pg/types"

const hex = (value: Uint8Array): string =>
	Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")

/** Hex text keeps NUL and the compiler's reserved param marker out of SQL text. */
const quoteString = (value: string): string =>
	value.includes(PARAM_MARKER_PREFIX) || value.includes("\0")
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
	quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
	quoteString,
	literal,
	dateTimeLiteral: (value) => quoteString(DateTime.formatIso(value)),
	params: { _tag: "bind", placeholder: () => "?", reuse: false, maxParameters: 32766 },
	clauses: {
		format: false,
		derivedTableAlias: true,
		groupByAlias: false,
		parenthesizeUnionBranches: false,
		wrapUnionBranches: true,
		offsetRequiresLimit: true,
		returning: true,
		onConflict: true,
	},
	paramCodecs: {
		dateTime: PgTimestampLiteral,
		dateTimeSeconds: timestampLiteral((millis) => new Date(Math.floor(millis / 1000) * 1000).toISOString()),
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
