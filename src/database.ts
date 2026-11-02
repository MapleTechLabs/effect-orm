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
	runNonEmpty,
	runOne,
	runOption,
	stream,
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
export { constraintViolation, refineConstraints } from "./database/constraint"
export {
	CheckViolation,
	DatabaseError,
	ResultCardinalityError,
	ForeignKeyViolation,
	NotNullViolation,
	UniqueViolation,
	InvalidCursor,
	TenantScopeViolation,
	TransactionClosed,
	TransactionCommitFailed,
	TransactionOptionsRejected,
	TransactionRollbackFailed,
	TransactionUnsupported,
	type ConstraintViolation,
	type TransactionError,
} from "./database/errors"
export {
	makeRepository,
	type Repository,
	type RepositoryError,
	type RepositoryOf,
	type RepositoryOptions,
	type TenantRepository,
} from "./database/repository"
export {
	paginate,
	type KeysetColumn,
	type KeysetDirection,
	type KeysetOrder,
	type Page,
	type PaginateOptions,
} from "./database/paginate"
export {
	defineRelations,
	findMany,
	related,
	type CountOf,
	type FindManyOptions,
	type FindManyRow,
	type KeyColumn,
	type Relation,
	type RelationalSchema,
	type RelationalTable,
	type RelationBuilder,
	type RelationFilter,
	type RelationOptions,
	type RelationsConfig,
	type RelationTables,
	type RelationWhere,
	type Related,
	type WithOf,
} from "./database/relations"
export { QuerySummary, withQuerySummary } from "./database/tracing"
export {
	TestDatabase,
	layerTest,
	type TestDatabaseApi,
	type TestDatabaseOptions,
	type TestReply,
	type TestStatement,
} from "./database/test-layer"
export {
	findAllBy,
	findById,
	type FindAllBy,
	type FindById,
	type LookupError,
	type LookupOptions,
} from "./database/resolver"
export { sql, type SqlIdentifier, type SqlRawText, type SqlTemplate } from "./database/sql"
export type { DialectTransactions, IsolationLevel, TransactionSettings } from "./ch/dialect"
