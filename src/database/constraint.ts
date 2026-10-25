// Constraint violations as typed errors.
//
// A `DatabaseError` keeps the driver's classification and the server's code; a
// caller who wants "this email is taken" should not read either. These helpers
// read them once and give one tagged error per constraint kind, the same on
// every dialect that reports it.

import { Effect, Option } from "effect"
import { CheckViolation, DatabaseError, ForeignKeyViolation, NotNullViolation, TransactionCommitFailed, UniqueViolation, type ConstraintViolation } from "./errors"
import { serverFieldOf } from "./sql-error"

type Kind = typeof UniqueViolation | typeof ForeignKeyViolation | typeof NotNullViolation | typeof CheckViolation

const kindOf = (error: DatabaseError | TransactionCommitFailed): Kind | undefined => {
	if (error.sqlState === "23505" || error.reason === "UniqueViolation") return UniqueViolation
	if (error.sqlState === "23503") return ForeignKeyViolation
	if (error.sqlState === "23502") return NotNullViolation
	if (error.sqlState === "23514") return CheckViolation
	// ClickHouse VIOLATED_CONSTRAINT: its only constraints are CHECKs.
	if (error.sqlState === undefined && error.errorCode === 469) return CheckViolation
	return undefined
}

// ClickHouse names the constraint and table only in its message:
// "Constraint `positive` for table default.rents (uuid) is violated at row 1".
const fromClickHouseMessage = (message: string) => {
	const match = /Constraint `([^`]+)` for table ([^\s(]+)/.exec(message)
	return match === null ? {} : { constraint: match[1], table: match[2] }
}

/**
 * The constraint violation `error` reports, if it is a `DatabaseError` or
 * `TransactionCommitFailed` for one. Anything else is `None`.
 */
export const constraintViolation = (error: unknown): Option.Option<ConstraintViolation> => {
	if (!(error instanceof DatabaseError || error instanceof TransactionCommitFailed)) return Option.none()
	const Kind = kindOf(error)
	if (Kind === undefined) return Option.none()
	const named = error.errorCode === undefined ? {} : fromClickHouseMessage(error.message)
	const constraint = serverFieldOf(error.cause, "constraint") ?? named.constraint
	const table = serverFieldOf(error.cause, "table") ?? named.table
	const column = serverFieldOf(error.cause, "column")
	return Option.some(
		new Kind({
			message: error.message,
			...(error instanceof DatabaseError ? { sql: error.sql } : undefined),
			...(constraint === undefined ? undefined : { constraint }),
			...(table === undefined ? undefined : { table }),
			...(column === undefined ? undefined : { column }),
			...(error.sqlState === undefined ? undefined : { sqlState: error.sqlState }),
			...(error.errorCode === undefined ? undefined : { errorCode: error.errorCode }),
			cause: error,
		}),
	)
}

/**
 * Fail with a `ConstraintViolation` where `effect` fails with a
 * `DatabaseError` or `TransactionCommitFailed` for one, so a caller can
 * `catchTag` a duplicate key. Every other failure passes through unchanged.
 */
export const refineConstraints = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | ConstraintViolation, R> =>
	Effect.mapError(effect, (error): E | ConstraintViolation => Option.getOrElse(constraintViolation(error), () => error))
