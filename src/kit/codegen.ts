// `effect-orm pull`'s output: a schema module written from a live database.
//
// Every value is written so that the definition yields back the entity it
// came from: `entitiesOf` on the generated module equals the introspected
// entities. Expressions (defaults, keys, TTL, index bodies) are the server's
// text as strings; turning SQL back into the query DSL is not attempted.
//
// A column type maps to the built-in that writes the same SQL (`CH.nullable`,
// `CH.precision(CH.dateTime64, 3)`, ...). A type with no built-in becomes
// `CH.custom` with the schema its JSON value decodes with, and one this file
// does not know becomes `CH.untyped`, marked for review.

import type { ColumnEntity, EngineSpec, IndexEntity, TableEntity } from "../schema/entities"
import { keyParts, splitCall, type ExternalTable, type IntrospectedSchema } from "../migrate/introspect"

export interface CodegenOptions {
	/** Where the module imports `CH` from. Default `@maple-dev/effect-orm/clickhouse`. */
	readonly importPath?: string
	/** Lines for the header comment, after the first. */
	readonly header?: ReadonlyArray<string>
}

const str = (value: string): string => JSON.stringify(value)
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const key = (name: string): string => (IDENTIFIER.test(name) ? name : str(name))

// Column types

interface TypeCode {
	readonly code: string
	/** The SQL the code writes; a mismatch with the column's type falls back to `CH.custom`. */
	readonly sql: string
	/** It decodes to a string, so it can key a `Map`. */
	readonly stringKey: boolean
	readonly usesSchema: boolean
	readonly todo?: string
}

const SCALARS: Readonly<Record<string, string>> = {
	String: "CH.string",
	UInt8: "CH.uint8",
	UInt16: "CH.uint16",
	UInt32: "CH.uint32",
	UInt64: "CH.uint64",
	Int32: "CH.int32",
	Int64: "CH.int64",
	Float64: "CH.float64",
	Bool: "CH.bool",
	DateTime: "CH.dateTime",
}
/** Read as `number`: what `CHNumber` accepts on the wire (a number, or a quoted one). */
const NUMBERS = new Set(["Int8", "Int16", "Float32", "BFloat16", "Decimal", "Decimal32", "Decimal64", "Decimal128", "Decimal256"])
/** Read as `string`: values JSON quotes, or a 128/256-bit integer `number` would round. */
const STRINGS = new Set(["UInt128", "UInt256", "Int128", "Int256", "Date", "Date32", "UUID", "IPv4", "IPv6", "FixedString", "DateTime", "DateTime64"])

const custom = (sql: string, schema: string, stringKey: boolean): TypeCode => ({
	code: `CH.custom(${str(sql)}, ${schema})`,
	sql,
	stringKey,
	usesSchema: schema.startsWith("Schema."),
})

const untyped = (sql: string): TypeCode => ({
	code: `CH.untyped(${str(sql)})`,
	sql,
	stringKey: false,
	usesSchema: false,
	todo: `${sql} has no built-in type; rows hold it undecoded`,
})

/** `'a' = 1` as `a`. */
const enumLabel = (entry: string): string | undefined => {
	const match = /^'((?:[^'\\]|\\.)*)'\s*=\s*-?\d+$/s.exec(entry.trim())
	return match === null ? undefined : match[1]!.replace(/\\(.)/g, "$1")
}

const mapped = (sql: string): TypeCode => {
	const { name, args } = splitCall(sql)
	if (args === undefined) {
		const scalar = SCALARS[name]
		if (scalar !== undefined) return { code: scalar, sql, stringKey: name === "String", usesSchema: false }
		if (NUMBERS.has(name)) return custom(sql, "CH.CHNumber", false)
		if (STRINGS.has(name)) return custom(sql, "Schema.String", true)
		return untyped(sql)
	}
	/** `open` is the code before the inner type's: `CH.nullable(`. */
	const wrap = (open: string, inner: TypeCode, sqlOf: (s: string) => string, stringKey = false): TypeCode => ({
		code: `${open}${inner.code})`,
		sql: sqlOf(inner.sql),
		stringKey,
		usesSchema: inner.usesSchema,
		...(inner.todo !== undefined ? { todo: inner.todo } : undefined),
	})
	switch (name) {
		case "Nullable":
			return args.length === 1 ? wrap("CH.nullable(", typeCode(args[0]!), (s) => `Nullable(${s})`) : untyped(sql)
		case "LowCardinality": {
			if (args.length !== 1) return untyped(sql)
			const inner = typeCode(args[0]!)
			return wrap("CH.lowCardinality(", inner, (s) => `LowCardinality(${s})`, inner.stringKey)
		}
		case "Array":
			return args.length === 1 ? wrap("CH.array(", typeCode(args[0]!), (s) => `Array(${s})`) : untyped(sql)
		case "Map": {
			if (args.length !== 2) return untyped(sql)
			const [k, v] = [typeCode(args[0]!), typeCode(args[1]!)]
			if (!k.stringKey) return untyped(sql)
			const todo = k.todo ?? v.todo
			return {
				code: `CH.map(${k.code}, ${v.code})`,
				sql: `Map(${k.sql}, ${v.sql})`,
				stringKey: false,
				usesSchema: k.usesSchema || v.usesSchema,
				...(todo !== undefined ? { todo } : undefined),
			}
		}
		case "DateTime64":
			return args.length === 1 && /^\d$/.test(args[0]!)
				? { code: `CH.precision(CH.dateTime64, ${args[0]})`, sql: `DateTime64(${args[0]})`, stringKey: false, usesSchema: false }
				: custom(sql, "Schema.String", true)
		case "SimpleAggregateFunction":
			if (args.length !== 2) return untyped(sql)
			return wrap(`CH.simpleAggregateFunction(${str(args[0]!)}, `, typeCode(args[1]!), (s) => `SimpleAggregateFunction(${args[0]}, ${s})`)
		case "AggregateFunction":
			return {
				code: `CH.aggregateState(${args.map(str).join(", ")})`,
				sql: `AggregateFunction(${args.join(", ")})`,
				stringKey: false,
				usesSchema: false,
			}
		case "Enum8":
		case "Enum16": {
			const labels = args.map(enumLabel)
			if (labels.length === 0 || labels.some((label) => label === undefined)) return untyped(sql)
			return custom(sql, `Schema.Literals([${labels.map((label) => str(label!)).join(", ")}])`, true)
		}
		case "Decimal":
		case "Decimal32":
		case "Decimal64":
		case "Decimal128":
		case "Decimal256": {
			const precision = name === "Decimal" ? Number(args[0]) : { Decimal32: 9, Decimal64: 18, Decimal128: 38, Decimal256: 76 }[name]
			const type = custom(sql, "CH.CHNumber", false)
			// A double holds 15 significant digits exactly.
			return precision > 15 ? { ...type, todo: `${sql} decodes to a number, which rounds past 15 significant digits` } : type
		}
		default:
			if (NUMBERS.has(name)) return custom(sql, "CH.CHNumber", false)
			if (STRINGS.has(name)) return custom(sql, "Schema.String", true)
			return untyped(sql)
	}
}

/** The code for a column type, writing exactly `sql`. */
export const typeCode = (sql: string): TypeCode => {
	const result = mapped(sql)
	if (result.sql === sql) return result
	// A built-in that writes the type differently: keep the server's text.
	return untyped(sql)
}

// Tables

interface Out {
	readonly lines: Array<string>
	usesSchema: boolean
	readonly todos: Array<string>
}

/** `ddl: false` writes only the default's kind, which says what an insert may leave out or not write. */
const columnCode = (out: Out, column: ColumnEntity, ddl: boolean): string => {
	const type = typeCode(column.type)
	if (type.usesSchema) out.usesSchema = true
	if (type.todo !== undefined) out.todos.push(`${column.table}.${column.name}: ${type.todo}`)
	const options: Array<string> = []
	if (column.default !== null) {
		const option = { DEFAULT: "defaultExpr", MATERIALIZED: "materialized", ALIAS: "alias" }[column.default.kind]
		options.push(`${option}: ${str(column.default.expr)}`)
	}
	if (ddl) {
		if (column.codec !== null) options.push(`codec: ${str(column.codec)}`)
		if (column.comment !== null) options.push(`comment: ${str(column.comment)}`)
	}
	return options.length === 0 ? type.code : `CH.column(${type.code}, { ${options.join(", ")} })`
}

const engineCode = (engine: EngineSpec): string => {
	const [a, b] = engine.params
	const n = engine.params.length
	const helpers: Readonly<Record<string, string>> = {
		MergeTree: "mergeTree",
		AggregatingMergeTree: "aggregatingMergeTree",
		ReplacingMergeTree: "replacingMergeTree",
		SummingMergeTree: "summingMergeTree",
		Null: "null",
		Memory: "memory",
	}
	if (n === 0 && helpers[engine.family] !== undefined) return `CH.engine.${helpers[engine.family]}()`
	if (engine.family === "ReplacingMergeTree" && n <= 2) {
		return `CH.engine.replacingMergeTree({ version: ${str(a!)}${n === 2 ? `, isDeleted: ${str(b!)}` : ""} })`
	}
	if (engine.family === "CollapsingMergeTree" && n === 1) return `CH.engine.collapsingMergeTree(${str(a!)})`
	if (engine.family === "VersionedCollapsingMergeTree" && n === 2) return `CH.engine.versionedCollapsingMergeTree(${str(a!)}, ${str(b!)})`
	return `{ family: ${str(engine.family)}, params: [${engine.params.map(str).join(", ")}] }`
}

const keyCode = (text: string, columns: ReadonlySet<string>): string => {
	if (text === "tuple()") return "[]"
	const parts = keyParts(text)
	return parts.every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) && columns.has(part))
		? `[${parts.map(str).join(", ")}]`
		: `() => [${parts.map(str).join(", ")}]`
}

const pascal = (name: string): string => {
	const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
	const joined = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("")
	return joined.length === 0 || /^\d/.test(joined) ? `T${joined}` : joined
}

const tableCode = (out: Out, exportName: string, table: TableEntity, columns: ReadonlyArray<ColumnEntity>, indexes: ReadonlyArray<IndexEntity>) => {
	const names = new Set(columns.map((c) => c.name))
	const l = out.lines
	l.push(`export const ${exportName} = CH.table(${str(table.name)}, {`)
	l.push("\tcolumns: {")
	for (const column of columns) l.push(`\t\t${key(column.name)}: ${columnCode(out, column, true)},`)
	l.push("\t},")
	l.push(`\tengine: ${engineCode(table.engine)},`)
	if (table.orderBy !== null) l.push(`\torderBy: ${keyCode(table.orderBy, names)},`)
	if (table.partitionBy !== null) l.push(`\tpartitionBy: ${str(table.partitionBy)},`)
	if (table.primaryKey !== null) l.push(`\tprimaryKey: ${keyCode(table.primaryKey, names)},`)
	if (table.ttl !== null) l.push(`\tttl: ${str(table.ttl)},`)
	const settings = Object.entries(table.settings)
	if (settings.length > 0) l.push(`\tsettings: { ${settings.map(([k, v]) => `${key(k)}: ${str(v)}`).join(", ")} },`)
	if (indexes.length > 0) {
		l.push("\tindexes: [")
		for (const index of indexes) {
			l.push(`\t\tCH.index(${str(index.name)}, ${str(index.expr)}, ${str(index.type)}, ${index.granularity}),`)
		}
		l.push("\t],")
	}
	if (table.comment !== null) l.push(`\tcomment: ${str(table.comment)},`)
	l.push("})")
}

const externalCode = (out: Out, exportName: string, table: ExternalTable) => {
	out.lines.push(`/** ${table.engine}: queried, never migrated. */`)
	out.lines.push(`export const ${exportName} = CH.table(${str(table.name)}, {`)
	out.lines.push("\texternal: true,")
	out.lines.push("\tcolumns: {")
	for (const column of table.columns) out.lines.push(`\t\t${key(column.name)}: ${columnCode(out, column, false)},`)
	out.lines.push("\t},")
	out.lines.push("})")
}

/** The schema module for an introspected ClickHouse database. */
export const renderClickHouseSchema = (schema: IntrospectedSchema, options: CodegenOptions = {}): { readonly source: string; readonly todos: ReadonlyArray<string> } => {
	const out: Out = { lines: [], usesSchema: false, todos: [] }
	const tables: Array<TableEntity> = []
	const columns = new Map<string, Array<ColumnEntity>>()
	const indexes = new Map<string, Array<IndexEntity>>()
	const add = <E>(map: Map<string, Array<E>>, table: string, entity: E) => map.set(table, [...(map.get(table) ?? []), entity])
	for (const entity of schema.entities) {
		if (entity.kind === "table") tables.push(entity)
		else if (entity.kind === "column") add(columns, entity.table, entity)
		else if (entity.kind === "index") add(indexes, entity.table, entity)
	}
	const taken = new Set<string>(["CH", "Schema"])
	const exportName = (name: string) => {
		const base = pascal(name)
		let candidate = base
		for (let i = 2; taken.has(candidate); i++) candidate = `${base}${i}`
		taken.add(candidate)
		return candidate
	}
	const objects = [
		...tables.map((t) => ({ name: t.name, write: () => tableCode(out, exportName(t.name), t, (columns.get(t.name) ?? []).sort((a, b) => a.position - b.position), indexes.get(t.name) ?? []) })),
		...schema.external.map((t) => ({ name: t.name, write: () => externalCode(out, exportName(t.name), t) })),
	].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	objects.forEach((object, i) => {
		if (i > 0) out.lines.push("")
		object.write()
	})

	const header = [
		`// Generated by \`effect-orm pull\` from ClickHouse database \`${schema.database}\`.`,
		...(options.header ?? []).map((line) => `// ${line}`),
		...(schema.notes.length + out.todos.length > 0 ? ["//", "// Review:", ...[...schema.notes, ...out.todos].map((line) => `// - ${line}`)] : []),
	]
	const imports = [
		...(out.usesSchema ? ['import { Schema } from "effect"'] : []),
		`import * as CH from ${str(options.importPath ?? "@maple-dev/effect-orm/clickhouse")}`,
	]
	return { source: `${[...header, "", ...imports, "", ...out.lines].join("\n")}\n`, todos: out.todos }
}
