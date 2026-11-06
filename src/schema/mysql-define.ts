// MySQL / MariaDB schema definitions: `table` from `/mysql` with its column and
// index helpers.
//
// The MySQL counterpart of the SQLite `table`: the value IS a `Table`, so every
// query API accepts it, and its DDL rides beside it on `ddl` as MySQL entities.
// A definition that cannot become DDL records a problem, and `mysqlEntitiesOf`
// fails with it.

import { Effect } from "effect"
import { clientDefaultsOf } from "../ch/client-defaults"
import type { InsertValue } from "../ch/insert"
import type { ClientDefaults, Table } from "../ch/table"
import { withDialect } from "../ch/dialect"
import { encodeColumnLiteral } from "../ch/literal"
import { columnSqlName, type CHType, type ColumnDefs, type InferTS } from "../ch/types"
import { mysqlDialect } from "../mysql/dialect"
import { createColumnAccessor } from "../ch/query"
import { ddlRenderer } from "./ddl-expr"
import type { Casing } from "./casing"
import { externalTable, namedColumnType, type DdlExpr } from "./define"
import { sortEntities } from "./entities"
import { checkDistinctNames, checkIdentifier, checkNoRepeats, definitionError, withRenderProblems, type DefinitionProblem, type ProblemSink, type SchemaDefinitionError } from "./problems"
import {
	canonicalMysqlType,
	isMysqlLobType,
	type MysqlColumnEntity,
	type MysqlIndexEntity,
	type MysqlSchemaEntity,
	type MysqlTableEntity,
	type MysqlUniqueEntity,
} from "./mysql-entities"

const ddl = ddlRenderer(mysqlDialect)

// Columns

export interface ColumnOptions<T extends CHType<string, any, any>, DefaultR = never, UpdateR = never> {
	/**
	 * The column's name in the database, when it differs from its key in
	 * `columns`: `orgId: MySQL.column(MySQL.varchar(36), { name: "org_id" })` is
	 * read and written as `$.orgId` and stored as `org_id`.
	 */
	readonly name?: string
	/**
	 * A literal default, encoded through the column's own type. On a TEXT, BLOB
	 * or JSON column it is written as an expression, `DEFAULT ('…')`, which
	 * MySQL 8.0.13+ and MariaDB accept.
	 */
	readonly default?: InferTS<T>
	/**
	 * `DEFAULT <expr>`. A string is written as given, so put an expression in
	 * the parentheses MySQL requires: `"(UUID())"`, or `MySQL.dateTimeNow`. A
	 * DSL expression is parenthesized for you.
	 */
	readonly defaultExpr?: DdlExpr<ColumnDefs>
	/**
	 * A one-column `UNIQUE` constraint. `true` names it
	 * `<table>_<column>_unique`; a string names it.
	 */
	readonly unique?: true | string
	/**
	 * A client-side default: an Effect that `Database.run` runs for each row
	 * an insert leaves the column out of, such as `DateTime.now` or an id from
	 * a service. Its requirements become the insert's. No DDL.
	 */
	readonly defaultFn?: Effect.Effect<InsertValue<T>, never, DefaultR>
	/**
	 * A client-side value for every update: an Effect that `Database.run` runs
	 * once for an update that does not set the column, such as `DateTime.now`
	 * for an `updatedAt`. An insert that leaves the column out runs it too,
	 * when the column has no database default. Its requirements become the
	 * update's. No DDL.
	 */
	readonly onUpdate?: Effect.Effect<InsertValue<T>, never, UpdateR>
}

/**
 * `Given` records which options were set, so the table knows which columns an
 * insert may leave out. `DefaultR` and `UpdateR` are what its `defaultFn` and
 * `onUpdate` need.
 */
export interface ColumnSpec<
	T extends CHType<string, any, any>,
	Given extends keyof ColumnOptions<T> = keyof ColumnOptions<T>,
	DefaultR = never,
	UpdateR = never,
> {
	readonly _tag: "MysqlColumnSpec"
	readonly type: T
	readonly options: ColumnOptions<T, DefaultR, UpdateR>
	readonly _given?: Given
}

/** A column with options. A bare column type works too where none is needed. */
export const column = <T extends CHType<string, any, any>, Given extends keyof ColumnOptions<T> = never, DefaultR = never, UpdateR = never>(
	type: T,
	// A default must be a value: `default: undefined` would make the column optional on insert
	// while writing no DEFAULT, so the insert would fail on NOT NULL. The same holds for the client defaults.
	options: ColumnOptions<T, DefaultR, UpdateR> & {
		readonly [K in Given]: K extends "default" | "defaultExpr" | "defaultFn" | "onUpdate" ? {} : unknown
	} = {} as never,
): ColumnSpec<T, Given, NoInfer<DefaultR>, NoInfer<UpdateR>> => ({ _tag: "MysqlColumnSpec", type, options })

export type ColumnInput = CHType<string, any, any> | ColumnSpec<CHType<string, any, any>, any, any, any>

/** The query-side column types of a `columns` record. */
export type ColumnsOf<I extends Record<string, ColumnInput>> = {
	readonly [K in keyof I]: I[K] extends ColumnSpec<infer T, any, any, any> ? T : I[K] extends CHType<string, any, any> ? I[K] : never
}

/** Columns declared with `default`, `defaultExpr`, `defaultFn` or `onUpdate`: an insert may leave them out. */
export type DefaultedColumnsOf<I extends Record<string, ColumnInput>> = {
	[K in keyof I]: I[K] extends ColumnSpec<any, infer Given, any, any>
		? [Exclude<Given, "name" | "unique">] extends [never]
			? never
			: K
		: never
}[keyof I] &
	string

/**
 * What an insert into a table with these columns requires: each `defaultFn`'s
 * requirements, or the `onUpdate`'s of a column without one.
 */
export type InsertRequirementsOf<I extends Record<string, ColumnInput>> = {
	[K in keyof I]: I[K] extends ColumnSpec<any, infer Given, infer DefaultR, infer UpdateR>
		? "defaultFn" extends Given
			? DefaultR
			: UpdateR
		: never
}[keyof I]

/** What an update of a table with these columns requires: each `onUpdate`'s requirements. */
export type UpdateRequirementsOf<I extends Record<string, ColumnInput>> = {
	[K in keyof I]: I[K] extends ColumnSpec<any, any, any, infer UpdateR> ? UpdateR : never
}[keyof I]

const isColumnSpec = (input: unknown): input is ColumnSpec<CHType<string, any, any>, any, any, any> =>
	typeof input === "object" && input !== null && "_tag" in input && input._tag === "MysqlColumnSpec"

/** The query-side type of a column input, carrying its database name as `sqlName`. */
const columnTypeOfInput = (key: string, input: ColumnInput, casing: Casing | undefined): CHType<string, any, any> =>
	isColumnSpec(input) ? namedColumnType(key, input.type, input.options.name, casing) : namedColumnType(key, input, undefined, casing)

// Indexes

export interface IndexSpec<Cols extends ColumnDefs> {
	readonly _tag: "MysqlIndexSpec"
	readonly name: string
	readonly unique: boolean
	/** Columns only: MariaDB has no index on an expression. */
	readonly on: ReadonlyArray<keyof Cols & string>
}

/** An index on columns: `index("t_org", ["orgId"])`. */
export const index = <Cols extends ColumnDefs>(name: string, on: ReadonlyArray<keyof Cols & string>): IndexSpec<Cols> => ({
	_tag: "MysqlIndexSpec",
	name,
	unique: false,
	on,
})

/** A unique index. */
export const uniqueIndex = <Cols extends ColumnDefs>(name: string, on: ReadonlyArray<keyof Cols & string>): IndexSpec<Cols> => ({
	_tag: "MysqlIndexSpec",
	name,
	unique: true,
	on,
})

/** MySQL's limit on table, column, index and constraint names. */
const MAX_NAME = 64

/** A name MySQL accepts: a plain identifier, at most 64 characters. */
const checkName = (problems: ProblemSink, object: string, name: string): void => {
	checkIdentifier(problems, object, name)
	if (name.length > MAX_NAME) problems.push({ object, message: `${JSON.stringify(name)} is ${name.length} characters; MySQL allows ${MAX_NAME}` })
}

/** A literal MySQL writes as a DEFAULT as it is: a number, a quoted string, TRUE / FALSE or a hex string. */
const SIMPLE_LITERAL = /^(-?\d+(\.\d+)?(e[+-]?\d+)?|'(?:[^'\\]|\\[\s\S])*'|TRUE|FALSE|X'[0-9a-f]*')$/i

const columnDefault = (
	problems: ProblemSink,
	table: string,
	name: string,
	spec: ColumnSpec<CHType<string, any, any>, any, any, any>,
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
		if (typeof options.defaultExpr === "string") return options.defaultExpr
		// A default that reads another column depends on declaration order; keep defaults constant.
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
			problems.push({ object: `${table}.${name}`, message: `defaultExpr reads ${[...new Set(read)].join(", ")}; a default must be constant` })
		}
		return `(${sql})`
	}
	if (options.default === undefined || options.default === null) return null
	const literal =
		typeof options.default === "boolean" ? (options.default ? "TRUE" : "FALSE") : withDialect(mysqlDialect, () => encodeColumnLiteral(spec.type, options.default, name))
	// MySQL takes no literal DEFAULT on TEXT, BLOB or JSON; an expression in parentheses it does.
	return SIMPLE_LITERAL.test(literal) && !isMysqlLobType(spec.type.sql) ? literal : `(${literal})`
}

/** Bytes a key part can take in an index, for the types that have a declared length; `undefined` for the rest. */
const keyBytes = (type: string): number | undefined => {
	const match = /^(var)?(char|binary)\((\d+)\)/.exec(type)
	if (match === null) return undefined
	// utf8mb4 takes up to four bytes a character.
	return Number(match[3]) * (match[2] === "char" ? 4 : 1)
}

/** InnoDB's limit on an index key, with the default DYNAMIC row format. */
const MAX_KEY_BYTES = 3072

/**
 * The columns of a key (primary key, index, UNIQUE): TEXT, BLOB and JSON need
 * a prefix length MySQL cannot take from a column list, and the key must fit
 * InnoDB's 3072 bytes.
 */
const checkKey = (problems: ProblemSink, object: string, columns: ReadonlyArray<MysqlColumnEntity>): void => {
	for (const column of columns) {
		if (isMysqlLobType(column.type)) {
			problems.push({ object, message: `${column.name} is ${column.type}, which MySQL cannot index without a prefix length; use varchar(n)` })
		}
	}
	const bytes = columns.reduce((sum, column) => sum + (keyBytes(column.type) ?? 0), 0)
	if (bytes > MAX_KEY_BYTES) problems.push({ object, message: `the key takes up to ${bytes} bytes; InnoDB allows ${MAX_KEY_BYTES}` })
}

// Tables

export interface TableDefinition<Columns extends Record<string, ColumnInput>> {
	readonly columns: Columns
	readonly primaryKey?: ReadonlyArray<keyof Columns & string>
	readonly indexes?: ReadonlyArray<IndexSpec<ColumnsOf<Columns>>>
	/** The column carrying row-level tenancy; see docs/tenant-scoping.md. */
	readonly tenantColumn?: keyof Columns & string
	/** Database names for the columns that give no `name`: `"snake_case"` stores `orgId` as `org_id`. */
	readonly casing?: Casing
}

/** A table this schema does not own: a view, or one another tool migrates. No DDL. */
export interface ExternalTableDefinition<Columns extends Record<string, ColumnInput>> {
	readonly external: true
	readonly columns: Columns
	readonly tenantColumn?: keyof Columns & string
	readonly casing?: Casing
}

/** The DDL a MySQL table carries, as entities. */
export interface TableDdl {
	readonly dialect: "mysql"
	readonly table: MysqlTableEntity
	readonly columns: ReadonlyArray<MysqlColumnEntity>
	readonly indexes: ReadonlyArray<MysqlIndexEntity>
	readonly uniques: ReadonlyArray<MysqlUniqueEntity>
}

export interface MysqlSchemaTable<
	Name extends string,
	Cols extends ColumnDefs,
	Defaulted extends string = string,
	InsertR = never,
	UpdateR = never,
> extends Table<Name, Cols, Defaulted, never, InsertR, UpdateR> {
	readonly ddl: TableDdl
	/** What is wrong with the definition; `mysqlEntitiesOf` fails when any table has one. */
	readonly problems: ReadonlyArray<DefinitionProblem>
}

/** Is `definition` a `{ columns, ... }` definition, rather than a record of columns? */
export const isTableDefinition = (definition: object): definition is { readonly columns: Record<string, unknown> } => {
	if (!("columns" in definition)) return false
	const columns = definition.columns
	return typeof columns === "object" && columns !== null && !("sql" in columns && "schema" in columns)
}

export const externalMysqlTable = <const Name extends string>(
	name: Name,
	definition: ExternalTableDefinition<Record<string, ColumnInput>>,
): Table<Name, any, any, any> => {
	const external = externalTable(name, definition, isColumnSpec, [])
	const clientDefaults = clientDefaultsOfColumns(definition.columns)
	return clientDefaults === undefined ? external : { ...external, clientDefaults }
}

/** The client defaults of a `columns` record; see `clientDefaultsOf`. */
const clientDefaultsOfColumns = (columns: Record<string, ColumnInput>): ClientDefaults | undefined =>
	clientDefaultsOf(
		Object.entries(columns).flatMap(([column, input]) => {
			if (!isColumnSpec(input)) return []
			const { defaultFn, onUpdate, default: literal, defaultExpr } = input.options
			return [[column, { defaultFn, onUpdate, databaseDefault: literal !== undefined || defaultExpr !== undefined }] as const]
		}),
	)

/**
 * A MySQL table with its DDL. The value IS a query `Table`.
 *
 * A column is `NOT NULL` unless its type is `MySQL.nullable(...)`.
 */
export const mysqlTable = <const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: TableDefinition<Columns>,
): MysqlSchemaTable<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>> => withRenderProblems(name, () => buildTable(name, definition))

function buildTable<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: TableDefinition<Columns>,
): MysqlSchemaTable<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>> {
	const problems: ProblemSink = []
	checkName(problems, name, name)
	const inputs = Object.entries(definition.columns)
	if (inputs.length === 0) problems.push({ object: name, message: "a table needs columns" })
	const types = Object.fromEntries(
		inputs.map(([column, input]) => [column, columnTypeOfInput(column, input, definition.casing)]),
	) as ColumnsOf<Columns>
	const sqlName = (column: string) => columnSqlName(types, column)
	const has = (column: string) => Object.hasOwn(types, column)

	const columnEntities = inputs.map(([column, input], position): MysqlColumnEntity => {
		checkName(problems, `${name}.${column}`, sqlName(column))
		const spec: ColumnSpec<CHType<string, any, any>, any, any, any> = isColumnSpec(input)
			? input
			: { _tag: "MysqlColumnSpec", type: input as CHType<string, any, any>, options: {} }
		return {
			kind: "column",
			table: name,
			name: sqlName(column),
			position,
			type: canonicalMysqlType(spec.type.sql),
			notNull: spec.type._tag !== "Nullable",
			default: columnDefault(problems, name, column, spec, types),
		}
	})
	const entityOf = (column: string) => columnEntities.find((c) => c.name === sqlName(column))!

	// MySQL compares column names without case, so `Id` and `id` are one column.
	checkDistinctNames(problems, name, inputs.map(([column]) => [column, sqlName(column)] as const), { ignoreCase: true })

	const pkColumns = definition.primaryKey ?? []
	checkNoRepeats(problems, `${name} primary key`, pkColumns)
	if (definition.primaryKey !== undefined) {
		if (pkColumns.length === 0) problems.push({ object: name, message: "a primary key needs columns" })
		for (const column of pkColumns) {
			if (!has(column)) problems.push({ object: `${name} primary key`, message: `${column} is not a column` })
			else if (!entityOf(column).notNull) {
				problems.push({ object: `${name}.${column}`, message: "a primary key column cannot be nullable; MySQL would make it NOT NULL" })
			}
		}
		checkKey(problems, `${name} primary key`, pkColumns.filter(has).map(entityOf))
	}

	// Indexes and UNIQUE constraints share the table's index namespace, without case; PRIMARY is the key's.
	const keyNames = new Map<string, string>()
	const claim = (object: string, keyName: string) => {
		checkName(problems, object, keyName)
		const other = keyNames.get(keyName.toLowerCase())
		if (keyName.toLowerCase() === "primary") problems.push({ object, message: "PRIMARY names the primary key in MySQL" })
		else if (other !== undefined) problems.push({ object, message: `${JSON.stringify(keyName)} also names ${other}; a table's indexes and UNIQUE constraints share one namespace` })
		keyNames.set(keyName.toLowerCase(), object)
	}

	const indexEntities: ReadonlyArray<MysqlIndexEntity> = (definition.indexes ?? []).map((spec): MysqlIndexEntity => {
		const object = `${name} index ${spec.name}`
		claim(object, spec.name)
		checkNoRepeats(problems, object, spec.on)
		for (const column of spec.on) {
			if (!has(column)) problems.push({ object, message: `${column} is not a column` })
		}
		if (spec.on.length === 0) problems.push({ object, message: "an index needs columns" })
		checkKey(problems, object, spec.on.filter(has).map(entityOf))
		return { kind: "index", table: name, name: spec.name, unique: spec.unique, columns: ddl.keyParts(spec.on.filter(has), types) }
	})

	const uniqueEntities: Array<MysqlUniqueEntity> = []
	for (const [column, input] of inputs) {
		const option = isColumnSpec(input) ? input.options.unique : undefined
		if (option === undefined) continue
		const uniqueName = option === true ? `${name}_${sqlName(column)}_unique` : option
		const object = `${name}.${column} unique`
		claim(object, uniqueName)
		checkKey(problems, object, [entityOf(column)])
		uniqueEntities.push({ kind: "unique", table: name, name: uniqueName, columns: [sqlName(column)] })
	}

	const tableEntity: MysqlTableEntity = {
		kind: "table",
		name,
		primaryKey: definition.primaryKey === undefined ? null : { columns: pkColumns.filter(has).map(sqlName) },
	}
	const defaults = inputs.filter((_, position) => columnEntities[position]!.default !== null).map(([column]) => column)
	const clientDefaults = clientDefaultsOfColumns(definition.columns)
	return {
		_tag: "Table",
		name,
		columns: types,
		...(definition.tenantColumn !== undefined ? { tenantColumn: definition.tenantColumn } : undefined),
		...(defaults.length > 0 ? { defaults: defaults as unknown as Array<DefaultedColumnsOf<Columns>> } : undefined),
		...(clientDefaults !== undefined ? { clientDefaults } : undefined),
		ddl: { dialect: "mysql", table: tableEntity, columns: columnEntities, indexes: indexEntities, uniques: uniqueEntities },
		problems,
	}
}

/**
 * The entities of a set of MySQL tables, validated as one schema: no two
 * tables share a name, compared without case (as MySQL does on macOS and
 * Windows, and with `lower_case_table_names`). Fails with every problem found.
 */
export const mysqlEntitiesOf = (
	tables: ReadonlyArray<MysqlSchemaTable<string, any>>,
): Effect.Effect<ReadonlyArray<MysqlSchemaEntity>, SchemaDefinitionError> => {
	const problems: ProblemSink = []
	const entities: Array<MysqlSchemaEntity> = []
	const names = new Map<string, string>()
	for (const table of tables) {
		if (!("ddl" in table) || (table.ddl as { dialect?: string }).dialect !== "mysql") {
			problems.push({ object: table.name, message: "is not a MySQL table with DDL; declare it with MySQL.table(name, { columns })" })
			continue
		}
		problems.push(...table.problems)
		const { ddl } = table
		const other = names.get(ddl.table.name.toLowerCase())
		if (other !== undefined) problems.push({ object: ddl.table.name, message: `names the same table as ${other}` })
		names.set(ddl.table.name.toLowerCase(), ddl.table.name)
		entities.push(ddl.table, ...ddl.columns, ...ddl.indexes, ...ddl.uniques)
	}
	return problems.length > 0 ? Effect.fail(definitionError(problems)) : Effect.succeed(sortEntities(entities))
}
