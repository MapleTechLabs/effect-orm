// SQLite schema definitions: `table` from `/sqlite` with its column and index
// helpers.
//
// The SQLite counterpart of the Postgres `table`: the value IS a `Table`, so
// every query API accepts it, and its DDL rides beside it on `ddl` as SQLite
// entities. A definition that cannot become DDL records a problem, and
// `sqliteEntitiesOf` fails with it.

import { Effect } from "effect"
import type { Table } from "../ch/table"
import { withDialect } from "../ch/dialect"
import { encodeColumnLiteral } from "../ch/literal"
import { columnSqlName, type CHType, type ColumnDefs, type InferTS } from "../ch/types"
import { sqliteDialect } from "../sqlite/dialect"
import { timestamp } from "../sqlite/types"
import { createColumnAccessor } from "../ch/query"
import { ddlRenderer } from "./ddl-expr"
import { externalTable, type DdlExpr, type DdlKey } from "./define"
import { sortEntities } from "./entities"
import { checkDistinctNames, checkIdentifier, checkNoRepeats, definitionError, withRenderProblems, type DefinitionProblem, type ProblemSink, type SchemaDefinitionError } from "./problems"
import {
	canonicalSqliteType,
	type SqliteColumnEntity,
	type SqliteIndexEntity,
	type SqliteSchemaEntity,
	type SqliteTableEntity,
	type SqliteUniqueEntity,
} from "./sqlite-entities"

const ddl = ddlRenderer(sqliteDialect)

// Columns

export interface ColumnOptions<T extends CHType<string, any, any>> {
	/**
	 * The column's name in the database, when it differs from its key in
	 * `columns`: `orgId: SQLite.column(SQLite.text, { name: "org_id" })` is read
	 * and written as `$.orgId` and stored as `org_id`.
	 */
	readonly name?: string
	/** A literal default, encoded through the column's own type. A boolean is written `true` / `false`. */
	readonly default?: InferTS<T>
	/**
	 * `DEFAULT <expr>`. A string is written as given, so put an expression in
	 * the parentheses SQLite requires: `"(unixepoch())"`. A DSL expression is
	 * parenthesized for you.
	 */
	readonly defaultExpr?: DdlExpr<ColumnDefs>
	/**
	 * A one-column `UNIQUE` constraint, written inline as drizzle-kit 1.0 writes
	 * `.unique()`. `true` names it `<table>_<column>_unique`, drizzle's name; a
	 * string names it. SQLite keeps no constraint name; the snapshot does.
	 */
	readonly unique?: true | string
}

/** `Given` records which options were set, so the table knows which columns an insert may leave out. */
export interface ColumnSpec<
	T extends CHType<string, any, any>,
	Given extends keyof ColumnOptions<T> = keyof ColumnOptions<T>,
> {
	readonly _tag: "SqliteColumnSpec"
	readonly type: T
	readonly options: ColumnOptions<T>
	readonly _given?: Given
}

/** A column with options. A bare column type works too where none is needed. */
export const column = <T extends CHType<string, any, any>, Given extends keyof ColumnOptions<T> = never>(
	type: T,
	// A default must be a value: `default: undefined` would make the column optional on insert
	// while writing no DEFAULT, so the insert would fail on NOT NULL.
	options: ColumnOptions<T> & { readonly [K in Given]: K extends "default" | "defaultExpr" ? {} : unknown } = {} as never,
): ColumnSpec<T, Given> => ({ _tag: "SqliteColumnSpec", type, options })

export type ColumnInput = CHType<string, any, any> | ColumnSpec<CHType<string, any, any>, any>

/** The query-side column types of a `columns` record. */
export type ColumnsOf<I extends Record<string, ColumnInput>> = {
	readonly [K in keyof I]: I[K] extends ColumnSpec<infer T, any> ? T : I[K] extends CHType<string, any, any> ? I[K] : never
}

/** Columns declared with `default` or `defaultExpr`: an insert may leave them out. */
export type DefaultedColumnsOf<I extends Record<string, ColumnInput>> = {
	[K in keyof I]: I[K] extends ColumnSpec<any, infer Given>
		? [Exclude<Given, "name" | "unique">] extends [never]
			? never
			: K
		: never
}[keyof I] &
	string

const isColumnSpec = (input: unknown): input is ColumnSpec<CHType<string, any, any>, any> =>
	typeof input === "object" && input !== null && "_tag" in input && input._tag === "SqliteColumnSpec"

const columnTypeOfInput = (input: ColumnInput): CHType<string, any, any> => {
	if (!isColumnSpec(input)) return input
	return input.options.name === undefined ? input.type : { ...input.type, sqlName: input.options.name }
}

// Indexes

export interface IndexSpec<Cols extends ColumnDefs> {
	readonly _tag: "SqliteIndexSpec"
	readonly name: string
	readonly unique: boolean
	readonly on: DdlKey<Cols>
}

/** An index on columns or expressions: `index("t_org", ["orgId"])`, or a callback building expressions. */
export const index = <Cols extends ColumnDefs>(name: string, on: DdlKey<Cols>): IndexSpec<Cols> => ({
	_tag: "SqliteIndexSpec",
	name,
	unique: false,
	on,
})

/** A unique index. An `onConflict` target can name its columns. */
export const uniqueIndex = <Cols extends ColumnDefs>(name: string, on: DdlKey<Cols>): IndexSpec<Cols> => ({
	_tag: "SqliteIndexSpec",
	name,
	unique: true,
	on,
})

/** A `SQLite.timestamp` column, nullable or not. */
const isTimestamp = (type: CHType<string, any, any>): boolean =>
	type.schema === timestamp.schema || (type._tag === "Nullable" && (type as { element?: CHType<string, any, any> }).element?.schema === timestamp.schema)

/**
 * SQLite compares timestamp text by bytes, so a timestamp column's default
 * must write the column's own form (`timestampNow`). CURRENT_TIMESTAMP,
 * datetime(), unixepoch() and a strftime with another format write another
 * form, which misorders against the column's values.
 */
const checkTimestampDefault = (problems: ProblemSink, table: string, name: string, spec: ColumnSpec<CHType<string, any, any>>, sql: string): void => {
	if (!isTimestamp(spec.type)) return
	const otherForm =
		/\bcurrent_(timestamp|date|time)\b|\b(datetime|date|time|julianday|unixepoch)\s*\(/i.test(sql) ||
		/\bstrftime\s*\(\s*'(?!%Y-%m-%d %H:%M:%f')/i.test(sql)
	if (otherForm) {
		problems.push({
			object: `${table}.${name}`,
			message: `defaultExpr ${sql} writes a different text form than a timestamp column compares with; use SQLite.timestampNow`,
		})
	}
}

const columnDefault = (
	problems: ProblemSink,
	table: string,
	name: string,
	spec: ColumnSpec<CHType<string, any, any>>,
	columns: ColumnDefs,
): string | null => {
	const { options } = spec
	if (options.default !== undefined && options.defaultExpr !== undefined) {
		problems.push({ object: `${table}.${name}`, message: "a column takes one of default, defaultExpr" })
	}
	for (const key of ["default", "defaultExpr"] as const) {
		if (Object.hasOwn(options, key) && options[key] === undefined) {
			problems.push({ object: `${table}.${name}`, message: `${key} is undefined; leave it out, or the column is optional on insert with no DEFAULT` })
		}
	}
	if (options.defaultExpr !== undefined) {
		if (typeof options.defaultExpr === "string") {
			checkTimestampDefault(problems, table, name, spec, options.defaultExpr)
			return options.defaultExpr
		}
		// SQLite refuses a DEFAULT that reads a column ("default value of column is not constant").
		const read: Array<string> = []
		const accessor = createColumnAccessor(columns)
		const tracked = new Proxy(accessor, {
			get: (target, key, receiver) => {
				if (typeof key === "string" && Object.hasOwn(columns, key)) read.push(key)
				return Reflect.get(target, key, receiver)
			},
		})
		const sql = ddl.value(options.defaultExpr(tracked as typeof accessor))
		if (read.length > 0) {
			problems.push({ object: `${table}.${name}`, message: `defaultExpr reads ${[...new Set(read)].join(", ")}; SQLite requires a constant default` })
		}
		checkTimestampDefault(problems, table, name, spec, sql)
		return `(${sql})`
	}
	if (options.default === undefined || options.default === null) return null
	// SQLite reads TRUE / FALSE as 1 / 0; drizzle-kit writes them as keywords.
	if (typeof options.default === "boolean") return options.default ? "true" : "false"
	return withDialect(sqliteDialect, () => encodeColumnLiteral(spec.type, options.default, name))
}

// Tables

export interface TableDefinition<Columns extends Record<string, ColumnInput>> {
	readonly columns: Columns
	/** One column, written inline as drizzle-kit does, or several, as a table constraint. */
	readonly primaryKey?: ReadonlyArray<keyof Columns & string>
	readonly indexes?: ReadonlyArray<IndexSpec<ColumnsOf<Columns>>>
	/** The column carrying row-level tenancy; see docs/tenant-scoping.md. */
	readonly tenantColumn?: keyof Columns & string
}

/** A table this schema does not own: a view, or one another tool migrates. No DDL. */
export interface ExternalTableDefinition<Columns extends Record<string, ColumnInput>> {
	readonly external: true
	readonly columns: Columns
	readonly tenantColumn?: keyof Columns & string
}

/** The DDL a SQLite table carries, as entities. */
export interface TableDdl {
	readonly dialect: "sqlite"
	readonly table: SqliteTableEntity
	readonly columns: ReadonlyArray<SqliteColumnEntity>
	readonly indexes: ReadonlyArray<SqliteIndexEntity>
	readonly uniques: ReadonlyArray<SqliteUniqueEntity>
}

export interface SqliteSchemaTable<Name extends string, Cols extends ColumnDefs, Defaulted extends string = string>
	extends Table<Name, Cols, Defaulted, never> {
	readonly ddl: TableDdl
	/** What is wrong with the definition; `sqliteEntitiesOf` fails when any table has one. */
	readonly problems: ReadonlyArray<DefinitionProblem>
}

/** A table or index name SQLite reserves for itself. */
const checkName = (problems: ProblemSink, object: string, name: string): void => {
	checkIdentifier(problems, object, name)
	if (name.toLowerCase().startsWith("sqlite_")) {
		problems.push({ object, message: `${JSON.stringify(name)} starts with sqlite_, which SQLite reserves` })
	}
}

/** Is `definition` a `{ columns, ... }` definition, rather than a record of columns? */
export const isTableDefinition = (definition: object): definition is { readonly columns: Record<string, unknown> } => {
	if (!("columns" in definition)) return false
	const columns = definition.columns
	return typeof columns === "object" && columns !== null && !("sql" in columns && "schema" in columns)
}

export const externalSqliteTable = <const Name extends string>(
	name: Name,
	definition: ExternalTableDefinition<Record<string, ColumnInput>>,
): Table<Name, any, any, any> => externalTable(name, definition, isColumnSpec, [], (spec) => columnTypeOfInput(spec as ColumnInput))

/**
 * A SQLite table with its DDL. The value IS a query `Table`.
 *
 * A column is `NOT NULL` unless its type is `SQLite.nullable(...)`.
 */
export const sqliteTable = <const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: TableDefinition<Columns>,
): SqliteSchemaTable<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>> => withRenderProblems(name, () => buildTable(name, definition))

function buildTable<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: TableDefinition<Columns>,
): SqliteSchemaTable<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>> {
	const problems: ProblemSink = []
	checkName(problems, name, name)
	const inputs = Object.entries(definition.columns)
	if (inputs.length === 0) problems.push({ object: name, message: "a table needs columns" })
	const types = Object.fromEntries(inputs.map(([column, input]) => [column, columnTypeOfInput(input)])) as ColumnsOf<Columns>
	const sqlName = (column: string) => columnSqlName(types, column)
	const has = (column: string) => Object.hasOwn(types, column)

	const columnEntities = inputs.map(([column, input], position): SqliteColumnEntity => {
		checkIdentifier(problems, `${name}.${column}`, sqlName(column))
		const spec: ColumnSpec<CHType<string, any, any>> = isColumnSpec(input)
			? input
			: { _tag: "SqliteColumnSpec", type: input as CHType<string, any, any>, options: {} }
		return {
			kind: "column",
			table: name,
			name: sqlName(column),
			position,
			type: canonicalSqliteType(spec.type.sql),
			notNull: spec.type._tag !== "Nullable",
			default: columnDefault(problems, name, column, spec, types),
		}
	})

	// SQLite compares column names without case, so `Id` and `id` are one column.
	checkDistinctNames(problems, name, inputs.map(([column]) => [column, sqlName(column)] as const), { ignoreCase: true })

	const pkColumns = definition.primaryKey ?? []
	checkNoRepeats(problems, `${name} primary key`, pkColumns)
	if (definition.primaryKey !== undefined) {
		if (pkColumns.length === 0) problems.push({ object: name, message: "a primary key needs columns" })
		for (const column of pkColumns) {
			if (!has(column)) problems.push({ object: `${name} primary key`, message: `${column} is not a column` })
			else if (columnEntities.find((c) => c.name === sqlName(column))?.notNull === false) {
				problems.push({
					object: `${name}.${column}`,
					message: "a primary key column cannot be nullable; SQLite would accept NULL keys",
				})
			}
		}
	}

	const indexEntities: ReadonlyArray<SqliteIndexEntity> = (definition.indexes ?? []).map((spec): SqliteIndexEntity => {
		checkName(problems, `${name} index`, spec.name)
		if (Array.isArray(spec.on)) {
			checkNoRepeats(problems, `${name} index ${spec.name}`, spec.on)
			for (const column of spec.on) {
				if (!has(column)) problems.push({ object: `${name} index ${spec.name}`, message: `${column} is not a column` })
			}
		}
		const columns = ddl.keyParts(spec.on, types)
		if (columns.length === 0) problems.push({ object: `${name} index ${spec.name}`, message: "an index needs columns" })
		return { kind: "index", table: name, name: spec.name, unique: spec.unique, columns }
	})

	const uniqueEntities: Array<SqliteUniqueEntity> = []
	for (const [column, input] of inputs) {
		const option = isColumnSpec(input) ? input.options.unique : undefined
		if (option === undefined) continue
		const uniqueName = option === true ? `${name}_${sqlName(column)}_unique` : option
		checkIdentifier(problems, `${name}.${column} unique`, uniqueName)
		uniqueEntities.push({ kind: "unique", table: name, name: uniqueName, columns: [sqlName(column)] })
	}

	const tableEntity: SqliteTableEntity = {
		kind: "table",
		name,
		primaryKey: definition.primaryKey === undefined ? null : { columns: pkColumns.filter(has).map(sqlName) },
	}
	const defaults = inputs.filter((_, position) => columnEntities[position]!.default !== null).map(([column]) => column)
	return {
		_tag: "Table",
		name,
		columns: types,
		...(definition.tenantColumn !== undefined ? { tenantColumn: definition.tenantColumn } : undefined),
		...(defaults.length > 0 ? { defaults: defaults as unknown as Array<DefaultedColumnsOf<Columns>> } : undefined),
		ddl: { dialect: "sqlite", table: tableEntity, columns: columnEntities, indexes: indexEntities, uniques: uniqueEntities },
		problems,
	}
}

/**
 * The entities of a set of SQLite tables, validated as one schema: table and
 * index names do not collide (SQLite keeps them in one namespace). Fails with
 * every problem found.
 */
export const sqliteEntitiesOf = (
	tables: ReadonlyArray<SqliteSchemaTable<string, any>>,
): Effect.Effect<ReadonlyArray<SqliteSchemaEntity>, SchemaDefinitionError> => {
	const problems: ProblemSink = []
	const entities: Array<SqliteSchemaEntity> = []
	const names = new Map<string, string>()
	const claim = (name: string, what: string) => {
		const other = names.get(name.toLowerCase())
		if (other !== undefined) {
			problems.push({ object: name, message: `names both ${other} and ${what}; SQLite keeps them in one namespace` })
		}
		names.set(name.toLowerCase(), what)
	}
	for (const table of tables) {
		if (!("ddl" in table) || (table.ddl as { dialect?: string }).dialect !== "sqlite") {
			problems.push({ object: table.name, message: "is not a SQLite table with DDL; declare it with SQLite.table(name, { columns })" })
			continue
		}
		problems.push(...table.problems)
		const { ddl } = table
		claim(ddl.table.name, `table ${ddl.table.name}`)
		for (const index of ddl.indexes) claim(index.name, `an index on ${ddl.table.name}`)
		const constraints = new Set<string>()
		for (const unique of ddl.uniques) {
			if (constraints.has(unique.name)) problems.push({ object: `${ddl.table.name}.${unique.name}`, message: "defined twice" })
			constraints.add(unique.name)
		}
		entities.push(ddl.table, ...ddl.columns, ...ddl.indexes, ...ddl.uniques)
	}
	return problems.length > 0 ? Effect.fail(definitionError(problems)) : Effect.succeed(sortEntities(entities))
}
