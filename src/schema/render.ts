// DDL rendering from entities.
//
// Deployment shape is a render option, never part of the schema: one snapshot
// renders for a single server, a replicated cluster (`Replicated*` engines,
// `ON CLUSTER`), or ClickHouse Cloud (plain MergeTree, which Cloud converts).

import type {
	ColumnEntity,
	EngineSpec,
	IndexEntity,
	MaterializedViewEntity,
	SchemaEntity,
	TableEntity,
} from "./entities"

export interface RenderOptions {
	/** Adds `ON CLUSTER <cluster>` to every statement. */
	readonly cluster?: string
	/**
	 * Render MergeTree-family engines as `Replicated*`. The Keeper path and
	 * replica name default to the macros most clusters define.
	 */
	readonly replicated?: { readonly path?: string; readonly replica?: string }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** An identifier, backquoted only when it is not a plain one. */
export const ident = (name: string): string => (IDENTIFIER.test(name) ? name : `\`${name.replace(/`/g, "``")}\``)

const quoteString = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

const onCluster = (options: RenderOptions): string =>
	options.cluster === undefined ? "" : ` ON CLUSTER ${ident(options.cluster)}`

export const renderEngine = (spec: EngineSpec, options: RenderOptions = {}): string => {
	if (options.replicated !== undefined && spec.family.endsWith("MergeTree")) {
		const path = options.replicated.path ?? "/clickhouse/tables/{shard}/{database}/{table}"
		const replica = options.replicated.replica ?? "{replica}"
		return `Replicated${spec.family}(${[quoteString(path), quoteString(replica), ...spec.params].join(", ")})`
	}
	return spec.params.length === 0 && !spec.family.endsWith("MergeTree")
		? spec.family
		: `${spec.family}(${spec.params.join(", ")})`
}

export const renderColumnDefinition = (column: ColumnEntity): string => {
	const parts = [ident(column.name), column.type]
	if (column.default !== null) parts.push(`${column.default.kind} ${column.default.expr}`)
	if (column.codec !== null) parts.push(`CODEC(${column.codec})`)
	if (column.comment !== null) parts.push(`COMMENT ${quoteString(column.comment)}`)
	return parts.join(" ")
}

export const renderIndexDefinition = (index: IndexEntity): string =>
	`INDEX ${ident(index.name)} ${index.expr} TYPE ${index.type} GRANULARITY ${index.granularity}`

export const renderSettings = (settings: Readonly<Record<string, string>>): string =>
	Object.entries(settings)
		.map(([key, value]) => `${key} = ${value}`)
		.join(", ")

export const renderCreateTable = (
	table: TableEntity,
	columns: ReadonlyArray<ColumnEntity>,
	indexes: ReadonlyArray<IndexEntity>,
	options: RenderOptions = {},
): string => {
	const body = [
		...[...columns].sort((a, b) => a.position - b.position).map(renderColumnDefinition),
		...indexes.map(renderIndexDefinition),
	]
	const clauses = [`ENGINE = ${renderEngine(table.engine, options)}`]
	if (table.partitionBy !== null) clauses.push(`PARTITION BY ${table.partitionBy}`)
	if (table.primaryKey !== null) clauses.push(`PRIMARY KEY ${table.primaryKey}`)
	if (table.orderBy !== null) clauses.push(`ORDER BY ${table.orderBy}`)
	if (table.ttl !== null) clauses.push(`TTL ${table.ttl}`)
	if (Object.keys(table.settings).length > 0) clauses.push(`SETTINGS ${renderSettings(table.settings)}`)
	if (table.comment !== null) clauses.push(`COMMENT ${quoteString(table.comment)}`)
	return `CREATE TABLE IF NOT EXISTS ${ident(table.name)}${onCluster(options)}\n(\n\t${body.join(",\n\t")}\n)\n${clauses.join("\n")}`
}

export const renderCreateMaterializedView = (view: MaterializedViewEntity, options: RenderOptions = {}): string =>
	`CREATE MATERIALIZED VIEW IF NOT EXISTS ${ident(view.name)}${onCluster(options)} TO ${ident(view.to)}\nAS ${view.select}`

/** `ALTER TABLE <table> [ON CLUSTER c] <action>`. */
export const renderAlter = (table: string, action: string, options: RenderOptions = {}): string =>
	`ALTER TABLE ${ident(table)}${onCluster(options)} ${action}`

export const renderDropTable = (name: string, options: RenderOptions = {}): string =>
	`DROP TABLE IF EXISTS ${ident(name)}${onCluster(options)} SYNC`

export const renderDropView = (name: string, options: RenderOptions = {}): string =>
	`DROP VIEW IF EXISTS ${ident(name)}${onCluster(options)} SYNC`

/**
 * Every CREATE statement for a schema: tables (with their columns and indexes)
 * first, then views, so a view's target always exists before the view.
 */
export const renderSchema = (entities: ReadonlyArray<SchemaEntity>, options: RenderOptions = {}): ReadonlyArray<string> => {
	const tables = entities.filter((e): e is TableEntity => e.kind === "table")
	const columns = entities.filter((e): e is ColumnEntity => e.kind === "column")
	const indexes = entities.filter((e): e is IndexEntity => e.kind === "index")
	const views = entities.filter((e): e is MaterializedViewEntity => e.kind === "materialized_view")
	return [
		...tables.map((table) =>
			renderCreateTable(
				table,
				columns.filter((c) => c.table === table.name),
				indexes.filter((i) => i.table === table.name),
				options,
			),
		),
		...views.map((view) => renderCreateMaterializedView(view, options)),
	]
}
