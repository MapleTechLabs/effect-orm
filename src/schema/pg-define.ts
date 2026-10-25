// Postgres schema definitions: `table` from `/postgres` and its column, index,
// unique constraint and foreign key helpers, and `enumType`.
//
// The Postgres counterpart of the ClickHouse `table`: the value IS a `Table`, so every
// query API accepts it, and its DDL rides beside it on `ddl` as Postgres
// entities. Expressions are written with the query DSL (or as SQL strings) and
// rendered once, here, with the Postgres dialect. A definition that cannot
// become DDL records a problem, and `pgEntitiesOf` fails with it.

import { Schema } from "effect"
import { withDialect } from "../ch/dialect"
import { encodeColumnLiteral } from "../ch/literal"
import type { Table } from "../ch/table"
import { columnSqlName, type CHType, type ColumnDefs, type InferTS } from "../ch/types"
import type { PgType } from "../pg/types"
import { postgresDialect } from "../pg/dialect"
import { ddlRenderer, type DdlPredicate } from "./ddl-expr"
import { externalTable, type DdlExpr, type DdlKey } from "./define"
import { checkDistinctNames, checkNoRepeats, withRenderProblems, type DefinitionProblem, type ProblemSink } from "./problems"
import {
	canonicalPgType,
	PG_MAX_IDENTIFIER,
	pgTypeName,
	type PgColumnEntity,
	type PgEnumEntity,
	type PgForeignKeyEntity,
	type PgIdentity,
	type PgIndexEntity,
	type PgReferentialAction,
	type PgTableEntity,
	type PgUniqueEntity,
} from "./pg-entities"

const ddl = ddlRenderer(postgresDialect)
const renderExpr = ddl.expr
const renderKeyParts = ddl.keyParts

export type { DdlPredicate }

// Columns

export interface ColumnOptions<T extends CHType<string, any, any>> {
	/**
	 * The column's name in the database, when it differs from its key in
	 * `columns`: `orgId: PG.column(PG.text, { name: "org_id" })` is read and
	 * written as `$.orgId` and stored as `org_id`.
	 */
	readonly name?: string
	/** A literal default, encoded through the column's own type. */
	readonly default?: InferTS<T>
	/** `DEFAULT <expr>`, for a computed default such as `"now()"`. */
	readonly defaultExpr?: DdlExpr<ColumnDefs>
	/**
	 * An identity column, numbered by its own sequence. An insert may leave it
	 * out; with `"always"`, Postgres also rejects an insert that gives it.
	 */
	readonly identity?: PgIdentity
	/**
	 * A one-column `UNIQUE` constraint. `true` names it
	 * `<table>_<column>_unique`, drizzle-orm's name; a string names it.
	 */
	readonly unique?: true | string | UniqueColumnOptions
}

export interface UniqueColumnOptions {
	/** Default `<table>_<column>_unique`. */
	readonly name?: string
	/** `NULLS NOT DISTINCT` (Postgres 15+). */
	readonly nullsNotDistinct?: boolean
}

/** `Given` records which options were set, so the table knows which columns an insert may leave out. */
export interface ColumnSpec<
	T extends CHType<string, any, any>,
	Given extends keyof ColumnOptions<T> = keyof ColumnOptions<T>,
> {
	readonly _tag: "PgColumnSpec"
	readonly type: T
	readonly options: ColumnOptions<T>
	readonly _given?: Given
}

/** A column with a default. A bare column type works too where none is needed. */
export const column = <T extends CHType<string, any, any>, Given extends keyof ColumnOptions<T> = never>(
	type: T,
	options: ColumnOptions<T> & { readonly [K in Given]: unknown } = {} as ColumnOptions<T> & {
		readonly [K in Given]: unknown
	},
): ColumnSpec<T, Given> => ({ _tag: "PgColumnSpec", type, options })

export type ColumnInput = CHType<string, any, any> | ColumnSpec<CHType<string, any, any>, any>

/** The query-side column types of a `columns` record. */
export type ColumnsOf<I extends Record<string, ColumnInput>> = {
	readonly [K in keyof I]: I[K] extends ColumnSpec<infer T, any> ? T : I[K] extends CHType<string, any, any> ? I[K] : never
}

/** Columns declared with `default`, `defaultExpr` or `identity`: an insert may leave them out. */
export type DefaultedColumnsOf<I extends Record<string, ColumnInput>> = {
	[K in keyof I]: I[K] extends ColumnSpec<any, infer Given>
		? [Exclude<Given, "name" | "unique">] extends [never]
			? never
			: K
		: never
}[keyof I] &
	string

const isColumnSpec = (input: ColumnInput): input is ColumnSpec<CHType<string, any, any>, any> =>
	"_tag" in input && input._tag === "PgColumnSpec"

/** The query-side type of a column input, carrying its `name` as `sqlName`. */
export const columnTypeOfInput = (input: ColumnInput): CHType<string, any, any> => {
	if (!isColumnSpec(input)) return input
	return input.options.name === undefined ? input.type : { ...input.type, sqlName: input.options.name }
}

// Indexes and foreign keys

export interface IndexOptions<Cols extends ColumnDefs> {
	/** A partial index: only rows this predicate holds for are indexed. */
	readonly where?: DdlPredicate<Cols>
	/** The access method. Default `btree`. */
	readonly using?: string
}

export interface IndexSpec<Cols extends ColumnDefs> {
	readonly _tag: "PgIndexSpec"
	readonly name: string
	readonly unique: boolean
	readonly on: DdlKey<Cols>
	readonly options: IndexOptions<Cols>
}

/** An index on columns or expressions: `index("t_org_idx", ["org_id"])`, or a callback building expressions. */
export const index = <Cols extends ColumnDefs>(
	name: string,
	on: DdlKey<Cols>,
	options: IndexOptions<Cols> = {},
): IndexSpec<Cols> => ({ _tag: "PgIndexSpec", name, unique: false, on, options })

/** A unique index. With `where`, a partial unique index: at most one matching row per key. */
export const uniqueIndex = <Cols extends ColumnDefs>(
	name: string,
	on: DdlKey<Cols>,
	options: IndexOptions<Cols> = {},
): IndexSpec<Cols> => ({ _tag: "PgIndexSpec", name, unique: true, on, options })

/** Referential actions, written as drizzle writes them or as the catalog does. */
export type ReferentialAction =
	| PgReferentialAction
	| "no action"
	| "restrict"
	| "cascade"
	| "set null"
	| "set default"

export interface ForeignKeySpec<Column extends string> {
	readonly _tag: "PgForeignKeySpec"
	readonly columns: ReadonlyArray<Column>
	readonly references: string
	readonly foreignColumns: ReadonlyArray<string>
	readonly onDelete: PgReferentialAction
	readonly onUpdate: PgReferentialAction
	readonly name: string | undefined
}

/**
 * A foreign key. `references` is the referenced table (a `Table`, so its
 * columns are checked) or its name, for a table that references itself.
 */
export const foreignKey = <const Column extends string, FCols extends ColumnDefs = ColumnDefs>(spec: {
	readonly columns: ReadonlyArray<Column>
	readonly references: Table<string, FCols, any, any> | string
	readonly foreignColumns: ReadonlyArray<keyof FCols & string>
	readonly onDelete?: ReferentialAction
	readonly onUpdate?: ReferentialAction
	/** Default `<table>_<columns>_<foreign table>_<foreign columns>_fk`, the name drizzle-kit gives. */
	readonly name?: string
}): ForeignKeySpec<Column> => {
	const references = spec.references
	return {
		_tag: "PgForeignKeySpec",
		columns: spec.columns,
		references: typeof references === "string" ? references : references.name,
		foreignColumns:
			typeof references === "string"
				? spec.foreignColumns
				: spec.foreignColumns.map((column) => columnSqlName(references.columns, column)),
		onDelete: (spec.onDelete?.toUpperCase() ?? "NO ACTION") as PgReferentialAction,
		onUpdate: (spec.onUpdate?.toUpperCase() ?? "NO ACTION") as PgReferentialAction,
		name: spec.name,
	}
}

export interface UniqueOptions {
	/** `NULLS NOT DISTINCT` (Postgres 15+): rows whose keys hold nulls conflict too. */
	readonly nullsNotDistinct?: boolean
}

export interface UniqueSpec<Column extends string> {
	readonly _tag: "PgUniqueSpec"
	readonly name: string
	readonly columns: ReadonlyArray<Column>
	readonly options: UniqueOptions
}

/**
 * A `UNIQUE` constraint: `ALTER TABLE ... ADD CONSTRAINT name UNIQUE (columns)`,
 * what drizzle-kit writes for `unique()`. Postgres backs it with a unique index
 * of the same name, but it is a constraint: drop it with `DROP CONSTRAINT`, and
 * name it in `onConflictDoNothing({ target: { constraint } })`.
 */
export const unique = <const Column extends string>(
	name: string,
	columns: ReadonlyArray<Column>,
	options: UniqueOptions = {},
): UniqueSpec<Column> => ({ _tag: "PgUniqueSpec", name, columns, options })

// Enums

export interface EnumOptions {
	/** The schema the type lives in. Omit it for the schema the migrations run in. */
	readonly schema?: string
}

/**
 * A Postgres enum type. It is a column type (rows decode to `Values`, and
 * inserts and comparisons take only its labels) and a schema object
 * (`generate` creates and alters the type, before any table that uses it).
 */
export interface PgEnum<Values extends string = string, Name extends string = string> extends PgType<"PgEnum", Values, string> {
	/** The type's name, without its schema. */
	readonly name: Name
	/** The labels, in sort order. */
	readonly values: ReadonlyArray<Values>
	readonly ddl: { readonly dialect: "postgres"; readonly enum: PgEnumEntity }
	/** What is wrong with the definition; `pgEntitiesOf` fails when any object has one. */
	readonly problems: ReadonlyArray<DefinitionProblem>
}

/**
 * `CREATE TYPE name AS ENUM (values...)`: `PG.enumType("channel_type", ["public", "private"])`.
 * Use it as a column type, bare or in `PG.column`, `PG.nullable` and `PG.array`,
 * and export it from a schema module, or let the tables that use it bring it.
 */
export const enumType = <const Name extends string, const Values extends readonly [string, ...Array<string>]>(
	name: Name,
	values: Values,
	options: EnumOptions = {},
): PgEnum<Values[number], Name> => {
	const schema = options.schema ?? null
	const entity: PgEnumEntity = { kind: "enum", schema, name, values: [...values] }
	const literals = Schema.Literals(values) as unknown as Schema.Codec<Values[number], string>
	return {
		_tag: "PgEnum",
		sql: pgTypeName(schema, name),
		schema: literals,
		literalSchema: literals as Schema.Codec<unknown, unknown>,
		name,
		values: [...values],
		ddl: { dialect: "postgres", enum: entity },
		problems: enumProblems(entity),
	}
}

/** What is wrong with an enum: its names, and labels that are empty, repeated or too long. */
export const enumProblems = (entity: PgEnumEntity): ReadonlyArray<DefinitionProblem> => {
	const problems: ProblemSink = []
	const object = entity.schema === null ? entity.name : `${entity.schema}.${entity.name}`
	checkIdentifier(problems, object, entity.name)
	if (entity.schema !== null) checkIdentifier(problems, object, entity.schema)
	if (entity.values.length === 0) problems.push({ object, message: "an enum needs at least one value" })
	const seen = new Set<string>()
	for (const value of entity.values) {
		if (seen.has(value)) problems.push({ object, message: `${JSON.stringify(value)} is listed twice` })
		seen.add(value)
		if (value.length === 0) problems.push({ object, message: "a label cannot be empty" })
		if (new TextEncoder().encode(value).length > PG_MAX_IDENTIFIER) {
			problems.push({ object, message: `${JSON.stringify(value)} is longer than ${PG_MAX_IDENTIFIER} bytes, the most a label holds` })
		}
	}
	return problems
}

const isPgEnum = (type: CHType<string, any, any>): type is PgEnum => type._tag === "PgEnum" && "ddl" in type

/** The enum a column type is, or holds through `nullable` / `array`. */
export const enumOfType = (type: CHType<string, any, any>): PgEnum | undefined => {
	for (let t: CHType<string, any, any> | undefined = type; t !== undefined; t = t.element) {
		if (isPgEnum(t)) return t
	}
	return undefined
}

// Tables

export interface TableDefinition<Columns extends Record<string, ColumnInput>> {
	readonly columns: Columns
	/** Column names, or with a constraint name. The default name is `<table>_pkey`, Postgres's own. */
	readonly primaryKey?:
		| ReadonlyArray<keyof Columns & string>
		| { readonly columns: ReadonlyArray<keyof Columns & string>; readonly name?: string }
	readonly indexes?: ReadonlyArray<IndexSpec<ColumnsOf<Columns>>>
	/** `UNIQUE` constraints over several columns; one column can say `unique` in `PG.column`. */
	readonly uniqueConstraints?: ReadonlyArray<UniqueSpec<keyof Columns & string>>
	readonly foreignKeys?: ReadonlyArray<ForeignKeySpec<keyof Columns & string>>
	/** The column carrying row-level tenancy; see docs/tenant-scoping.md. */
	readonly tenantColumn?: keyof Columns & string
}

/** A table this schema does not own: a view, a catalog table, one another tool migrates. No DDL. */
export interface ExternalTableDefinition<Columns extends Record<string, ColumnInput>> {
	readonly external: true
	readonly columns: Columns
	readonly tenantColumn?: keyof Columns & string
}

/** The DDL a Postgres table carries, as entities. */
export interface TableDdl {
	readonly dialect: "postgres"
	readonly table: PgTableEntity
	readonly columns: ReadonlyArray<PgColumnEntity>
	readonly indexes: ReadonlyArray<PgIndexEntity>
	readonly uniques: ReadonlyArray<PgUniqueEntity>
	readonly foreignKeys: ReadonlyArray<PgForeignKeyEntity>
	/** The enum types its columns use, so a schema has them without exporting them. */
	readonly enums: ReadonlyArray<PgEnumEntity>
}

export interface PgSchemaTable<Name extends string, Cols extends ColumnDefs, Defaulted extends string = string>
	extends Table<Name, Cols, Defaulted, never> {
	readonly ddl: TableDdl
	/** What is wrong with the definition; `pgEntitiesOf` fails when any table has one. */
	readonly problems: ReadonlyArray<DefinitionProblem>
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/

const checkIdentifier = (problems: ProblemSink, object: string, name: string): void => {
	if (!IDENTIFIER.test(name)) {
		problems.push({ object, message: `${JSON.stringify(name)} is not a plain identifier ([A-Za-z_][A-Za-z0-9_$]*)` })
	} else if (name.length > PG_MAX_IDENTIFIER) {
		problems.push({ object, message: `${JSON.stringify(name)} is longer than ${PG_MAX_IDENTIFIER} characters, which Postgres would truncate` })
	}
}

const HASH_DICTIONARY = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

/** drizzle-kit's name hash (`dialects/utils.ts`), so a shortened name matches the one it writes. */
const drizzleHash = (input: string, length = 12): string => {
	const base = BigInt(HASH_DICTIONARY.length)
	const modulus = base ** BigInt(length)
	let power = 1n
	let hash = 0n
	for (const ch of input) {
		hash = (hash + BigInt(ch.codePointAt(0) ?? 0) * power) % modulus
		power = (power * 53n) % modulus
	}
	const out: Array<string> = []
	for (let i = 0; i < length; i++) {
		out.unshift(HASH_DICTIONARY[Number(hash % base)]!)
		hash /= base
	}
	return out.join("")
}

/**
 * `<table>_<columns>_<foreign table>_<foreign columns>_fk`, drizzle-orm's name.
 * Over 63 characters, Postgres would truncate it, so it is shortened the way
 * drizzle-kit shortens its own: `<table>_<hash>_fk`, or `<hash>_fk` for a
 * table name of 45 characters or more.
 */
export const defaultForeignKeyName = (
	table: string,
	columns: ReadonlyArray<string>,
	foreignTable: string,
	foreignColumns: ReadonlyArray<string>,
): string => {
	const desired = `${table}_${columns.join("_")}_${foreignTable}_${foreignColumns.join("_")}_fk`
	if (desired.length <= PG_MAX_IDENTIFIER) return desired
	return table.length < 45 ? `${table}_${drizzleHash(desired)}_fk` : `${drizzleHash(desired)}_fk`
}

/** `TRUE` is how the dialect writes a literal; the catalog and drizzle-kit write `true`. */
const lowerKeywords = (sql: string): string => (/^(TRUE|FALSE|NULL)$/.test(sql) ? sql.toLowerCase() : sql)

const columnDefault = (
	problems: ProblemSink,
	table: string,
	name: string,
	spec: ColumnSpec<CHType<string, any, any>>,
	columns: ColumnDefs,
): string | null => {
	const { options } = spec
	const given = [options.default !== undefined, options.defaultExpr !== undefined, options.identity !== undefined].filter(Boolean)
	if (given.length > 1) {
		problems.push({ object: `${table}.${name}`, message: "a column takes one of default, defaultExpr, identity" })
	}
	if (options.defaultExpr !== undefined) return renderExpr(options.defaultExpr, columns)
	if (options.default === undefined || options.default === null) return null
	const literal = withDialect(postgresDialect, () => encodeColumnLiteral(spec.type, options.default, name))
	return lowerKeywords(literal)
}

/**
 * A Postgres table with its DDL. The value IS a query `Table`; `generate`
 * reads its `ddl` when the config's dialect is `postgres`.
 *
 * A column is `NOT NULL` unless its type is `PG.nullable(...)`.
 */
export function table<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: ExternalTableDefinition<Columns>,
): Table<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>, never>
export function table<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: TableDefinition<Columns>,
): PgSchemaTable<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>>
export function table<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: TableDefinition<Columns> | ExternalTableDefinition<Columns>,
): PgSchemaTable<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>> | Table<Name, any, any, any> {
	if ("external" in definition) {
		return externalTable(
			name,
			definition,
			(input): input is ColumnSpec<CHType<string, any, any>> => isColumnSpec(input as ColumnInput),
			[],
			(spec) => columnTypeOfInput(spec as ColumnSpec<CHType<string, any, any>>),
		)
	}
	return withRenderProblems(name, () => buildTable(name, definition))
}

function buildTable<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: TableDefinition<Columns>,
): PgSchemaTable<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>> {
	const problems: ProblemSink = []
	checkIdentifier(problems, name, name)
	const inputs = Object.entries(definition.columns)
	if (inputs.length === 0) problems.push({ object: name, message: "a table needs columns" })
	const types = Object.fromEntries(inputs.map(([column, input]) => [column, columnTypeOfInput(input)])) as ColumnsOf<Columns>
	const sqlName = (column: string) => columnSqlName(types, column)
	const has = (column: string) => Object.hasOwn(types, column)

	const columnEntities = inputs.map(([column, input], position): PgColumnEntity => {
		checkIdentifier(problems, `${name}.${column}`, sqlName(column))
		const spec: ColumnSpec<CHType<string, any, any>> = isColumnSpec(input)
			? input
			: { _tag: "PgColumnSpec", type: input as CHType<string, any, any>, options: {} }
		return {
			kind: "column",
			table: name,
			name: sqlName(column),
			position,
			type: canonicalPgType(spec.type.sql),
			notNull: spec.type._tag !== "Nullable",
			default: columnDefault(problems, name, column, spec, types),
			identity: spec.options.identity ?? null,
		}
	})
	for (const column of columnEntities) {
		if (column.identity !== null && !["smallint", "integer", "bigint"].includes(column.type)) {
			problems.push({ object: `${name}.${column.name}`, message: `an identity column must be smallint, integer or bigint, not ${column.type}` })
		}
		if (column.identity !== null && !column.notNull) {
			problems.push({ object: `${name}.${column.name}`, message: "an identity column cannot be nullable" })
		}
	}

	// Postgres refuses these when it runs the DDL ("column specified more than once").
	checkDistinctNames(problems, name, inputs.map(([column]) => [column, sqlName(column)] as const), { ignoreCase: false })

	const pk = definition.primaryKey
	const pkColumns = pk === undefined ? [] : "columns" in pk ? pk.columns : pk
	checkNoRepeats(problems, `${name} primary key`, pkColumns)
	const pkName = pk !== undefined && "columns" in pk && pk.name !== undefined ? pk.name : `${name}_pkey`
	if (pk !== undefined) {
		checkIdentifier(problems, `${name} primary key`, pkName)
		if (pkColumns.length === 0) problems.push({ object: name, message: "a primary key needs columns" })
		for (const column of pkColumns) {
			if (!has(column)) problems.push({ object: `${name} primary key`, message: `${column} is not a column` })
			if (columnEntities.find((c) => c.name === sqlName(column))?.notNull === false) {
				problems.push({
					object: `${name}.${column}`,
					message: "a primary key column cannot be nullable; Postgres would make it NOT NULL anyway",
				})
			}
		}
	}

	const indexEntities = (definition.indexes ?? []).map((spec): PgIndexEntity => {
		checkIdentifier(problems, `${name} index`, spec.name)
		if (Array.isArray(spec.on)) {
			checkNoRepeats(problems, `${name} index ${spec.name}`, spec.on)
			for (const column of spec.on) {
				if (!has(column)) problems.push({ object: `${name} index ${spec.name}`, message: `${column} is not a column` })
			}
		}
		const columns = renderKeyParts(spec.on, types)
		if (columns.length === 0) problems.push({ object: `${name} index ${spec.name}`, message: "an index needs columns" })
		return {
			kind: "index",
			table: name,
			name: spec.name,
			unique: spec.unique,
			method: (spec.options.using ?? "btree").toLowerCase(),
			columns,
			where: spec.options.where === undefined ? null : renderExpr(spec.options.where, types),
		}
	})

	const uniqueEntities: Array<PgUniqueEntity> = []
	for (const [column, input] of inputs) {
		const option = isColumnSpec(input) ? input.options.unique : undefined
		if (option === undefined) continue
		const config: UniqueColumnOptions = option === true ? {} : typeof option === "string" ? { name: option } : option
		const uniqueName = config.name ?? `${name}_${sqlName(column)}_unique`
		checkIdentifier(problems, `${name}.${column} unique`, uniqueName)
		uniqueEntities.push({
			kind: "unique",
			table: name,
			name: uniqueName,
			columns: [sqlName(column)],
			nullsNotDistinct: config.nullsNotDistinct === true,
		})
	}
	for (const spec of definition.uniqueConstraints ?? []) {
		checkIdentifier(problems, `${name} unique`, spec.name)
		for (const column of spec.columns) {
			if (!has(column)) problems.push({ object: `${name} unique ${spec.name}`, message: `${column} is not a column` })
		}
		if (spec.columns.length === 0) problems.push({ object: `${name} unique ${spec.name}`, message: "a unique constraint needs columns" })
		uniqueEntities.push({
			kind: "unique",
			table: name,
			name: spec.name,
			columns: spec.columns.map(sqlName),
			nullsNotDistinct: spec.options.nullsNotDistinct === true,
		})
	}

	const enumEntities = new Map<string, PgEnumEntity>()
	for (const [, input] of inputs) {
		const found = enumOfType(isColumnSpec(input) ? input.type : input)
		if (found !== undefined) enumEntities.set(found.sql, found.ddl.enum)
	}

	const foreignKeyEntities = (definition.foreignKeys ?? []).map((spec): PgForeignKeyEntity => {
		const fkColumns = spec.columns.map(sqlName)
		// A table referencing itself names its own keys; another table's were mapped by `foreignKey`.
		const fkForeignColumns = spec.references === name ? spec.foreignColumns.map(sqlName) : [...spec.foreignColumns]
		const fkName = spec.name ?? defaultForeignKeyName(name, fkColumns, spec.references, fkForeignColumns)
		checkIdentifier(problems, `${name} foreign key`, fkName)
		for (const column of spec.columns) {
			if (!has(column)) problems.push({ object: `${name} foreign key ${fkName}`, message: `${column} is not a column` })
		}
		if (spec.columns.length === 0 || spec.columns.length !== spec.foreignColumns.length) {
			problems.push({
				object: `${name} foreign key ${fkName}`,
				message: "columns and foreignColumns need the same, non-zero, length",
			})
		}
		return {
			kind: "foreign_key",
			table: name,
			name: fkName,
			columns: fkColumns,
			foreignTable: spec.references,
			foreignColumns: fkForeignColumns,
			onDelete: spec.onDelete,
			onUpdate: spec.onUpdate,
		}
	})

	const tableEntity: PgTableEntity = {
		kind: "table",
		name,
		primaryKey: pk === undefined ? null : { name: pkName, columns: pkColumns.map(sqlName) },
	}
	const defaults = inputs
		.filter((_, position) => columnEntities[position]!.default !== null || columnEntities[position]!.identity !== null)
		.map(([column]) => column)
	return {
		_tag: "Table",
		name,
		columns: types,
		...(definition.tenantColumn !== undefined ? { tenantColumn: definition.tenantColumn } : undefined),
		...(defaults.length > 0 ? { defaults: defaults as unknown as Array<DefaultedColumnsOf<Columns>> } : undefined),
		ddl: {
			dialect: "postgres",
			table: tableEntity,
			columns: columnEntities,
			indexes: indexEntities,
			uniques: uniqueEntities,
			foreignKeys: foreignKeyEntities,
			enums: [...enumEntities.values()],
		},
		problems,
	}
}
