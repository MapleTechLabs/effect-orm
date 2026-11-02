// Constraint violations as typed errors.
//
// A `DatabaseError` keeps the driver's classification and the server's code; a
// caller who wants "this email is taken" should not read either. These helpers
// read them once and give one tagged error per constraint kind, the same on
// every dialect that reports it.

import { Effect, Option } from "effect"
import { CheckViolation, DatabaseError, ForeignKeyViolation, NotNullViolation, TransactionCommitFailed, UniqueViolation, type ConstraintViolation } from "./errors"
import { serverFieldOf, sqliteConstraintOf, type SqliteConstraint } from "./sql-error"

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

interface Named {
	readonly constraint?: string | undefined
	readonly table?: string | undefined
	readonly column?: string | undefined
}

const namedByServer = (error: DatabaseError | TransactionCommitFailed): Named => {
	const named = error.errorCode === undefined ? {} : fromClickHouseMessage(error.message)
	return {
		constraint: serverFieldOf(error.cause, "constraint") ?? named.constraint,
		table: serverFieldOf(error.cause, "table") ?? named.table,
		column: serverFieldOf(error.cause, "column"),
	}
}

// SQLite names no unique index, only its columns: "UNIQUE constraint failed:
// t.a, t.b", "NOT NULL constraint failed: t.a", "CHECK constraint failed: name"
// (the expression when the CHECK has none), "FOREIGN KEY constraint failed".
// D1 appends ": SQLITE_CONSTRAINT (extended: ...)". Effect's SQLite
// `UniqueViolation` reason calls the column list its constraint, so this reads
// the message rather than the reason.
const fromSqliteMessage = (kind: SqliteConstraint, message: string): Named => {
	const detail = /constraint failed: (.*?)(?:: SQLITE_CONSTRAINT\b.*)?$/.exec(message)?.[1]?.trim()
	if (detail === undefined || detail.length === 0) return {}
	if (kind === "CHECK") return { constraint: detail }
	const columns = detail.split(", ").map((qualified) => /^(.+)\.([^.]+)$/.exec(qualified))
	const table = columns[0]?.[1]
	if (table === undefined || columns.some((column) => column?.[1] !== table)) return {}
	// A column only when the key has just one.
	return columns.length === 1 ? { table, column: columns[0]?.[2] } : { table }
}

const SQLITE_KINDS: Readonly<Record<SqliteConstraint, Kind>> = {
	UNIQUE: UniqueViolation,
	PRIMARYKEY: UniqueViolation,
	FOREIGNKEY: ForeignKeyViolation,
	NOTNULL: NotNullViolation,
	CHECK: CheckViolation,
}

/**
 * The constraint violation `error` reports, if it is a `DatabaseError` or
 * `TransactionCommitFailed` for one. Anything else is `None`.
 */
export const constraintViolation = (error: unknown): Option.Option<ConstraintViolation> => {
	if (!(error instanceof DatabaseError || error instanceof TransactionCommitFailed)) return Option.none()
	const sqlite = sqliteConstraintOf(error.cause)
	const Kind = sqlite === undefined ? kindOf(error) : SQLITE_KINDS[sqlite]
	if (Kind === undefined) return Option.none()
	const { constraint, table, column } = sqlite === undefined ? namedByServer(error) : fromSqliteMessage(sqlite, error.message)
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
