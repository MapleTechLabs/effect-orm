// Schema definitions: tables and materialized views that carry their DDL.
//
// `defineTable` returns a value that IS a `Table`, so every query API accepts it
// unchanged; the DDL rides beside it on `ddl`, already normalized into
// entities. Expressions (keys, TTL, defaults, index and view bodies) are
// written with the query DSL and rendered once, here, with the ClickHouse
// dialect. A definition that cannot be rendered is a bug in the definition, so
// it dies as a `SchemaDefinitionDefect` at module load rather than surfacing
// later as a failed migration.

import { Schema } from "effect"
import { compileCHUnsafe } from "../ch/compile"
import { clickhouseDialect, withDialect } from "../ch/dialect"
import type { Expr } from "../ch/expr"
import { encodeColumnLiteral } from "../ch/literal"
import { createColumnAccessor, type CHQuery, type ColumnAccessor } from "../ch/query"
import type { Table } from "../ch/table"
import type { CHType, ColumnDefs, InferTS } from "../ch/types"
import { compile as compileFragment } from "../sql/sql-fragment"
import type {
	ColumnDefault,
	ColumnEntity,
	EngineSpec,
	IndexEntity,
	MaterializedViewEntity,
	TableEntity,
} from "./entities"

/** A schema definition that cannot be turned into DDL. Raised while the module loads. */
export class SchemaDefinitionDefect extends Schema.TaggedError<SchemaDefinitionDefect>()(
	"@maple-dev/effect-orm/SchemaDefinitionDefect",
	{ object: Schema.String, message: Schema.String },
) {}

// Expressions

/** SQL written as a string, or built with the DSL against the table's columns. */
export type DdlExpr<Cols extends ColumnDefs> = string | (($: ColumnAccessor<Cols>) => Expr<any> | string)

/** Column names, or a callback returning expressions. Renders as a key tuple. */
export type DdlKey<Cols extends ColumnDefs> =
	| ReadonlyArray<keyof Cols & string>
	| (($: ColumnAccessor<Cols>) => ReadonlyArray<Expr<any> | string>)

const renderExprValue = (value: Expr<any> | string): string =>
	typeof value === "string" ? value : withDialect(clickhouseDialect, () => compileFragment(value.toFragment()))

const renderExpr = <Cols extends ColumnDefs>(expr: DdlExpr<Cols>, columns: Cols): string =>
	typeof expr === "string" ? expr : renderExprValue(expr(createColumnAccessor(columns)))

const renderKey = <Cols extends ColumnDefs>(key: DdlKey<Cols>, columns: Cols): string => {
	const parts = typeof key === "function" ? key(createColumnAccessor(columns)).map(renderExprValue) : [...key]
	return parts.length === 1 ? parts[0]! : `(${parts.join(", ")})`
}

// Columns

export interface ColumnOptions<T extends CHType<string, any, any>> {
	/** A literal default, encoded through the column's own type. */
	readonly default?: InferTS<T>
	/** `DEFAULT <expr>`, for a computed default. */
	readonly defaultExpr?: DdlExpr<ColumnDefs>
	/** `MATERIALIZED <expr>`: computed on insert, never inserted directly. */
	readonly materialized?: DdlExpr<ColumnDefs>
	/** `ALIAS <expr>`: computed on read, not stored. */
	readonly alias?: DdlExpr<ColumnDefs>
	/** Compression codec, written as after `CODEC`, e.g. `"Delta, ZSTD(1)"`. */
	readonly codec?: string
	readonly comment?: string
}

export interface ColumnSpec<T extends CHType<string, any, any>> {
	readonly _tag: "ColumnSpec"
	readonly type: T
	readonly options: ColumnOptions<T>
}

/** A column with DDL options. A bare column type works too where no option is needed. */
export const column = <T extends CHType<string, any, any>>(type: T, options: ColumnOptions<T> = {}): ColumnSpec<T> => ({
	_tag: "ColumnSpec",
	type,
	options,
})

export type ColumnInput = CHType<string, any, any> | ColumnSpec<CHType<string, any, any>>

/** The query-side column types of a `columns` record. */
export type ColumnsOf<I extends Record<string, ColumnInput>> = {
	readonly [K in keyof I]: I[K] extends ColumnSpec<infer T>
		? T
		: I[K] extends CHType<string, any, any>
			? I[K]
			: never
}

const isColumnSpec = (input: ColumnInput): input is ColumnSpec<CHType<string, any, any>> =>
	"_tag" in input && input._tag === "ColumnSpec"

// Engines

const engineOf = (family: string, ...params: ReadonlyArray<string | undefined>): EngineSpec => ({
	family,
	params: params.filter((p): p is string => p !== undefined),
})

/**
 * Table engines. Write the plain family: the `Replicated` prefix and its
 * Keeper path are a render option, so one schema serves a single server, a
 * replicated cluster, and ClickHouse Cloud (which converts MergeTree itself).
 */
export const engine = {
	mergeTree: (): EngineSpec => engineOf("MergeTree"),
	replacingMergeTree: (options: { readonly version?: string; readonly isDeleted?: string } = {}): EngineSpec =>
		engineOf("ReplacingMergeTree", options.version, options.version ? options.isDeleted : undefined),
	summingMergeTree: (options: { readonly columns?: ReadonlyArray<string> } = {}): EngineSpec =>
		engineOf("SummingMergeTree", options.columns ? `(${options.columns.join(", ")})` : undefined),
	aggregatingMergeTree: (): EngineSpec => engineOf("AggregatingMergeTree"),
	collapsingMergeTree: (sign: string): EngineSpec => engineOf("CollapsingMergeTree", sign),
	versionedCollapsingMergeTree: (sign: string, version: string): EngineSpec =>
		engineOf("VersionedCollapsingMergeTree", sign, version),
	null: (): EngineSpec => engineOf("Null"),
	memory: (): EngineSpec => engineOf("Memory"),
} as const

const isMergeTreeFamily = (spec: EngineSpec): boolean => spec.family.endsWith("MergeTree")

// Indexes and TTL

export interface IndexSpec<Cols extends ColumnDefs> {
	readonly name: string
	readonly expr: DdlExpr<Cols>
	/** The index type as written after `TYPE`, e.g. `minmax`, `bloom_filter(0.01)`, `set(100)`. */
	readonly type: string
	readonly granularity?: number
}

/** A data-skipping index. */
export const index = <Cols extends ColumnDefs>(
	name: string,
	expr: DdlExpr<Cols>,
	type: string,
	granularity = 1,
): IndexSpec<Cols> => ({ name, expr, type, granularity })

/** `<expr> + INTERVAL n DAY`, the usual row TTL. */
export const ttlAfterDays =
	<Cols extends ColumnDefs>(expr: DdlExpr<Cols>, days: number) =>
	($: ColumnAccessor<Cols>): string =>
		`${typeof expr === "string" ? expr : renderExprValue(expr($))} + toIntervalDay(${Math.trunc(days)})`

// Tables

export interface TableDefinition<Columns extends Record<string, ColumnInput>> {
	readonly columns: Columns
	readonly engine: EngineSpec
	/** Required for the MergeTree family; use `[]` for `ORDER BY tuple()`. */
	readonly orderBy?: DdlKey<ColumnsOf<Columns>>
	readonly partitionBy?: DdlExpr<ColumnsOf<Columns>>
	readonly primaryKey?: DdlKey<ColumnsOf<Columns>>
	readonly ttl?: DdlExpr<ColumnsOf<Columns>>
	readonly settings?: Readonly<Record<string, string | number>>
	readonly indexes?: ReadonlyArray<IndexSpec<ColumnsOf<Columns>>>
	readonly comment?: string
	/** As for `table()`: the column carrying row-level tenancy. */
	readonly tenantColumn?: keyof Columns & string
}

/** The DDL a `defineTable` value carries, as entities. */
export interface TableDdl {
	readonly table: TableEntity
	readonly columns: ReadonlyArray<ColumnEntity>
	readonly indexes: ReadonlyArray<IndexEntity>
}

export interface SchemaTable<Name extends string, Cols extends ColumnDefs> extends Table<Name, Cols> {
	readonly ddl: TableDdl
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

const assertIdentifier = (object: string, name: string): void => {
	if (!IDENTIFIER.test(name)) {
		throw new SchemaDefinitionDefect({
			object,
			message: `${JSON.stringify(name)} is not a plain identifier ([A-Za-z_][A-Za-z0-9_]*)`,
		})
	}
}

const columnDefault = (
	table: string,
	name: string,
	spec: ColumnSpec<CHType<string, any, any>>,
	columns: ColumnDefs,
): ColumnDefault | null => {
	const { options } = spec
	const set = [
		options.default !== undefined,
		options.defaultExpr !== undefined,
		options.materialized !== undefined,
		options.alias !== undefined,
	].filter(Boolean).length
	if (set > 1) {
		throw new SchemaDefinitionDefect({
			object: `${table}.${name}`,
			message: "a column takes at most one of default, defaultExpr, materialized, alias",
		})
	}
	if (options.default !== undefined) {
		return {
			kind: "DEFAULT",
			expr: withDialect(clickhouseDialect, () => encodeColumnLiteral(spec.type, options.default, name)),
		}
	}
	if (options.defaultExpr !== undefined) return { kind: "DEFAULT", expr: renderExpr(options.defaultExpr, columns) }
	if (options.materialized !== undefined) {
		return { kind: "MATERIALIZED", expr: renderExpr(options.materialized, columns) }
	}
	if (options.alias !== undefined) return { kind: "ALIAS", expr: renderExpr(options.alias, columns) }
	return null
}

/**
 * A table with its DDL. Usable everywhere a `table()` is; `generate` reads its
 * `ddl` to produce migrations.
 */
export function defineTable<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: TableDefinition<Columns>,
): SchemaTable<Name, ColumnsOf<Columns>> {
	assertIdentifier(name, name)
	const inputs = Object.entries(definition.columns)
	if (inputs.length === 0) throw new SchemaDefinitionDefect({ object: name, message: "a table needs columns" })
	const types = Object.fromEntries(
		inputs.map(([column, input]) => [column, isColumnSpec(input) ? input.type : input]),
	) as ColumnsOf<Columns>

	if (isMergeTreeFamily(definition.engine) && definition.orderBy === undefined) {
		throw new SchemaDefinitionDefect({
			object: name,
			message: `${definition.engine.family} needs orderBy (use [] for ORDER BY tuple())`,
		})
	}
	if (!isMergeTreeFamily(definition.engine)) {
		const misplaced = (["orderBy", "partitionBy", "primaryKey", "ttl", "indexes"] as const).filter(
			(key) => definition[key] !== undefined,
		)
		if (misplaced.length > 0) {
			throw new SchemaDefinitionDefect({
				object: name,
				message: `${definition.engine.family} takes no ${misplaced.join(", ")}`,
			})
		}
	}

	const columnEntities = inputs.map(([column, input], position): ColumnEntity => {
		assertIdentifier(`${name}.${column}`, column)
		const spec = isColumnSpec(input) ? input : { _tag: "ColumnSpec" as const, type: input, options: {} }
		return {
			kind: "column",
			table: name,
			name: column,
			position,
			type: spec.type.sql,
			default: columnDefault(name, column, spec, types),
			codec: spec.options.codec ?? null,
			comment: spec.options.comment ?? null,
		}
	})

	const orderBy =
		definition.orderBy === undefined
			? null
			: Array.isArray(definition.orderBy) && definition.orderBy.length === 0
				? "tuple()"
				: renderKey(definition.orderBy, types)

	const indexEntities = (definition.indexes ?? []).map((spec): IndexEntity => {
		assertIdentifier(`${name} index`, spec.name)
		return {
			kind: "index",
			table: name,
			name: spec.name,
			expr: renderExpr(spec.expr, types),
			type: spec.type,
			granularity: spec.granularity ?? 1,
		}
	})

	const table: TableEntity = {
		kind: "table",
		name,
		engine: definition.engine,
		orderBy,
		partitionBy: definition.partitionBy === undefined ? null : renderExpr(definition.partitionBy, types),
		primaryKey: definition.primaryKey === undefined ? null : renderKey(definition.primaryKey, types),
		ttl: definition.ttl === undefined ? null : renderExpr(definition.ttl, types),
		settings: Object.fromEntries(Object.entries(definition.settings ?? {}).map(([k, v]) => [k, String(v)])),
		comment: definition.comment ?? null,
	}

	return {
		_tag: "Table",
		name,
		columns: types,
		...(definition.tenantColumn !== undefined ? { tenantColumn: definition.tenantColumn } : undefined),
		ddl: { table, columns: columnEntities, indexes: indexEntities },
	}
}

// Materialized views

/** Output columns the target cannot take: missing there, or a different type. */
export type MisfitColumns<Output, Cols extends ColumnDefs> = {
	[K in keyof Output]: K extends keyof Cols ? ([Output[K]] extends [InferTS<Cols[K]>] ? never : K) : K
}[keyof Output]

export interface MaterializedView<Name extends string> {
	readonly _tag: "MaterializedView"
	readonly name: Name
	readonly ddl: MaterializedViewEntity
}

const leftmostTable = (query: CHQuery<any, any, any, any>): string => {
	const state = query._state
	if (state.fromQuery !== undefined) return leftmostTable(state.fromQuery)
	if (state.fromUnion !== undefined) {
		throw new SchemaDefinitionDefect({
			object: state.tableName,
			message: "a materialized view cannot read FROM a union; define one view per branch",
		})
	}
	return state.tableName
}

/**
 * A materialized view writing to `to`. Its body is a DSL query, so its output
 * is checked against the target's columns: a column the target lacks, or of
 * another type, is a type error here instead of a failed insert later.
 *
 * Views never `POPULATE`. History comes from an explicit backfill.
 */
export function materializedView<
	const Name extends string,
	TargetName extends string,
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
>(
	name: Name,
	options: {
		readonly to: SchemaTable<TargetName, Cols>
		readonly as: CHQuery<any, Output, any, any>
	} & ([MisfitColumns<Output, Cols>] extends [never]
		? unknown
		: { readonly targetCannotTake: MisfitColumns<Output, Cols> }),
): MaterializedView<Name> {
	assertIdentifier(name, name)
	const select = compileCHUnsafe(options.as, {}, { skipFormat: true, dialect: clickhouseDialect }).sql
	return {
		_tag: "MaterializedView",
		name,
		ddl: { kind: "materialized_view", name, to: options.to.name, sources: [leftmostTable(options.as)], select },
	}
}
