// Postgres schema definitions: `table` from `/postgres` and its column, index and foreign
// key helpers.
//
// The Postgres counterpart of the ClickHouse `table`: the value IS a `Table`, so every
// query API accepts it, and its DDL rides beside it on `ddl` as Postgres
// entities. Expressions are written with the query DSL (or as SQL strings) and
// rendered once, here, with the Postgres dialect. A definition that cannot
// become DDL records a problem, and `pgEntitiesOf` fails with it.

import { compile as compileFragment } from "../sql/sql-fragment"
import { withDialect } from "../ch/dialect"
import type { Condition, Expr } from "../ch/expr"
import { encodeColumnLiteral } from "../ch/literal"
import { createColumnAccessor, type ColumnAccessor } from "../ch/query"
import type { Table } from "../ch/table"
import type { CHType, ColumnDefs, InferTS } from "../ch/types"
import { postgresDialect } from "../pg/dialect"
import { externalTable, type DdlExpr, type DdlKey } from "./define"
import type { DefinitionProblem, ProblemSink } from "./problems"
import {
	canonicalPgType,
	PG_MAX_IDENTIFIER,
	type PgColumnEntity,
	type PgForeignKeyEntity,
	type PgIdentity,
	type PgIndexEntity,
	type PgReferentialAction,
	type PgTableEntity,
} from "./pg-entities"

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`

const renderValue = (value: Expr<any> | Condition | string): string =>
	typeof value === "string" ? value : withDialect(postgresDialect, () => compileFragment(value.toFragment()))

/** A partial index's predicate: SQL, or a condition built with the DSL. */
export type DdlPredicate<Cols extends ColumnDefs> = string | (($: ColumnAccessor<Cols>) => Condition | Expr<any> | string)

const renderExpr = <Cols extends ColumnDefs>(expr: DdlExpr<Cols> | DdlPredicate<Cols>, columns: Cols): string =>
	typeof expr === "string" ? expr : renderValue(expr(createColumnAccessor(columns)))

/** Key parts: a column name is written quoted, an expression as it renders. */
const renderKeyParts = <Cols extends ColumnDefs>(key: DdlKey<Cols>, columns: Cols): ReadonlyArray<string> =>
	typeof key === "function" ? key(createColumnAccessor(columns)).map(renderValue) : key.map(quoteIdent)

// Columns

export interface ColumnOptions<T extends CHType<string, any, any>> {
	/** A literal default, encoded through the column's own type. */
	readonly default?: InferTS<T>
	/** `DEFAULT <expr>`, for a computed default such as `"now()"`. */
	readonly defaultExpr?: DdlExpr<ColumnDefs>
	/**
	 * An identity column, numbered by its own sequence. An insert may leave it
	 * out; with `"always"`, Postgres also rejects an insert that gives it.
	 */
	readonly identity?: PgIdentity
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
	[K in keyof I]: I[K] extends ColumnSpec<any, infer Given> ? ([Given] extends [never] ? never : K) : never
}[keyof I] &
	string

const isColumnSpec = (input: ColumnInput): input is ColumnSpec<CHType<string, any, any>, any> =>
	"_tag" in input && input._tag === "PgColumnSpec"

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
}): ForeignKeySpec<Column> => ({
	_tag: "PgForeignKeySpec",
	columns: spec.columns,
	references: typeof spec.references === "string" ? spec.references : spec.references.name,
	foreignColumns: spec.foreignColumns,
	onDelete: (spec.onDelete?.toUpperCase() ?? "NO ACTION") as PgReferentialAction,
	onUpdate: (spec.onUpdate?.toUpperCase() ?? "NO ACTION") as PgReferentialAction,
	name: spec.name,
})

// Tables

export interface TableDefinition<Columns extends Record<string, ColumnInput>> {
	readonly columns: Columns
	/** Column names, or with a constraint name. The default name is `<table>_pkey`, Postgres's own. */
	readonly primaryKey?:
		| ReadonlyArray<keyof Columns & string>
		| { readonly columns: ReadonlyArray<keyof Columns & string>; readonly name?: string }
	readonly indexes?: ReadonlyArray<IndexSpec<ColumnsOf<Columns>>>
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
	readonly foreignKeys: ReadonlyArray<PgForeignKeyEntity>
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
		return externalTable(name, definition, (input): input is ColumnSpec<CHType<string, any, any>> => isColumnSpec(input as ColumnInput), [])
	}
	const problems: ProblemSink = []
	checkIdentifier(problems, name, name)
	const inputs = Object.entries(definition.columns)
	if (inputs.length === 0) problems.push({ object: name, message: "a table needs columns" })
	const types = Object.fromEntries(
		inputs.map(([column, input]) => [column, isColumnSpec(input) ? input.type : input]),
	) as ColumnsOf<Columns>
	const has = (column: string) => Object.hasOwn(types, column)

	const columnEntities = inputs.map(([column, input], position): PgColumnEntity => {
		checkIdentifier(problems, `${name}.${column}`, column)
		const spec: ColumnSpec<CHType<string, any, any>> = isColumnSpec(input)
			? input
			: { _tag: "PgColumnSpec", type: input as CHType<string, any, any>, options: {} }
		return {
			kind: "column",
			table: name,
			name: column,
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

	const pk = definition.primaryKey
	const pkColumns = pk === undefined ? [] : "columns" in pk ? pk.columns : pk
	const pkName = pk !== undefined && "columns" in pk && pk.name !== undefined ? pk.name : `${name}_pkey`
	if (pk !== undefined) {
		checkIdentifier(problems, `${name} primary key`, pkName)
		if (pkColumns.length === 0) problems.push({ object: name, message: "a primary key needs columns" })
		for (const column of pkColumns) {
			if (!has(column)) problems.push({ object: `${name} primary key`, message: `${column} is not a column` })
			if (columnEntities.find((c) => c.name === column)?.notNull === false) {
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

	const foreignKeyEntities = (definition.foreignKeys ?? []).map((spec): PgForeignKeyEntity => {
		const fkName = spec.name ?? defaultForeignKeyName(name, spec.columns, spec.references, spec.foreignColumns)
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
			columns: [...spec.columns],
			foreignTable: spec.references,
			foreignColumns: [...spec.foreignColumns],
			onDelete: spec.onDelete,
			onUpdate: spec.onUpdate,
		}
	})

	const tableEntity: PgTableEntity = {
		kind: "table",
		name,
		primaryKey: pk === undefined ? null : { name: pkName, columns: [...pkColumns] },
	}
	const defaults = columnEntities.filter((c) => c.default !== null || c.identity !== null).map((c) => c.name)
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
			foreignKeys: foreignKeyEntities,
		},
		problems,
	}
}
