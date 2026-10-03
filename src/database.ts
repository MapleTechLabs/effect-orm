// @maple-dev/effect-orm/database
//
// Runs compiled statements through a `SqlClient` you provide, and wraps them in
// transactions: Effect's own `withTransaction` plus isolation settings, typed
// COMMIT and ROLLBACK failures, contention retry, and `Transaction` as a
// requirement for helpers that must be atomic. See docs/database.md.

export {
	Database,
	Transaction,
	execute,
	fromSqlClient,
	isContention,
	layerSqlClient,
	query,
	retryContention,
	run,
	transaction,
	type DatabaseApi,
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
export type { DialectTransactions, IsolationLevel, TransactionSettings } from "./ch/dialect"
