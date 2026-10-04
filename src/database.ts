// @maple-dev/effect-orm/database
//
// Runs compiled statements through a `SqlClient` you provide, and wraps them in
// transactions: Effect's own `withTransaction` plus isolation settings, typed
// COMMIT and ROLLBACK failures, contention retry, and `requireTransaction` for
// helpers that must be atomic. See docs/database.md.

export {
	Database,
	Transaction,
	execute,
	fromSqlClient,
	isContention,
	layerSqlClient,
	query,
	requireTransaction,
	retryContention,
	run,
	transaction,
	type DatabaseApi,
	type RowOf,
	type RowSchema,
	type Runnable,
	type StatementInput,
	type FromSqlClientOptions,
	type RetryOptions,
	type Statement,
	type TransactionInfo,
	type TransactionOptions,
} from "./database/database"
export {
	DatabaseError,
	TransactionClosed,
	TransactionCommitFailed,
	TransactionOptionsRejected,
	TransactionRollbackFailed,
	TransactionUnsupported,
	type TransactionError,
} from "./database/errors"
export { sql, type SqlIdentifier, type SqlRawText, type SqlTemplate } from "./database/sql"
export type { DialectTransactions, IsolationLevel, TransactionSettings } from "./ch/dialect"
