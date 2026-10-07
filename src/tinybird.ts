// @maple-dev/effect-orm/tinybird
//
// Tinybird datasources and materialized views with the call shapes of
// `@tinybirdco/sdk`. A datasource is a ClickHouse schema table, so the query
// builder takes it as-is, and `buildProject` writes its datafiles. See
// docs/tinybird.md.

export {
	t,
	getTinybirdType,
	getModifiers,
	isTinybirdType,
	type TinybirdType,
	type AnyTinybirdType,
	type TypeModifiers,
	type RowOf,
} from "./tinybird/types"

export {
	column,
	defineDatasource,
	defineMaterializedView,
	engine,
	node,
	getColumnType,
	getColumnJsonPath,
	isDatasourceDefinition,
	isPipeDefinition,
	formatDefaultValue,
	type AnyDatasource,
	type ColumnDefinition,
	type ColumnsOfSchema,
	type Datasource,
	type DatasourceIndex,
	type DatasourceOptions,
	type DefaultedColumnsOfSchema,
	type EngineConfig,
	type InferRow,
	type MaterializedViewDefinition,
	type NodeDefinition,
	type SchemaDefinition,
} from "./tinybird/datasource"

export {
	buildProject,
	generateDatasource,
	generatePipe,
	type Datafile,
	type TinybirdProject,
} from "./tinybird/datafile"
