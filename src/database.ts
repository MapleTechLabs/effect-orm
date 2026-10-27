// @maple-dev/effect-orm/database
//
// Runs compiled statements through a `SqlClient` you provide, and wraps them in
// transactions: Effect's own `withTransaction` plus isolation settings, typed
// COMMIT and ROLLBACK failures, contention retry, and `requireTransaction` for
// helpers that must be atomic. See docs/database.md. `layerTest` is a
// `Database` with no server, for unit tests; see docs/testing.md.

export {
	Database,
	Transaction,
	afterCommit,
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
	TenantScopeViolation,
	TransactionClosed,
	TransactionCommitFailed,
	TransactionOptionsRejected,
	TransactionRollbackFailed,
	TransactionUnsupported,
	type TransactionError,
} from "./database/errors"
export { QuerySummary, withQuerySummary } from "./database/tracing"
export {
	TestDatabase,
	layerTest,
	type TestDatabaseApi,
	type TestDatabaseOptions,
	type TestReply,
	type TestStatement,
} from "./database/test-layer"
export { sql, type SqlIdentifier, type SqlRawText, type SqlTemplate } from "./database/sql"
export type { DialectTransactions, IsolationLevel, TransactionSettings } from "./ch/dialect"
