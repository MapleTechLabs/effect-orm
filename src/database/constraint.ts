// Constraint violations as typed errors.
//
// A `DatabaseError` keeps the driver's classification and the server's code; a
// caller who wants "this email is taken" should not read either. These helpers
// read them once and give one tagged error per constraint kind, the same on
// every dialect that reports it.

import { Effect, Option } from "effect"
import { CheckViolation, DatabaseError, ForeignKeyViolation, NotNullViolation, TransactionCommitFailed, UniqueViolation, type ConstraintViolation } from "./errors"
import { mysqlErrnoOf, mysqlMessageOf, serverFieldOf, sqliteConstraintOf, type SqliteConstraint } from "./sql-error"

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

// MySQL and MariaDB error numbers for the constraint kinds a caller branches on.
// Their SQLSTATE is 23000 for every integrity failure (HY000 for a CHECK), so the
// number is what tells them apart.
const MYSQL_KINDS: Readonly<Record<number, Kind>> = {
	1022: UniqueViolation, // ER_DUP_KEY
	1062: UniqueViolation, // ER_DUP_ENTRY
	1169: UniqueViolation, // ER_DUP_UNIQUE
	1557: UniqueViolation, // ER_FOREIGN_DUPLICATE_KEY: a cascade would duplicate a key
	1586: UniqueViolation, // ER_DUP_ENTRY_WITH_KEY_NAME
	1761: UniqueViolation, // ER_FOREIGN_DUPLICATE_KEY_WITH_CHILD_INFO
	1762: UniqueViolation, // ER_FOREIGN_DUPLICATE_KEY_WITHOUT_CHILD_INFO
	1216: ForeignKeyViolation, // ER_NO_REFERENCED_ROW
	1217: ForeignKeyViolation, // ER_ROW_IS_REFERENCED
	1451: ForeignKeyViolation, // ER_ROW_IS_REFERENCED_2
	1452: ForeignKeyViolation, // ER_NO_REFERENCED_ROW_2
	1048: NotNullViolation, // ER_BAD_NULL_ERROR
	1364: NotNullViolation, // ER_NO_DEFAULT_FOR_FIELD: a NOT NULL column with no default left out
	3819: CheckViolation, // ER_CHECK_CONSTRAINT_VIOLATED (MySQL)
	4025: CheckViolation, // ER_CONSTRAINT_FAILED (MariaDB)
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

// MySQL and MariaDB name things only in the message, which can quote the
// offending value. That value is user input, so each pattern is anchored where
// the server writes its names: the duplicate key's at the end, after the value.
//   Duplicate entry 'a@x' for key 'users.users_email_key'   (MariaDB: for key 'users_email_key')
//   Cannot add or update a child row: a foreign key constraint fails (`db`.`units`, CONSTRAINT `units_org_fk` FOREIGN KEY ...)
//   Column 'starts_at' cannot be null / Field 'starts_at' doesn't have a default value
//   Check constraint 'seats_positive' is violated.          (MariaDB: CONSTRAINT `seats_positive` failed for `db`.`tours`)
const fromMysqlMessage = (Kind: Kind, message: string): Named => {
	if (Kind === UniqueViolation) {
		const key = / for key '([^']+)'$/.exec(message)?.[1]
		if (key === undefined) return {}
		const dot = key.lastIndexOf(".")
		return dot === -1 ? { constraint: key } : { table: key.slice(0, dot), constraint: key.slice(dot + 1) }
	}
	if (Kind === ForeignKeyViolation) {
		const match = /^Cannot (?:add|delete) or update a (?:child|parent) row: a foreign key constraint fails \(`[^`]+`\.`([^`]+)`, CONSTRAINT `([^`]+)`/.exec(message)
		return match === null ? {} : { table: match[1], constraint: match[2] }
	}
	if (Kind === NotNullViolation) {
		const column = /^(?:Column|Field) '([^']+)'/.exec(message)?.[1]
		return column === undefined ? {} : { column }
	}
	const mysql = /^Check constraint '([^']+)' is violated\.?$/.exec(message)
	if (mysql !== null) return { constraint: mysql[1] }
	const mariadb = /^CONSTRAINT `([^`]+)` failed for `[^`]+`\.`([^`]+)`$/.exec(message)
	return mariadb === null ? {} : { constraint: mariadb[1], table: mariadb[2] }
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
	const errno = sqlite === undefined ? mysqlErrnoOf(error.cause) : undefined
	const mysqlKind = errno === undefined ? undefined : MYSQL_KINDS[errno]
	const Kind = sqlite !== undefined ? SQLITE_KINDS[sqlite] : (mysqlKind ?? (errno === undefined ? kindOf(error) : undefined))
	if (Kind === undefined) return Option.none()
	const { constraint, table, column } =
		sqlite !== undefined
			? fromSqliteMessage(sqlite, error.message)
			: mysqlKind !== undefined
				? fromMysqlMessage(mysqlKind, mysqlMessageOf(error.cause) ?? error.message)
				: namedByServer(error)
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
