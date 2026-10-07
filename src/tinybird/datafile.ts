// Tinybird datafiles (`.datasource`, `.pipe`), byte-compatible with the
// generator of `@tinybirdco/sdk` 0.0.84 (MIT), for the features ported here.

import {
	defaultSqlOf,
	getColumnJsonPath,
	getColumnType,
	isDatasourceDefinition,
	isPipeDefinition,
	splitKey,
	type AnyDatasource,
	type EngineConfig,
	type MaterializedViewDefinition,
	type NodeDefinition,
} from "./datasource"
import { getTinybirdType } from "./types"

export interface Datafile {
	readonly name: string
	readonly content: string
}

export interface TinybirdProject {
	readonly datasources: ReadonlyArray<Datafile>
	readonly pipes: ReadonlyArray<Datafile>
}

const indent = (text: string): ReadonlyArray<string> => text.split(/\r?\n/).map((line) => `    ${line}`)

const engineClause = (config: EngineConfig | undefined): string => {
	if (config === undefined) return 'ENGINE "MergeTree"'
	if (config.type === "Null") return "ENGINE Null"
	const lines = [`ENGINE "${config.type}"`]
	if (config.partitionKey) lines.push(`ENGINE_PARTITION_KEY "${config.partitionKey}"`)
	lines.push(`ENGINE_SORTING_KEY "${normalizeKey(config.sortingKey)}"`)
	if (config.primaryKey) lines.push(`ENGINE_PRIMARY_KEY "${normalizeKey(config.primaryKey)}"`)
	if (config.ttl) lines.push(`ENGINE_TTL "${config.ttl}"`)
	if (config.type === "ReplacingMergeTree" && config.ver) lines.push(`ENGINE_VER "${config.ver}"`)
	if (config.type === "ReplacingMergeTree" && config.isDeleted) lines.push(`ENGINE_IS_DELETED "${config.isDeleted}"`)
	if (config.type === "CollapsingMergeTree" || config.type === "VersionedCollapsingMergeTree") {
		lines.push(`ENGINE_SIGN "${config.sign}"`)
	}
	if (config.type === "VersionedCollapsingMergeTree") lines.push(`ENGINE_VERSION "${config.version}"`)
	if (config.type === "SummingMergeTree" && config.columns && config.columns.length > 0) {
		lines.push(`ENGINE_SUMMING_COLUMNS "${config.columns.join(", ")}"`)
	}
	if (config.settings && Object.keys(config.settings).length > 0) {
		const settings = Object.entries(config.settings)
			.map(([key, value]) => (typeof value === "string" ? `${key}='${value.replace(/'/g, "\\'")}'` : `${key}=${value}`))
			.join(", ")
		lines.push(`ENGINE_SETTINGS "${settings}"`)
	}
	return lines.join("\n")
}

// The SDK joins an array key with ", " and keeps a string key as written.
const normalizeKey = (key: string | ReadonlyArray<string>): string => (typeof key === "string" ? key : key.join(", "))

export const generateDatasource = (datasource: AnyDatasource): Datafile => {
	const { options } = datasource
	const parts: Array<string> = []
	if (options.description) parts.push(`DESCRIPTION >\n    ${options.description}`, "")

	const includeJsonPaths = options.jsonPaths !== false
	const names = Object.keys(options.schema)
	const columns = names.map((name, index) => {
		const input = options.schema[name]!
		const type = getColumnType(input)
		const line = [`    ${name} ${getTinybirdType(type)}`]
		if (includeJsonPaths) line.push(`\`json:${getColumnJsonPath(input) ?? `$.${name}`}\``)
		const defaultSql = defaultSqlOf(type)
		if (defaultSql !== undefined) line.push(`DEFAULT ${defaultSql}`)
		if (type.modifiers.codec) line.push(`CODEC(${type.modifiers.codec})`)
		return line.join(" ") + (index < names.length - 1 ? "," : "")
	})
	parts.push(["SCHEMA >", ...columns].join("\n"), "")
	parts.push(engineClause(options.engine))

	if (options.indexes && options.indexes.length > 0) {
		parts.push(
			"",
			[
				"INDEXES >",
				...options.indexes.map(
					(index) => `    ${index.name} ${index.expr} TYPE ${index.type} GRANULARITY ${index.granularity}`,
				),
			].join("\n"),
		)
	}

	const forwardQuery = options.forwardQuery?.trim()
	if (forwardQuery) parts.push("", ["FORWARD_QUERY >", ...indent(forwardQuery)].join("\n"))

	return { name: datasource._name, content: parts.join("\n") }
}

const TEMPLATE = /\{\{[^}]+\}\}|\{%[^%]+%\}/

const generateNode = (node: NodeDefinition): string => {
	const lines = [`NODE ${node._name}`]
	if (node.description) lines.push("DESCRIPTION >", `    ${node.description}`)
	lines.push("SQL >")
	if (TEMPLATE.test(node.sql)) lines.push("    %")
	for (const line of node.sql.trim().split("\n")) lines.push(`    ${line}`)
	return lines.join("\n")
}

export const generatePipe = (pipe: MaterializedViewDefinition): Datafile => {
	const { options } = pipe
	const parts: Array<string> = []
	if (options.description) parts.push(`DESCRIPTION >\n    ${options.description}`, "")
	options.nodes.forEach((node, index) => {
		parts.push(generateNode(node))
		if (index < options.nodes.length - 1) parts.push("")
	})
	const materialized = ["TYPE MATERIALIZED", `DATASOURCE ${options.materialized.datasource._name}`]
	if (options.materialized.deploymentMethod === "alter") materialized.push("DEPLOYMENT_METHOD alter")
	parts.push("", materialized.join("\n"))
	return { name: pipe._name, content: parts.join("\n") }
}

/**
 * The datafiles of every datasource and materialized view exported by the
 * given modules, in export order (a module namespace lists exports by name).
 */
export const buildProject = (...modules: ReadonlyArray<Readonly<Record<string, unknown>>>): TinybirdProject => {
	const seen = new Set<unknown>()
	const datasources: Array<Datafile> = []
	const pipes: Array<Datafile> = []
	for (const module of modules) {
		for (const value of Object.values(module)) {
			if (seen.has(value)) continue
			if (isDatasourceDefinition(value)) {
				seen.add(value)
				datasources.push(generateDatasource(value))
			} else if (isPipeDefinition(value)) {
				seen.add(value)
				pipes.push(generatePipe(value))
			}
		}
	}
	return { datasources, pipes }
}
