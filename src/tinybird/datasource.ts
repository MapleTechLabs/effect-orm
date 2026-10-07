// Tinybird datasources and materialized views, with the call shapes of
// `@tinybirdco/sdk`. A datasource IS a ClickHouse schema table, so queries
// take it directly and its DDL renders for a plain ClickHouse server too.

import * as Define from "../schema/define"
import { SchemaDefinitionDefect, type MaterializedView, type SchemaTable } from "../schema/define"
import type { ColumnDefs } from "../ch/types"
import type { EngineSpec } from "../schema/entities"
import { getTinybirdType, isTinybirdType, type AnyTinybirdType, type RowOf, type TinybirdType } from "./types"

// Columns

export interface ColumnDefinition<X extends AnyTinybirdType = AnyTinybirdType> {
	readonly type: X
	readonly jsonPath?: string
}

export type SchemaDefinition = Record<string, AnyTinybirdType | ColumnDefinition>

export const column = <X extends AnyTinybirdType>(
	type: X,
	options: { readonly jsonPath?: string } = {},
): ColumnDefinition<X> => ({ type, ...options })

type TypeOfColumn<I> = I extends ColumnDefinition<infer X> ? X : I

export const getColumnType = (input: AnyTinybirdType | ColumnDefinition): AnyTinybirdType =>
	isTinybirdType(input) ? input : input.type

export const getColumnJsonPath = (input: AnyTinybirdType | ColumnDefinition): string | undefined =>
	isTinybirdType(input) ? input.modifiers.jsonPath : (input.jsonPath ?? input.type.modifiers.jsonPath)

/** The query columns of a datasource schema. */
export type ColumnsOfSchema<S extends SchemaDefinition> = {
	readonly [K in keyof S]: TypeOfColumn<S[K]> extends TinybirdType<infer C, any, any> ? C : never
}

/** Columns with a `DEFAULT`: an insert may leave them out. */
export type DefaultedColumnsOfSchema<S extends SchemaDefinition> = {
	[K in keyof S]: TypeOfColumn<S[K]> extends TinybirdType<any, any, true> ? K : never
}[keyof S] &
	string

// Engines

interface BaseMergeTreeConfig {
	readonly sortingKey: string | ReadonlyArray<string>
	readonly partitionKey?: string
	readonly primaryKey?: string | ReadonlyArray<string>
	readonly ttl?: string
	readonly settings?: Readonly<Record<string, string | number | boolean>>
}

export type EngineConfig =
	| (BaseMergeTreeConfig & { readonly type: "MergeTree" })
	| (BaseMergeTreeConfig & { readonly type: "ReplacingMergeTree"; readonly ver?: string; readonly isDeleted?: string })
	| (BaseMergeTreeConfig & { readonly type: "SummingMergeTree"; readonly columns?: ReadonlyArray<string> })
	| (BaseMergeTreeConfig & { readonly type: "AggregatingMergeTree" })
	| (BaseMergeTreeConfig & { readonly type: "CollapsingMergeTree"; readonly sign: string })
	| (BaseMergeTreeConfig & {
			readonly type: "VersionedCollapsingMergeTree"
			readonly sign: string
			readonly version: string
	  })
	| { readonly type: "Null" }

type ConfigOf<Type extends EngineConfig["type"]> = Omit<Extract<EngineConfig, { readonly type: Type }>, "type">

export const engine = {
	mergeTree: (config: ConfigOf<"MergeTree">): EngineConfig => ({ type: "MergeTree", ...config }),
	replacingMergeTree: (config: ConfigOf<"ReplacingMergeTree">): EngineConfig => ({
		type: "ReplacingMergeTree",
		...config,
	}),
	summingMergeTree: (config: ConfigOf<"SummingMergeTree">): EngineConfig => ({ type: "SummingMergeTree", ...config }),
	aggregatingMergeTree: (config: ConfigOf<"AggregatingMergeTree">): EngineConfig => ({
		type: "AggregatingMergeTree",
		...config,
	}),
	collapsingMergeTree: (config: ConfigOf<"CollapsingMergeTree">): EngineConfig => ({
		type: "CollapsingMergeTree",
		...config,
	}),
	versionedCollapsingMergeTree: (config: ConfigOf<"VersionedCollapsingMergeTree">): EngineConfig => ({
		type: "VersionedCollapsingMergeTree",
		...config,
	}),
	null: (): EngineConfig => ({ type: "Null" }),
} as const

/** Split `"a, f(b, c)"` into `["a", "f(b, c)"]` at top-level commas. */
export const splitKey = (key: string | ReadonlyArray<string>): ReadonlyArray<string> => {
	if (typeof key !== "string") return key
	const parts: Array<string> = []
	let depth = 0
	let quoted = false
	let start = 0
	for (let i = 0; i < key.length; i++) {
		const ch = key[i]
		if (ch === "'" && key[i - 1] !== "\\") quoted = !quoted
		else if (!quoted && ch === "(") depth++
		else if (!quoted && ch === ")") depth--
		else if (!quoted && depth === 0 && ch === ",") {
			parts.push(key.slice(start, i).trim())
			start = i + 1
		}
	}
	parts.push(key.slice(start).trim())
	return parts.filter((part) => part.length > 0)
}

const engineSpec = (config: EngineConfig): EngineSpec => {
	switch (config.type) {
		case "MergeTree":
			return Define.engine.mergeTree()
		case "ReplacingMergeTree":
			return Define.engine.replacingMergeTree({
				...(config.ver !== undefined ? { version: config.ver } : {}),
				...(config.isDeleted !== undefined ? { isDeleted: config.isDeleted } : {}),
			})
		case "SummingMergeTree":
			return Define.engine.summingMergeTree(config.columns !== undefined ? { columns: config.columns } : {})
		case "AggregatingMergeTree":
			return Define.engine.aggregatingMergeTree()
		case "CollapsingMergeTree":
			return Define.engine.collapsingMergeTree(config.sign)
		case "VersionedCollapsingMergeTree":
			return Define.engine.versionedCollapsingMergeTree(config.sign, config.version)
		case "Null":
			return Define.engine.null()
	}
}

const settingValue = (value: string | number | boolean): string | number =>
	typeof value === "string" ? `'${value.replace(/'/g, "\\'")}'` : typeof value === "boolean" ? (value ? 1 : 0) : value

// Datasources

export interface DatasourceIndex {
	readonly name: string
	readonly expr: string
	readonly type: string
	readonly granularity: number
}

export interface DatasourceOptions<S extends SchemaDefinition> {
	readonly description?: string
	readonly schema: S
	/** Defaults to a `MergeTree` ordered by `tuple()`. */
	readonly engine?: EngineConfig
	/** `false` leaves the `json:$` paths out, for a datasource only views write to. */
	readonly jsonPaths?: boolean
	readonly forwardQuery?: string
	readonly indexes?: ReadonlyArray<DatasourceIndex>
	/** The column carrying row-level tenancy; see docs/tenant-scoping.md. */
	readonly tenantColumn?: keyof S & string
}

export const DatasourceTypeId: unique symbol = Symbol.for("@maple-dev/effect-orm/tinybird/Datasource")
export type DatasourceTypeId = typeof DatasourceTypeId

export interface Datasource<Name extends string = string, S extends SchemaDefinition = SchemaDefinition>
	extends SchemaTable<Name, ColumnsOfSchema<S>, DefaultedColumnsOfSchema<S>, never> {
	readonly [DatasourceTypeId]: DatasourceTypeId
	readonly _name: Name
	readonly _schema: S
	readonly options: StoredOptions<S>
}

type StoredOptions<S extends SchemaDefinition> = Omit<DatasourceOptions<S>, "tenantColumn"> & {
	readonly tenantColumn?: string
}

/** Any datasource, whatever its schema: what generators and views take. */
export interface AnyDatasource extends SchemaTable<string, ColumnDefs> {
	readonly [DatasourceTypeId]: DatasourceTypeId
	readonly _name: string
	readonly _schema: SchemaDefinition
	readonly options: StoredOptions<SchemaDefinition>
}

/** A JSON row as Tinybird ingests it into the datasource. */
export type InferRow<D> = D extends Datasource<any, infer S> ? { [K in keyof S]: RowOf<TypeOfColumn<S[K]>> } : never

export const isDatasourceDefinition = (value: unknown): value is AnyDatasource =>
	typeof value === "object" && value !== null && DatasourceTypeId in value

/** A literal `DEFAULT`, written the way Tinybird datafiles write it. */
export const formatDefaultValue = (value: unknown, type: string): string => {
	if (value === null) return "NULL"
	if (typeof value === "string") return `'${value.replace(/'/g, "\\'")}'`
	if (typeof value === "number" || typeof value === "bigint") return String(value)
	if (typeof value === "boolean") return value ? "1" : "0"
	if (value instanceof Date) {
		return type.startsWith("Date") && !type.includes("Time")
			? `'${value.toISOString().split("T")[0]}'`
			: `'${value.toISOString().replace("T", " ").slice(0, 19)}'`
	}
	if (typeof value === "object") return JSON.stringify(value)
	return `'${String(value).replace(/'/g, "\\'")}'`
}

/** The `DEFAULT` expression of a column type, if it has one. */
export const defaultSqlOf = (type: AnyTinybirdType): string | undefined =>
	type.modifiers.defaultExpression !== undefined
		? type.modifiers.defaultExpression
		: type.modifiers.defaultValue !== undefined
			? formatDefaultValue(type.modifiers.defaultValue, getTinybirdType(type))
			: undefined

export const defineDatasource = <const Name extends string, const S extends SchemaDefinition>(
	name: Name,
	options: DatasourceOptions<S>,
): Datasource<Name, S> => {
	for (const index of options.indexes ?? []) {
		if (!Number.isInteger(index.granularity) || index.granularity <= 0) {
			throw new SchemaDefinitionDefect({
				object: `${name}.${index.name}`,
				message: "index granularity must be a positive integer",
			})
		}
	}
	const config = options.engine
	const columns = Object.fromEntries(
		Object.entries(options.schema).map(([key, input]) => {
			const type = getColumnType(input)
			const defaultExpr = defaultSqlOf(type)
			const spec: Define.ColumnSpec<AnyTinybirdType["column"]> = {
				_tag: "ColumnSpec",
				type: type.column,
				options: {
					...(defaultExpr !== undefined ? { defaultExpr } : {}),
					...(type.modifiers.codec !== undefined ? { codec: type.modifiers.codec } : {}),
				},
			}
			return [key, spec]
		}),
	)
	const keys =
		config === undefined
			? { orderBy: [] }
			: config.type === "Null"
				? {}
				: {
						orderBy: () => splitKey(config.sortingKey),
						...(config.partitionKey !== undefined ? { partitionBy: config.partitionKey } : {}),
						...(config.primaryKey !== undefined ? { primaryKey: () => splitKey(config.primaryKey!) } : {}),
						...(config.ttl !== undefined ? { ttl: config.ttl } : {}),
						...(config.settings !== undefined
							? {
									settings: Object.fromEntries(
										Object.entries(config.settings).map(([k, v]) => [k, settingValue(v)]),
									),
								}
							: {}),
					}
	const table = Define.defineTable(name, {
		columns,
		engine: config === undefined ? Define.engine.mergeTree() : engineSpec(config),
		...keys,
		...(options.indexes !== undefined && config?.type !== "Null"
			? { indexes: options.indexes.map((index) => Define.index(index.name, index.expr, index.type, index.granularity)) }
			: {}),
		...(options.tenantColumn !== undefined ? { tenantColumn: options.tenantColumn } : {}),
	})
	return Object.assign(table, {
		[DatasourceTypeId]: DatasourceTypeId,
		_name: name,
		_schema: options.schema,
		options,
	}) as unknown as Datasource<Name, S>
}

// Materialized views

export interface NodeDefinition {
	readonly _name: string
	readonly sql: string
	readonly description?: string
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export const node = (options: { readonly name: string; readonly sql: string; readonly description?: string }): NodeDefinition => {
	if (!IDENTIFIER.test(options.name)) {
		throw new SchemaDefinitionDefect({ object: options.name, message: "a node name must be a plain identifier" })
	}
	return {
		_name: options.name,
		sql: options.sql,
		...(options.description !== undefined ? { description: options.description } : {}),
	}
}

export const PipeTypeId: unique symbol = Symbol.for("@maple-dev/effect-orm/tinybird/Pipe")
export type PipeTypeId = typeof PipeTypeId

/** A Tinybird pipe that is also a schema view, so `generate` migrates it like `CH.materializedView`. */
export interface MaterializedViewDefinition<Name extends string = string> extends MaterializedView<Name> {
	readonly [PipeTypeId]: PipeTypeId
	readonly _name: Name
	readonly _type: "pipe"
	readonly options: {
		readonly description?: string
		readonly nodes: ReadonlyArray<NodeDefinition>
		readonly materialized: { readonly datasource: AnyDatasource; readonly deploymentMethod?: "alter" }
	}
}

export const isPipeDefinition = (value: unknown): value is MaterializedViewDefinition =>
	typeof value === "object" && value !== null && PipeTypeId in value

// Tables a view body reads, for the drop check; a CTE name listed here is harmless.
const sourcesOf = (select: string): ReadonlyArray<string> => [
	...new Set(Array.from(select.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gi), (m) => m[1]!)),
]

export const defineMaterializedView = <const Name extends string>(
	name: Name,
	options: {
		readonly description?: string
		readonly datasource: AnyDatasource
		readonly nodes: ReadonlyArray<NodeDefinition>
		/** `alter` changes the view in place instead of recreating its target. */
		readonly deploymentMethod?: "alter"
	},
): MaterializedViewDefinition<Name> => {
	if (!IDENTIFIER.test(name)) {
		throw new SchemaDefinitionDefect({ object: name, message: "a pipe name must be a plain identifier" })
	}
	if (options.nodes.length !== 1) {
		throw new SchemaDefinitionDefect({ object: name, message: "a materialized view needs exactly one node to render as ClickHouse DDL" })
	}
	const select = options.nodes[0]!.sql.trim()
	if (/\{%|\{\{/.test(select)) {
		throw new SchemaDefinitionDefect({ object: name, message: "a materialized view cannot use Tinybird template syntax" })
	}
	return {
		[PipeTypeId]: PipeTypeId,
		_tag: "MaterializedView",
		name,
		ddl: { kind: "materialized_view", name, to: options.datasource.name, sources: sourcesOf(select), select },
		_name: name,
		_type: "pipe",
		options: {
			...(options.description !== undefined ? { description: options.description } : {}),
			nodes: options.nodes,
			materialized: {
				datasource: options.datasource,
				...(options.deploymentMethod !== undefined ? { deploymentMethod: options.deploymentMethod } : {}),
			},
		},
	}
}
