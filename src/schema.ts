// @maple-dev/effect-orm/schema
//
// Tables and materialized views that carry their DDL, snapshots of them, and
// the offline diff that turns two snapshots into migration ops. ClickHouse
// definitions are the top-level exports; Postgres ones live under `pg`
// (`S.pg.table`). Pure: nothing here reads files or opens a connection. See
// docs/migrations.md.

export * as pg from "./schema/pg-define"

export {
	column,
	defineTable,
	engine,
	index,
	materializedView,
	ttlAfterDays,
	SchemaDefinitionDefect,
	type ColumnInput,
	type ColumnOptions,
	type ColumnSpec,
	type ColumnsOf,
	type ComputedColumnsOf,
	type DefaultedColumnsOf,
	type DdlExpr,
	type DdlKey,
	type IndexSpec,
	type MaterializedView,
	type MisfitColumns,
	type SchemaTable,
	type TableDdl,
	type TableDefinition,
} from "./schema/define"
export {
	ClickHouseSnapshot,
	ColumnDefault,
	ColumnEntity,
	PgSnapshot,
	type AnySchemaEntity,
	type SchemaDialect,
	EngineSpec,
	IndexEntity,
	MaterializedViewEntity,
	ORIGIN_ID,
	SchemaEntity,
	Snapshot,
	SNAPSHOT_VERSION,
	TableEntity,
	canonicalJson,
	entityKey,
	sha256Hex,
	sortEntities,
} from "./schema/entities"
export {
	ident,
	renderAlter,
	renderColumnDefinition,
	renderCreateMaterializedView,
	renderCreateTable,
	renderDropTable,
	renderDropView,
	renderEngine,
	renderSchema,
	type RenderOptions,
} from "./schema/render"
export { ClickHouseMigrationFile, MigrationFile, MigrationOp, labelOf, renderOp, type OpLabel } from "./schema/ops"
export {
	dialectOfObject,
	entitiesOf,
	isSchemaObject,
	makeSnapshot,
	pgEntitiesOf,
	serializeSnapshot,
	type SchemaObject,
} from "./schema/snapshot"
export {
	PgColumnEntity,
	PgForeignKeyEntity,
	PgIdentity,
	PgIndexEntity,
	PgReferentialAction,
	PgSchemaEntity,
	PgTableEntity,
	canonicalPgType,
} from "./schema/pg-entities"
export {
	PgMigrationFile,
	PgMigrationOp,
	labelOfPg,
	pgIdent,
	renderPgOp,
	renderPgSchema,
	type PgOpLabel,
} from "./schema/pg-ops"
export { diffPgSchemas } from "./schema/pg-diff"
export { fromDrizzleSnapshot, type DrizzleImport } from "./schema/drizzle"
export { Hint, Hints, diffSchemas, type DiffResult, type UnsupportedChange } from "./schema/diff"
