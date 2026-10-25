import { Schema } from "effect"

/**
 * A statement failed: the server rejected it, or the connection failed while it ran.
 *
 * `reason` is the driver's classification (`SqlError.reason._tag`:
 * `UniqueViolation`, `SerializationError`, `DeadlockError`, ...), `sqlState`
 * the server's five-character code (Postgres) and `errorCode` its numeric code
 * (ClickHouse), when the driver reported one, so callers can branch without
 * digging through `cause`. `refineConstraints` turns a constraint failure into
 * a `ConstraintViolation`.
 */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("@maple-dev/effect-orm/DatabaseError", {
	message: Schema.String,
	sql: Schema.String,
	reason: Schema.String,
	sqlState: Schema.optional(Schema.String),
	errorCode: Schema.optional(Schema.Number),
	cause: Schema.Defect(),
}) {}

// What every constraint violation carries. `constraint`, `table` and `column`
// are present when the server named them: Postgres names the constraint and
// table, and the column for NOT NULL; ClickHouse names the CHECK constraint.
// `cause` is the `DatabaseError` or `TransactionCommitFailed` it came from.
const ViolationFields = {
	message: Schema.String,
	sql: Schema.optional(Schema.String),
	constraint: Schema.optional(Schema.String),
	table: Schema.optional(Schema.String),
	column: Schema.optional(Schema.String),
	sqlState: Schema.optional(Schema.String),
	errorCode: Schema.optional(Schema.Number),
	cause: Schema.Defect(),
}

/** A row would duplicate a unique key or primary key. Postgres SQLSTATE 23505. */
export class UniqueViolation extends Schema.TaggedError<UniqueViolation>()(
	"@maple-dev/effect-orm/UniqueViolation",
	ViolationFields,
) {}

/** A row references a missing row, or a delete leaves rows that reference it. Postgres SQLSTATE 23503. */
export class ForeignKeyViolation extends Schema.TaggedError<ForeignKeyViolation>()(
	"@maple-dev/effect-orm/ForeignKeyViolation",
	ViolationFields,
) {}

/** A NOT NULL column got NULL. Postgres SQLSTATE 23502. */
export class NotNullViolation extends Schema.TaggedError<NotNullViolation>()(
	"@maple-dev/effect-orm/NotNullViolation",
	ViolationFields,
) {}

/** A row fails a CHECK constraint. Postgres SQLSTATE 23514, ClickHouse code 469 (`VIOLATED_CONSTRAINT`). */
export class CheckViolation extends Schema.TaggedError<CheckViolation>()(
	"@maple-dev/effect-orm/CheckViolation",
	ViolationFields,
) {}

/** The constraint violations `refineConstraints` lifts out of `DatabaseError` and `TransactionCommitFailed`. */
export type ConstraintViolation = UniqueViolation | ForeignKeyViolation | NotNullViolation | CheckViolation

/** The database's dialect has no transactions (ClickHouse), or none at this nesting depth. */
export class TransactionUnsupported extends Schema.TaggedError<TransactionUnsupported>()(
	"@maple-dev/effect-orm/TransactionUnsupported",
	{ dialect: Schema.String, message: Schema.String },
) {}

/**
 * Transaction options the dialect does not support, or options on a nested
 * transaction, which cannot change what the outer one already started with.
 */
export class TransactionOptionsRejected extends Schema.TaggedError<TransactionOptionsRejected>()(
	"@maple-dev/effect-orm/TransactionOptionsRejected",
	{ message: Schema.String },
) {}

/**
 * COMMIT failed (a deferred constraint, a serialization failure found at
 * commit, a dropped connection), or releasing a nested savepoint did. Nothing
 * the transaction wrote is kept.
 */
export class TransactionCommitFailed extends Schema.TaggedError<TransactionCommitFailed>()(
	"@maple-dev/effect-orm/TransactionCommitFailed",
	{
		message: Schema.String,
		reason: Schema.String,
		sqlState: Schema.optional(Schema.String),
		errorCode: Schema.optional(Schema.Number),
		cause: Schema.Defect(),
	},
) {}

/**
 * ROLLBACK failed after the body failed. `bodyCause` is why the body failed;
 * `cause` is the rollback's own error. The connection is not reused.
 */
export class TransactionRollbackFailed extends Schema.TaggedError<TransactionRollbackFailed>()(
	"@maple-dev/effect-orm/TransactionRollbackFailed",
	{ message: Schema.String, bodyCause: Schema.Defect(), cause: Schema.Defect() },
) {}

/**
 * A statement ran with the context of a transaction that had already ended,
 * most often from a fiber forked inside the transaction and never joined.
 * Running it would use a connection that has gone back to the pool.
 */
export class TransactionClosed extends Schema.TaggedError<TransactionClosed>()("@maple-dev/effect-orm/TransactionClosed", {
	message: Schema.String,
	sql: Schema.String,
}) {}

/**
 * A database with `requireTenantScope` was handed a compiled statement that
 * reads or writes across tenants without saying so: a forgotten tenant
 * filter, or a `rawCompiledQuery` that asserted no scope. It is a defect, as
 * the bug is in the query, not in the data. See docs/tenant-scoping.md.
 */
export class TenantScopeViolation extends Schema.TaggedError<TenantScopeViolation>()(
	"@maple-dev/effect-orm/TenantScopeViolation",
	{ message: Schema.String, sql: Schema.String },
) {}

export type TransactionError =
	| TransactionUnsupported
	| TransactionOptionsRejected
	| TransactionCommitFailed
	| TransactionRollbackFailed
	| TransactionClosed
