import { DateTime } from "effect"
import type { Dialect, DialectTransactions, IsolationLevel, TransactionSettings } from "../ch/dialect"
import { QueryBuilderError } from "../ch/errors"
import { fail } from "../ch/failure"
import { PARAM_MARKER_PREFIX } from "../ch/param"
import { MysqlDateTimeLiteral, mysqlDateTimeText } from "./datetime"

const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")

// MySQL reads `\` as an escape in a string literal unless the server runs with
// NO_BACKSLASH_ESCAPES, which this dialect does not support (docs/mysql.md).
const ESCAPES: Record<string, string> = { "\\": "\\\\", "'": "\\'", "\0": "\\0", "\n": "\\n", "\r": "\\r", "\x1a": "\\Z" }

/**
 * A quoted string. Adjacent literals concatenate (`'__PA' 'RAM_'`), which
 * keeps the compiler's reserved param marker out of the SQL text.
 */
const quoteString = (value: string): string =>
	value
		.split(PARAM_MARKER_PREFIX)
		.map((part) => `'${part.replace(/[\\'\0\n\r\x1a]/g, (char) => ESCAPES[char]!)}'`)
		.join(` '${PARAM_MARKER_PREFIX.slice(0, 4)}' '${PARAM_MARKER_PREFIX.slice(4)}' `)

/**
 * A finite number as a literal. MySQL reads `1.5` as an exact DECIMAL and
 * `1.5e0` as a DOUBLE; a JS number is a double, so a fraction is written in
 * exponent form and compares as the double it is.
 */
const numberLiteral = (value: number): string => {
	const text = String(value)
	return Number.isInteger(value) || /e/i.test(text) ? text : `${text}e0`
}

const literal = (value: unknown, context: string): string => {
	if (value === null) return "NULL"
	if (typeof value === "string") return quoteString(value)
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
	if (typeof value === "number" && Number.isFinite(value)) return numberLiteral(value)
	if (value instanceof Uint8Array) return `X'${hex(value)}'`
	return fail(new QueryBuilderError({ code: "InvalidLiteral", message: `${context}: cannot write this value as a MySQL literal` }), "NULL")
}

/** MySQL's CAST targets are not its column types: `CAST(? AS text)` is a syntax error. */
const castType = (json: string | undefined) => (sqlType: string): string | undefined => {
	if (/^(text|longtext|varchar\(\d+\))$/.test(sqlType)) return "CHAR"
	if (/^(tinyint|smallint|int|bigint|boolean)$/.test(sqlType)) return "SIGNED"
	if (sqlType === "int unsigned") return "UNSIGNED"
	if (sqlType === "double") return "DOUBLE"
	if (sqlType === "datetime(3)") return "DATETIME(3)"
	if (sqlType === "date") return "DATE"
	if (/^decimal\(\d+,\d+\)$/.test(sqlType)) return sqlType.toUpperCase()
	if (/^(blob|varbinary\(\d+\))$/.test(sqlType)) return "BINARY"
	if (sqlType === "json") return json
	return undefined
}

const isolation: Record<IsolationLevel, string> = {
	"read committed": "READ COMMITTED",
	"repeatable read": "REPEATABLE READ",
	serializable: "SERIALIZABLE",
}

/**
 * MySQL's SET TRANSACTION applies to the next transaction and is refused inside
 * one, so the settings go before START TRANSACTION, in the statement that
 * begins it (the driver's unprepared path runs both).
 */
const begin = (settings: TransactionSettings): string | undefined => {
	if (settings.isolationLevel === undefined && settings.accessMode === undefined) return undefined
	const mode = settings.accessMode === undefined ? "" : ` ${settings.accessMode.toUpperCase()}`
	return settings.isolationLevel === undefined
		? `START TRANSACTION${mode}`
		: `SET TRANSACTION ISOLATION LEVEL ${isolation[settings.isolationLevel]}; START TRANSACTION${mode}`
}

const transactions: DialectTransactions = {
	support: "full",
	savepoints: true,
	isolationLevels: ["read committed", "repeatable read", "serializable"],
	accessModes: true,
	deferrable: false,
	setTransaction: () => undefined,
	beginTransaction: begin,
}

/**
 * MySQL 8.0+ with positional `?` bindings. Text compares by the column's (or
 * the connection's) collation: under MySQL's default `utf8mb4_0900_ai_ci`,
 * `=` and LIKE ignore case and accents. See docs/mysql.md.
 */
export const mysqlDialect: Dialect<"mysql"> = {
	name: "mysql",
	functions: "mysql",
	ilike: false,
	likeEscape: false,
	likeIgnoresCase: false,
	likeFollowsCollation: true,
	integerComparesFraction: true,
	concat: (parts) => `CONCAT(${parts.join(", ")})`,
	quoteIdent: (name) => `\`${name.replace(/`/g, "``")}\``,
	quoteString,
	literal,
	dateTimeLiteral: (value) => {
		try {
			return `CAST(${quoteString(mysqlDateTimeText(DateTime.toEpochMillis(value)))} AS DATETIME(3))`
		} catch (error) {
			return fail(new QueryBuilderError({ code: "InvalidLiteral", message: (error as Error).message }), "NULL")
		}
	},
	params: { _tag: "bind", placeholder: () => "?", reuse: false, maxParameters: 65535 },
	clauses: {
		format: false,
		derivedTableAlias: true,
		// GROUP BY looks a name up in FROM before the select list.
		groupByAlias: false,
		parenthesizeUnionBranches: true,
		limitForOffset: "18446744073709551615",
		// A merged derived table's `ORDER BY e1` reads `10 AS e1` as position 10.
		integerSelectIsPosition: true,
		returning: false,
		onConflict: false,
		defaultInValues: true,
		distinctOn: false,
		locking: { strengths: ["UPDATE", "SHARE"], of: true },
	},
	paramCodecs: {
		dateTime: MysqlDateTimeLiteral,
	},
	transactions,
	castType: castType("JSON"),
}

/** MariaDB 10.6+: MySQL's SQL, with `LOCK IN SHARE MODE` for a shared lock, no `OF`, and union branches as derived tables. */
export const mariadbDialect: Dialect<"mysql"> = {
	...mysqlDialect,
	name: "mariadb",
	// JSON is LONGTEXT in MariaDB, with no JSON cast.
	castType: castType("CHAR"),
	clauses: {
		...mysqlDialect.clauses,
		locking: { strengths: ["UPDATE", "SHARE"], of: false, shareMode: true },
		// A parenthesized branch cannot start with WITH; a derived table can.
		parenthesizeUnionBranches: false,
		wrapUnionBranches: true,
	},
}
