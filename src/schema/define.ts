// Schema definitions: tables and materialized views that carry their DDL.
//
// `table` (`defineTable` here) returns a value that IS a `Table`, so every query API accepts it
// unchanged; the DDL rides beside it on `ddl`, already normalized into
// entities. Expressions (keys, TTL, defaults, index and view bodies) are
// written with the query DSL and rendered once, here, with the ClickHouse
// dialect. A definition that cannot be rendered is a bug in the definition, so
// it records a problem on `problems` instead of throwing; `entitiesOf` fails
// with every recorded problem as a typed `SchemaDefinitionError`.

import { compileCHRaw } from "../ch/compile"
import { clickhouseDialect, withDialect } from "../ch/dialect"
import type { Expr } from "../ch/expr"
import { encodeColumnLiteral } from "../ch/literal"
import { createColumnAccessor, type CHQuery, type ColumnAccessor, type NeedsSelect } from "../ch/query"
import { table, type Table } from "../ch/table"
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
import { checkIdentifier, withRenderProblems, type DefinitionProblem, type ProblemSink } from "./problems"

export { SchemaDefinitionError, type DefinitionProblem } from "./problems"

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

/**
 * `Given` keeps which options were given, so the table can tell an insert
 * which columns it may leave out (a default) or may not write (computed).
 */
export interface ColumnSpec<T extends CHType<string, any, any>, Given extends keyof ColumnOptions<T> = keyof ColumnOptions<T>> {
	readonly _tag: "ColumnSpec"
	readonly type: T
	readonly options: ColumnOptions<T>
	readonly _given?: Given
}

/** A column with DDL options. A bare column type works too where no option is needed. */
export const column = <T extends CHType<string, any, any>, Given extends keyof ColumnOptions<T> = never>(
	type: T,
	// Only the option *names* are inferred, from the mapped half; the options
	// themselves stay contextually typed, so `materialized: ($) => ...` keeps `$`.
	options: ColumnOptions<T> & { readonly [K in Given]: unknown } = {} as ColumnOptions<T> & { readonly [K in Given]: unknown },
): ColumnSpec<T, Given> => ({
	_tag: "ColumnSpec",
	type,
	options,
})

export type ColumnInput = CHType<string, any, any> | ColumnSpec<CHType<string, any, any>, any>

/** The query-side column types of a `columns` record. */
export type ColumnsOf<I extends Record<string, ColumnInput>> = {
	readonly [K in keyof I]: I[K] extends ColumnSpec<infer T, any>
		? T
		: I[K] extends CHType<string, any, any>
			? I[K]
			: never
}

/** Columns declared with `default` or `defaultExpr`: an insert may leave them out. */
export type DefaultedColumnsOf<I extends Record<string, ColumnInput>> = {
	[K in keyof I]: I[K] extends ColumnSpec<any, infer Given>
		? [Extract<Given, "default" | "defaultExpr">] extends [never]
			? never
			: K
		: never
}[keyof I] &
	string

/** Columns declared `materialized` or `alias`: an insert may not write them. */
export type ComputedColumnsOf<I extends Record<string, ColumnInput>> = {
	[K in keyof I]: I[K] extends ColumnSpec<any, infer Given>
		? [Extract<Given, "materialized" | "alias">] extends [never]
			? never
			: K
		: never
}[keyof I] &
	string

const isColumnSpec = (input: ColumnInput): input is ColumnSpec<CHType<string, any, any>, any> =>
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
	/** The column carrying row-level tenancy; see docs/tenant-scoping.md. */
	readonly tenantColumn?: keyof Columns & string
}

/**
 * A table this schema does not own: a system table (`system.one`), a table
 * function (`numbers(10)`), a subquery, or a table another tool migrates. It
 * queries like any table but carries no DDL, so `generate` never touches it,
 * and its name is written verbatim as the FROM target.
 */
export interface ExternalTableDefinition<Columns extends Record<string, ColumnInput>> {
	readonly external: true
	readonly columns: Columns
	readonly tenantColumn?: keyof Columns & string
}

/**
 * The query-side `Table` of an external definition. Column options still say
 * which columns an insert may leave out or may not write; nothing is rendered.
 */
export const externalTable = <const Name extends string>(
	name: Name,
	definition: { readonly columns: Record<string, unknown>; readonly tenantColumn?: string },
	isSpec: (input: unknown) => input is { readonly type: CHType<string, any, any>; readonly options: object },
	computedOptions: ReadonlyArray<string>,
	/** The query-side type of a spec; the Postgres one carries the column's `name`. */
	typeOf: (spec: { readonly type: CHType<string, any, any>; readonly options: object }) => CHType<string, any, any> = (spec) => spec.type,
): Table<Name, any, any, any> => {
	const inputs = Object.entries(definition.columns)
	const specs = inputs.filter((entry): entry is [string, { readonly type: CHType<string, any, any>; readonly options: object }] =>
		isSpec(entry[1]),
	)
	const isComputed = (options: object) => computedOptions.some((key) => (options as Record<string, unknown>)[key] !== undefined)
	// `name` renames a column; it gives the column no default.
	const given = (options: object) =>
		Object.entries(options).some(([key, value]) => key !== "name" && value !== undefined)
	return table(
		name,
		Object.fromEntries(inputs.map(([column, input]) => [column, isSpec(input) ? typeOf(input) : input])) as ColumnDefs,
		{
			...(definition.tenantColumn !== undefined ? { tenantColumn: definition.tenantColumn } : undefined),
			defaults: specs.filter(([, spec]) => given(spec.options) && !isComputed(spec.options)).map(([column]) => column),
			computed: specs.filter(([, spec]) => isComputed(spec.options)).map(([column]) => column),
		},
	)
}

/** The DDL a ClickHouse `table` value carries, as entities. */
export interface TableDdl {
	readonly table: TableEntity
	readonly columns: ReadonlyArray<ColumnEntity>
	readonly indexes: ReadonlyArray<IndexEntity>
}

export interface SchemaTable<
	Name extends string,
	Cols extends ColumnDefs,
	Defaulted extends string = string,
	Computed extends string = string,
> extends Table<Name, Cols, Defaulted, Computed> {
	readonly ddl: TableDdl
	/** What is wrong with the definition; `entitiesOf` fails when any table has one. */
	readonly problems: ReadonlyArray<DefinitionProblem>
}

const columnDefault = (
	problems: ProblemSink,
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
		problems.push({ object: `${table}.${name}`, message: "a column takes at most one of default, defaultExpr, materialized, alias" })
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
 * A table with its DDL, published as `table` from `/clickhouse`. The value IS a
 * query `Table`, so every query API accepts it; `generate` reads its
 * `ddl` to produce migrations.
 */
export function defineTable<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: ExternalTableDefinition<Columns>,
): Table<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>, ComputedColumnsOf<Columns>>
export function defineTable<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: TableDefinition<Columns>,
): SchemaTable<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>, ComputedColumnsOf<Columns>>
export function defineTable<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: TableDefinition<Columns> | ExternalTableDefinition<Columns>,
): SchemaTable<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>, ComputedColumnsOf<Columns>> | Table<Name, any, any, any> {
	if ("external" in definition) {
		return externalTable(name, definition, (input): input is ColumnSpec<CHType<string, any, any>> => isColumnSpec(input as ColumnInput), [
			"materialized",
			"alias",
		])
	}
	return withRenderProblems(name, () => buildTable(name, definition))
}

function buildTable<const Name extends string, const Columns extends Record<string, ColumnInput>>(
	name: Name,
	definition: TableDefinition<Columns>,
): SchemaTable<Name, ColumnsOf<Columns>, DefaultedColumnsOf<Columns>, ComputedColumnsOf<Columns>> {
	const problems: ProblemSink = []
	checkIdentifier(problems, name, name)
	const inputs = Object.entries(definition.columns)
	if (inputs.length === 0) problems.push({ object: name, message: "a table needs columns" })
	const types = Object.fromEntries(
		inputs.map(([column, input]) => [column, isColumnSpec(input) ? input.type : input]),
	) as ColumnsOf<Columns>

	if (isMergeTreeFamily(definition.engine) && definition.orderBy === undefined) {
		problems.push({ object: name, message: `${definition.engine.family} needs orderBy (use [] for ORDER BY tuple())` })
	}
	if (!isMergeTreeFamily(definition.engine)) {
		const misplaced = (["orderBy", "partitionBy", "primaryKey", "ttl", "indexes"] as const).filter(
			(key) => definition[key] !== undefined,
		)
		if (misplaced.length > 0) {
			problems.push({ object: name, message: `${definition.engine.family} takes no ${misplaced.join(", ")}` })
		}
	}

	const columnEntities = inputs.map(([column, input], position): ColumnEntity => {
		checkIdentifier(problems, `${name}.${column}`, column)
		const spec: ColumnSpec<CHType<string, any, any>> = isColumnSpec(input)
			? input
			: { _tag: "ColumnSpec", type: input as CHType<string, any, any>, options: {} }
		return {
			kind: "column",
			table: name,
			name: column,
			position,
			type: spec.type.sql,
			default: columnDefault(problems, name, column, spec, types),
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
		checkIdentifier(problems, `${name} index`, spec.name)
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

	const defaults = columnEntities.filter((c) => c.default?.kind === "DEFAULT").map((c) => c.name)
	const computed = columnEntities
		.filter((c) => c.default?.kind === "MATERIALIZED" || c.default?.kind === "ALIAS")
		.map((c) => c.name)
	return {
		_tag: "Table",
		name,
		columns: types,
		...(definition.tenantColumn !== undefined ? { tenantColumn: definition.tenantColumn } : undefined),
		...(defaults.length > 0 ? { defaults: defaults as unknown as Array<DefaultedColumnsOf<Columns>> } : undefined),
		...(computed.length > 0 ? { computed: computed as unknown as Array<ComputedColumnsOf<Columns>> } : undefined),
		ddl: { table, columns: columnEntities, indexes: indexEntities },
		problems,
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
	/** What is wrong with the definition; `entitiesOf` fails when any view has one. */
	readonly problems: ReadonlyArray<DefinitionProblem>
}

/** The table a view's inserts come from; `undefined` for a union, which no single insert triggers. */
const leftmostTable = (query: CHQuery<any, any, any, any>): string | undefined => {
	const state = query._state
	if (state.fromQuery !== undefined) return leftmostTable(state.fromQuery)
	return state.fromUnion !== undefined ? undefined : state.tableName
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
		readonly as: CHQuery<any, Output, any, any> & NeedsSelect<Output>
	} & ([MisfitColumns<Output, Cols>] extends [never]
		? unknown
		: { readonly targetCannotTake: MisfitColumns<Output, Cols> }),
): MaterializedView<Name> {
	return withRenderProblems(name, () => buildView(name, options.to.name, options.as))
}

function buildView<const Name extends string>(name: Name, to: string, as: CHQuery<any, any, any, any>): MaterializedView<Name> {
	const problems: ProblemSink = []
	checkIdentifier(problems, name, name)
	const source = leftmostTable(as)
	if (source === undefined) {
		problems.push({ object: name, message: "a materialized view cannot read FROM a union; define one view per branch" })
	}
	const select = compileCHRaw(as, {}, { skipFormat: true, dialect: clickhouseDialect }).sql
	return {
		_tag: "MaterializedView",
		name,
		ddl: { kind: "materialized_view", name, to, sources: source === undefined ? [] : [source], select },
		problems,
	}
}
