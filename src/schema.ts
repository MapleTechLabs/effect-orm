// @maple-dev/effect-orm/schema
//
// Tables and materialized views that carry their DDL, snapshots of them, and
// the offline diff that turns two snapshots into migration ops. Pure: nothing
// here reads files or opens a connection. See docs/migrations.md.

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
	ColumnDefault,
	ColumnEntity,
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
export { MigrationFile, MigrationOp, labelOf, renderOp, type OpLabel } from "./schema/ops"
export { entitiesOf, isSchemaObject, makeSnapshot, serializeSnapshot, type SchemaObject } from "./schema/snapshot"
export { Hint, Hints, diffSchemas, type DiffResult, type UnsupportedChange } from "./schema/diff"
