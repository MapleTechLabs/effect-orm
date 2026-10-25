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

/**
 * A query returned a number of rows its cardinality helper does not allow:
 * `runOne` wants exactly one, `runOption` at most one, `runNonEmpty` at least
 * one. `rows` is how many came back. It is an error, not a defect, because the
 * count depends on the data. The query ran as written, with no `LIMIT` added.
 */
export class ResultCardinalityError extends Schema.TaggedError<ResultCardinalityError>()(
	"@maple-dev/effect-orm/ResultCardinalityError",
	{
		message: Schema.String,
		expected: Schema.Literals(["one", "atMostOne", "nonEmpty"]),
		rows: Schema.Number,
	},
) {}

export type TransactionError =
	| TransactionUnsupported
	| TransactionOptionsRejected
	| TransactionCommitFailed
	| TransactionRollbackFailed
	| TransactionClosed
