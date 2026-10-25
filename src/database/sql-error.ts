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

/**
 * The server's five-character error code (`40001`, `23505`), when a driver in
 * the chain kept it. `@effect/sql-pg` classifies some codes into reasons;
 * `@effect/sql-pglite` does not, so the code is the reliable signal.
 */
export const sqlStateOf = (cause: unknown): string | undefined => {
	let current: unknown = cause
	for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
		if ("code" in current && typeof current.code === "string" && /^[0-9A-Z]{5}$/.test(current.code)) return current.code
		const inner = next(current)
		if (inner === undefined || inner === current) break
		current = inner
	}
	return undefined
}

/**
 * The server's numeric error code (ClickHouse `469`), when a driver in the
 * chain kept it: a number, or a string of digits that is not a five-character
 * SQLSTATE. `@effect/sql-clickhouse` keeps it as the client's string `code`,
 * `ClickhouseHttpClient` as a number.
 */
export const errorCodeOf = (cause: unknown): number | undefined => {
	let current: unknown = cause
	for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
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
