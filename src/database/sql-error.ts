// Reading a driver error: its message, its classification, its SQLSTATE.
//
// Drivers wrap the server's error in generic ones (`SqlError` around a reason
// around the client's own error), so each reader walks the chain.

import { isSqlError } from "effect/sql/SqlError"
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

/** The driver's classification: `SqlError.reason._tag`, or `Unknown`. */
export const reasonOf = (cause: unknown): string => (isSqlError(cause) ? cause.reason._tag : "Unknown")

export const toDatabaseError =
	(sql: string) =>
	(cause: unknown): DatabaseError => {
		const sqlState = sqlStateOf(cause)
		return new DatabaseError({
			message: firstLine(cause),
			sql,
			reason: reasonOf(cause),
			...(sqlState === undefined ? undefined : { sqlState }),
			cause,
		})
	}
