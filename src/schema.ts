// @maple-dev/effect-orm/schema
//
// The tooling under migrations: schema entities, snapshots, DDL rendering and
// the offline diff that turns two snapshots into migration ops. Tables are
// declared with `table` from `/clickhouse` or `/postgres`; this entry reads
// them. Pure: nothing here reads files or opens a connection. See
// docs/migrations.md.

export { type SchemaTable, type MaterializedView } from "./schema/define"
export { type PgSchemaTable } from "./schema/pg-define"
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
export {
	BackfillSpec,
	ClickHouseMigrationFile,
	MigrationFile,
	MigrationOp,
	backfillWindows,
	labelOf,
	renderBackfill,
	renderBackfillBounds,
	renderOp,
	type OpLabel,
} from "./schema/ops"
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
