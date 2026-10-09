// The dialect-neutral query builder, shared by `/clickhouse` and `/postgres`.
//
// Not an entry point: each dialect entry re-exports this next to its own column
// types, functions, table definitions and `compile`, so one import covers
// everything for that database. Only what writes the same SQL shape on every
// dialect belongs here; a ClickHouse or Postgres function does not.

// Column type plumbing
export {
	type CHType,
	type ColumnDefs,
	type InferEncoded,
	type InferTS,
	type NullableColumnDefs,
	type OutputToColumnDefs,
} from "./ch/types"

// Tables, as the query builder sees them. Define one with the dialect's `table`.
export { type SelectRowOf, type Table } from "./ch/table"

// Core expression primitives
export {
	type Expr,
	type ColumnRef,
	type Condition,
	type Comparable,
	type MapValueOf,
	lit,
	rawExpr,
	untypedExpr,
	rawCond,
	when,
	whenTrue,
	inList,
	undecoded,
	inExprList,
	notInList,
	not,
	and,
	or,
	outerRef,
	dynamicColumn,
} from "./ch/expr"

export { sql, type SqlIdent, type SqlRaw, type SqlTag, type SqlTemplateValue } from "./ch/sql-template"

export {
	type Subquery,
	exists,
	inSubquery,
	notInSubquery,
	subqueryExpr,
	subqueryCond,
	untypedSubqueryExpr,
} from "./ch/subquery"

// Function factories, for functions of your own
export {
	arrayOfArg,
	compileFnCall,
	compileFnCallCond,
	compileTypedFnCall,
	defineCondFn,
	defineFn,
	defineUntypedFn,
	elementOf,
	elementSchema,
	firstTyped,
	firstTypedNonNull,
	type FnResult,
	makeCond,
	makeExpr,
	makeUntypedExpr,
	sameAs,
	schemaOf,
	schemaOfAny,
	withoutNull,
} from "./ch/define-fn"

// Params
export { param, paramPlaceholder, type ParamKind, type ParamMarker } from "./ch/param"

// Query builder
export {
	type CHQuery,
	type ColumnAccessor,
	type JoinedColumnAccessor,
	type JoinOnCallback,
	type InferOutput,
	type InferQueryOutput,
	type LockOptions,
	// What `compile` asks of a query, for a wrapper generic over its output.
	type NeedsSelect,
	from,
	fromQuery,
	fromUnion,
} from "./ch/query"
export { type ParamsSatisfied } from "./ch/expr"

export {
	type CHInsert,
	type CHInsertStart,
	type ConflictSet,
	type ConflictTarget,
	type InsertRow,
	type InsertRowOf,
	type InsertSelectMisfits,
	type InsertSelectMissing,
	type InsertSettingValue,
	type InsertValue,
	type OnConflictDoNothing,
	type OnConflictDoUpdate,
	insertInto,
} from "./ch/insert"

export {
	type CHDelete,
	type CHUpdate,
	type CHUpdateStart,
	type UpdateSet,
	type UpdateSetOf,
	deleteFrom,
	update,
} from "./ch/update"

export { unionAll, type CHUnionQuery, type InferUnionOutput } from "./ch/union"

// Compiled output. `compile` itself is per dialect.
export {
	rawCompiledQuery,
	type CompiledQuery,
	type CompiledQueryInput,
	type CompiledQueryRowSchema,
	type CHWrite,
	type InsertCompileOptions,
	type RowSchemaMismatch,
	type TenantScope,
	CompiledQueryDecodeError,
	CompiledQueryEncodeError,
} from "./ch/compile"

export {
	type Dialect,
	type DialectClauses,
	type DialectTransactions,
	type IsolationLevel,
	type ParamStyle,
	type TransactionSettings,
} from "./ch/dialect"

export { QueryBuilderError, QueryBuilderDefect } from "./ch/errors"
