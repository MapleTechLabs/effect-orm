import { Schema } from "effect"

/**
 * A statement failed: the server rejected it, or the connection failed while it ran.
 *
 * `reason` is the driver's classification (`SqlError.reason._tag`:
 * `UniqueViolation`, `SerializationError`, `DeadlockError`, ...) and `sqlState`
 * the server's error code when the driver reported one, so callers can branch
 * without digging through `cause`.
 */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("@maple-dev/effect-orm/DatabaseError", {
	message: Schema.String,
	sql: Schema.String,
	reason: Schema.String,
	sqlState: Schema.optional(Schema.String),
	cause: Schema.Defect(),
}) {}

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

export type TransactionError =
	| TransactionUnsupported
	| TransactionOptionsRejected
	| TransactionCommitFailed
	| TransactionRollbackFailed
	| TransactionClosed
