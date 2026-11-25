// Reading a driver error: its message, its classification, its SQLSTATE.
//
// Drivers wrap the server's error in generic ones (`SqlError` around a reason
// around the client's own error), so each reader walks the chain.

import { isSqlError, isSqlErrorReason } from "effect/sql/SqlError"
import { DatabaseError } from "./errors"

const next = (current: object): unknown => ("reason" in current ? current.reason : "cause" in current ? current.cause : undefined)

/** The innermost message, first line only. */
export const firstLine = (cause: unknown): string => {
	let current: unknown = cause
	let message = String(cause)
	for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
		if ("message" in current && typeof current.message === "string" && current.message.length > 0) message = current.message
		const inner = next(current)
		if (inner === undefined || inner === current) break
		current = inner
	}
	return message.split("\n")[0]?.trim().slice(0, 500) ?? message
}

// A SQLSTATE is five characters with a digit among them (`23505`, `HY000`,
// `42S02`); Node's error names (`EPIPE`, `EBUSY`) are five letters.
const isSqlState = (value: unknown): value is string => typeof value === "string" && /^[0-9A-Z]{5}$/.test(value) && /[0-9]/.test(value)

/**
 * The server's five-character error code (`40001`, `23505`), when a driver in
 * the chain kept it. `@effect/sql-pg` classifies some codes into reasons;
 * `@effect/sql-pglite` does not, so the code is the reliable signal.
 */
export const sqlStateOf = (cause: unknown): string | undefined => {
	let current: unknown = cause
	for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
		if ("code" in current && isSqlState(current.code)) return current.code
		// mysql2 keeps the server's code as `sqlState`, its `code` being a name (`ER_DUP_ENTRY`).
		if ("sqlState" in current && isSqlState(current.sqlState)) return current.sqlState
		const inner = next(current)
		if (inner === undefined || inner === current) break
		current = inner
	}
	return undefined
}

/**
 * The server's numeric error code (ClickHouse `469`, MySQL `1062`), when a
 * driver in the chain kept it: a number, or a string of digits that is not a
 * five-character SQLSTATE. `@effect/sql-clickhouse` keeps it as the client's
 * string `code`, `ClickhouseHttpClient` as a number, mysql2 as `errno`.
 */
export const errorCodeOf = (cause: unknown): number | undefined => {
	let current: unknown = cause
	for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
		const errno = mysqlErrnoField(current)
		if (errno !== undefined) return errno
		if ("code" in current) {
			const code = current.code
			if (typeof code === "number" && Number.isInteger(code)) return code
			if (typeof code === "string" && /^[0-9]{1,4}$/.test(code)) return Number(code)
		}
		const inner = next(current)
		if (inner === undefined || inner === current) break
		current = inner
	}
	return undefined
}

// mysql2's server error: the server's `errno` beside its name as `code`
// (`ER_DUP_ENTRY`) and its text as `sqlMessage`. MySQL and MariaDB number their
// errors from 1000. Node's system errors (`ECONNREFUSED`, a negative `errno`)
// and other drivers' (bun:sqlite's extended codes) carry no `sqlMessage`.
const mysqlErrnoField = (current: object): number | undefined =>
	"errno" in current &&
	typeof current.errno === "number" &&
	Number.isInteger(current.errno) &&
	current.errno >= 1000 &&
	"code" in current &&
	typeof current.code === "string" &&
	"sqlMessage" in current &&
	typeof current.sqlMessage === "string"
		? current.errno
		: undefined

/**
 * The whole message of a mysql2 server error (`sqlMessage`). `DatabaseError`
 * keeps only the first line, and a value the message quotes can span lines.
 */
export const mysqlMessageOf = (cause: unknown): string | undefined => {
	let current: unknown = cause
	for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
		if (mysqlErrnoField(current) !== undefined) return (current as { readonly sqlMessage: string }).sqlMessage
		const inner = next(current)
		if (inner === undefined || inner === current) break
		current = inner
	}
	return undefined
}

/**
 * The MySQL or MariaDB server error number (`1062`, `1452`) of a mysql2 error
 * in the chain. Read on its own, not through `errorCode`, so a ClickHouse code
 * is never taken for a MySQL one.
 */
export const mysqlErrnoOf = (cause: unknown): number | undefined => {
	let current: unknown = cause
	for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
		const errno = mysqlErrnoField(current)
		if (errno !== undefined) return errno
		const inner = next(current)
		if (inner === undefined || inner === current) break
		current = inner
	}
	return undefined
}

/**
 * A string field the server put on its error (`constraint`, `table`,
 * `column` on a Postgres error), when a driver in the chain kept it. Effect's
 * `UniqueViolation` reason says `"unknown"` when it found no constraint name;
 * that is not a name, so the walk goes on.
 */
export const serverFieldOf = (cause: unknown, field: "constraint" | "table" | "column"): string | undefined => {
	let current: unknown = cause
	for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
		const value: unknown = (current as Record<string, unknown>)[field]
		if (typeof value === "string" && value.length > 0 && !(isSqlErrorReason(current) && value === "unknown")) return value
		const inner = next(current)
		if (inner === undefined || inner === current) break
		current = inner
	}
	return undefined
}

// SQLite's extended result codes for the constraint kinds a caller branches on.
const SQLITE_CONSTRAINT_CODES: Readonly<Record<number, SqliteConstraint>> = {
	275: "CHECK",
	787: "FOREIGNKEY",
	1299: "NOTNULL",
	1555: "PRIMARYKEY",
	2067: "UNIQUE",
}

/** The kind of a failed SQLite constraint, as its extended result code names it. */
export type SqliteConstraint = "UNIQUE" | "PRIMARYKEY" | "FOREIGNKEY" | "NOTNULL" | "CHECK"

/**
 * The SQLite constraint a driver error reports. `node:sqlite` (under
 * `@effect/sql-sqlite-node`) keeps the extended result code as `errcode`; D1
 * keeps only text, "... (extended: SQLITE_CONSTRAINT_UNIQUE)". Neither can be
 * read as a ClickHouse or Postgres code, so this is its own reader.
 */
export const sqliteConstraintOf = (cause: unknown): SqliteConstraint | undefined => {
	let current: unknown = cause
	for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
		if ("code" in current && current.code === "ERR_SQLITE_ERROR" && "errcode" in current && typeof current.errcode === "number") {
			return SQLITE_CONSTRAINT_CODES[current.errcode]
		}
		if ("message" in current && typeof current.message === "string") {
			const match = /\(extended: SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY|FOREIGNKEY|NOTNULL|CHECK)\)/.exec(current.message)
			if (match !== null) return match[1] as SqliteConstraint
		}
		const inner = next(current)
		if (inner === undefined || inner === current) break
		current = inner
	}
	return undefined
}

/** The driver's classification: `SqlError.reason._tag`, or `Unknown`. */
export const reasonOf = (cause: unknown): string => (isSqlError(cause) ? cause.reason._tag : "Unknown")

export const toDatabaseError =
	(sql: string) =>
	(cause: unknown): DatabaseError => {
		const sqlState = sqlStateOf(cause)
		const errorCode = errorCodeOf(cause)
		return new DatabaseError({
			message: firstLine(cause),
			sql,
			reason: reasonOf(cause),
			...(sqlState === undefined ? undefined : { sqlState }),
			...(errorCode === undefined ? undefined : { errorCode }),
			cause,
		})
	}
