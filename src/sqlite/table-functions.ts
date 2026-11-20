// SQLite table-valued functions as row sources: `json_each`, `json_tree`, and
// `jsonRows` on top of them, plus FTS5 tables.
//
// A table-valued function is a `TableFunction` (see `ch/table.ts`): `from`,
// the joins and `update(...).from` read it like a table, under an alias, and
// write its SQL where a table name would go. Its argument is bound as one
// parameter, which is how a list of any length reaches a statement on D1 and
// Durable Object storage, both limited to 100 bound parameters.

import { Schema } from "effect"
import { columnTypeOf, isExprLike, makeCond, makeExpr, type Condition, type ColumnRef, type Expr, type ParamsIn } from "../ch/expr"
import { encodeLiteral } from "../ch/literal"
import { fail } from "../ch/failure"
import { QueryBuilderDefect } from "../ch/errors"
import { builtins, type SqliteOnly } from "../ch/functions/builtin"
import { from, type CHQuery } from "../ch/query"
import { table as queryTable, type Table, type TableFunction } from "../ch/table"
import type { CHType, ColumnDefs, InferTS } from "../ch/types"
import { compile, known, quoteIdent, quoteIdentPath, str } from "../sql/sql-fragment"
import { custom, integer, nullable, text } from "./types"

const scalar = builtins("sqlite", "scalar")
const aggregateFree = (name: string, render: () => string) => scalar.lazy(render, name)

/** Any JSON value SQLite hands back: a column of `json_each` whose type the caller did not give. */
const anyValue = custom("", Schema.Unknown)
/** `json_each`'s `key`: an array index, an object key, or NULL at the top level. */
const jsonKey = nullable(custom("", Schema.Union([Schema.Int, Schema.String])))

/**
 * The columns of `json_each` and `json_tree`. `value` and `key` take the
 * types given to `jsonEach(json, { value, key })`; the others are SQLite's.
 */
export type JsonEachColumns<Value extends CHType<string, any, any>, Key extends CHType<string, any, any>> = {
	readonly key: Key
	readonly value: Value
	/** `'null'`, `'true'`, `'false'`, `'integer'`, `'real'`, `'text'`, `'array'` or `'object'`. */
	readonly type: typeof text
	/** The value for a scalar, NULL for an array or object. */
	readonly atom: typeof anyValue
	readonly id: typeof integer
	readonly parent: ReturnType<typeof nullable<"integer", number, number>>
	readonly fullkey: typeof text
	readonly path: typeof text
}

/** The column types of `value` and `key`, when the caller gives them. */
export interface JsonEachTypes<Value extends CHType<string, any, any>, Key extends CHType<string, any, any>> {
	/** How each element decodes: `SQLite.text` for an array of strings, `SQLite.json(schema)` for objects. */
	readonly value?: Value
	/** How each key decodes. By default an index or key, or NULL at the top level. */
	readonly key?: Key
}

/**
 * The JSON a table-valued function reads: a JS value (an array, an object),
 * bound as one JSON text parameter; or an expression of JSON text, such as a
 * `json(schema)` column, a `param.of(SQLite.json(schema), name)`, or a
 * `jsonExtract`. A JS string is a JSON string value, not JSON text: pass
 * JSON text as an expression.
 */
export type JsonSource = Expr<unknown> | ReadonlyArray<unknown> | Readonly<Record<string, unknown>> | string | number | boolean | null

const AnyJson = Schema.fromJsonString(Schema.Unknown) as Schema.Codec<unknown, string>

/** The JSON argument as SQL: an expression as it renders, a JS value bound as JSON text. */
const jsonArgument = (name: string, source: unknown): string => {
	if (isExprLike(source)) return compile(source.toFragment())
	if (source === undefined || typeof source === "function" || typeof source === "symbol" || typeof source === "bigint") {
		return fail(new QueryBuilderDefect({ message: `${name}: the JSON source must be an expression or a JSON value` }), "NULL")
	}
	return encodeLiteral(AnyJson, source, name)
}

const tableValued = <Value extends CHType<string, any, any>, Key extends CHType<string, any, any>>(
	name: "json_each" | "json_tree",
	source: unknown,
	path: string | undefined,
	types: JsonEachTypes<Value, Key> | undefined,
) => {
	const columns = {
		key: types?.key ?? jsonKey,
		value: types?.value ?? anyValue,
		type: text,
		atom: anyValue,
		id: integer,
		parent: nullable(integer),
		fullkey: text,
		path: text,
	}
	const fragment = aggregateFree(name, () => {
		const args = [jsonArgument(name, source)]
		if (path !== undefined) {
			args.push(
				path.startsWith("$")
					? compile(str(path))
					: fail(new QueryBuilderDefect({ message: `${name}: a JSON path starts with "$", got ${JSON.stringify(path)}` }), "'$'"),
			)
		}
		return `${name}(${args.join(", ")})`
	})
	return { _tag: "TableFunction" as const, name, columns, fragment }
}

/** What a `jsonEach` / `jsonTree` source carries: its argument's params, and `SqliteOnly`. */
type SourceParams<S> = ParamsIn<S> | SqliteOnly

/**
 * `json_each(json[, path])`: one row per element of a JSON array (or member of
 * an object), as a row source for `from`, the joins and `update(...).from`.
 * Its columns are `key`, `value`, `type`, `atom`, `id`, `parent`, `fullkey`
 * and `path`; `value` and `key` decode as the types given.
 *
 * ```ts
 * SQLite.inSubquery($.accountId, SQLite.from(SQLite.jsonEach(ids, { value: SQLite.text })).select(($) => ({ value: $.value })))
 * ```
 */
export function jsonEach<
	const S extends JsonSource,
	Value extends CHType<string, any, any> = typeof anyValue,
	Key extends CHType<string, any, any> = typeof jsonKey,
>(source: S, types?: JsonEachTypes<Value, Key> & { readonly path?: string }): TableFunction<"json_each", JsonEachColumns<Value, Key>, SourceParams<S>> {
	return tableValued("json_each", source, types?.path, types) as unknown as TableFunction<"json_each", JsonEachColumns<Value, Key>, SourceParams<S>>
}

/** `json_tree(json[, path])`: as `jsonEach`, recursing into nested arrays and objects. */
export function jsonTree<
	const S extends JsonSource,
	Value extends CHType<string, any, any> = typeof anyValue,
	Key extends CHType<string, any, any> = typeof jsonKey,
>(source: S, types?: JsonEachTypes<Value, Key> & { readonly path?: string }): TableFunction<"json_tree", JsonEachColumns<Value, Key>, SourceParams<S>> {
	return tableValued("json_tree", source, types?.path, types) as unknown as TableFunction<"json_tree", JsonEachColumns<Value, Key>, SourceParams<S>>
}

/** A JSON path to an object member: `$.day`, or `$."odd key"`. */
const memberPath = (field: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ? `$.${field}` : `$."${field.replace(/"/g, '\\"')}"`)

/** The rows of a `jsonRows` source: each field as its column type decodes it. */
export type JsonRowsOutput<Columns extends ColumnDefs> = { readonly [K in keyof Columns]: InferTS<Columns[K]> }

/**
 * Rows from a JS array, as a query: one bound JSON parameter, read back with
 * `json_each` and a `json_extract(value, '$.<field>')` per column, decoded by
 * the given column types. Each row is encoded through those types first, so a
 * boolean is written as 0/1 and a timestamp as SQLite text, as an insert writes
 * them. Use it as `insertInto(t).select(...)`, `fromQuery`, a join or
 * `update(t).from(...)`. The rows may also be an expression of JSON text.
 *
 * ```ts
 * SQLite.insertInto(OrgDaily).select(SQLite.jsonRows(days, { day: SQLite.text, dau: SQLite.integer }))
 * ```
 */
export function jsonRows<const Columns extends ColumnDefs, P = never>(
	rows: ReadonlyArray<{ readonly [K in keyof Columns]: InferTS<Columns[K]> }> | Expr<unknown, P>,
	columns: Columns,
): CHQuery<{}, JsonRowsOutput<Columns>, {}, undefined, P | SqliteOnly, "json_each"> {
	const encoded = isExprLike(rows)
		? rows
		: makeExpr<unknown>(
				known(() => {
					const row = Schema.Struct(Object.fromEntries(Object.entries(columns).map(([key, type]) => [key, type.literalSchema])))
					return encodeLiteral(Schema.fromJsonString(Schema.Array(row)) as Schema.Codec<unknown, unknown>, rows, "jsonRows")
				}),
				undefined,
			)
	const source = tableValued("json_each", encoded, undefined, undefined) as unknown as TableFunction<"json_each", JsonEachColumns<typeof anyValue, typeof jsonKey>, never>
	return from(source).select(($) =>
		Object.fromEntries(
			Object.entries(columns).map(([field, type]) => [
				field,
				makeExpr(aggregateFree("json_extract", () => `json_extract(${compile($.value.toFragment())}, ${compile(str(memberPath(field)))})`), type.schema),
			]),
		),
	) as unknown as CHQuery<{}, JsonRowsOutput<Columns>, {}, undefined, P | SqliteOnly, "json_each">
}

// FTS5

/** What an FTS5 table's `rowid` type knows of its table: the `fts5` functions read it off the column. */
interface Fts5Info {
	readonly table: string
	readonly columns: ReadonlyArray<string>
}

/** The `rowid` of an FTS5 table: an integer that knows its table, for the `fts5` functions. */
export interface Fts5Rowid<Name extends string> extends CHType<"integer", number, number> {
	readonly fts5: Fts5Info & { readonly table: Name }
}

/** An FTS5 table's columns, with its `rowid`. */
export type Fts5Columns<Name extends string, Columns extends ColumnDefs> = Columns & { readonly rowid: Fts5Rowid<Name> }

/**
 * An FTS5 virtual table, for queries: its indexed columns and its `rowid`.
 * No DDL (create it yourself with `CREATE VIRTUAL TABLE ... USING fts5(...)`).
 * Search it with `fts5.match`, rank with `fts5.bm25`, and join its `rowid` to
 * the content table.
 */
export function fts5Table<const Name extends string, const Columns extends ColumnDefs>(
	name: Name,
	columns: Columns,
): Table<Name, Fts5Columns<Name, Columns>, "rowid"> {
	const rowid: Fts5Rowid<Name> = { ...integer, fts5: { table: name, columns: Object.keys(columns) } }
	return queryTable(name, { ...columns, rowid } as Fts5Columns<Name, Columns>, { defaults: ["rowid"] }) as unknown as Table<
		Name,
		Fts5Columns<Name, Columns>,
		"rowid"
	>
}

/** The FTS5 table's accessor in a query: `$` when it is the FROM source, `$.alias` when joined. */
export interface Fts5Source<Name extends string = string> {
	readonly rowid: ColumnRef<"rowid", Fts5Rowid<Name>, any, any> | ColumnRef<"rowid", CHType<string, any, any> & { readonly fts5: Fts5Info }, any, any>
}

/** The params (the source entry) the FTS5 table's columns carry. */
type SourceOfFts<S> = S extends { readonly rowid: infer R } ? ParamsIn<R> : never

/** The columns of the FTS5 table a source reads. */
type FtsColumn<S> = Exclude<keyof S & string, "rowid">

/**
 * The FTS5 table's hidden column, named as the table, under the qualifier the
 * query gives the source; and the table's columns. Quoted, not an identifier
 * fragment: it is not a column a GROUP BY could name.
 */
const hidden = (fn: string, source: Fts5Source): { readonly sql: string; readonly info: Fts5Info } | undefined => {
	const rowid = (source as { readonly rowid?: Expr<unknown> } | undefined)?.rowid
	const info = rowid === undefined ? undefined : (columnTypeOf(rowid) as { readonly fts5?: Fts5Info } | undefined)?.fts5
	if (rowid === undefined || info === undefined) {
		return fail(new QueryBuilderDefect({ message: `fts5.${fn}: pass the accessor of an fts5Table source (\`$\` or \`$.alias\`)` }), undefined)
	}
	const fragment = rowid.toFragment()
	const qualifier = fragment._tag === "Ident" ? fragment.qualifier : undefined
	return { sql: qualifier === undefined ? quoteIdent(info.table) : `${quoteIdentPath(qualifier)}.${quoteIdent(info.table)}`, info }
}

/** A column of the FTS5 table, by name or by its 0-based position. */
const columnIndex = (fn: string, info: Fts5Info, column: string | number): string => {
	const index = typeof column === "number" ? column : info.columns.indexOf(column)
	return Number.isSafeInteger(index) && index >= 0 && index < info.columns.length
		? String(index)
		: fail(new QueryBuilderDefect({ message: `fts5.${fn}: ${JSON.stringify(column)} is not a column of ${info.table}` }), "0")
}

/** A text argument: an expression as it renders, a string bound. */
const textArg = (fn: string, value: string | Expr<string, any>): string =>
	isExprLike(value) ? compile(value.toFragment()) : encodeLiteral(Schema.String as Schema.Codec<string, unknown>, value, `fts5.${fn}`)

/** The FTS5 functions; each takes the FTS5 table's accessor (`$`, or `$.alias` when joined). */
export const fts5 = {
	/** `table MATCH query`: the rows the full-text query matches. A string query is bound. */
	match: <S extends Fts5Source, Q = never>(source: S, query: string | Expr<string, Q>): Condition<SourceOfFts<S> | Q | SqliteOnly> =>
		makeCond(
			aggregateFree("match", () => {
				const target = hidden("match", source)
				return target === undefined ? "0" : `${target.sql} MATCH ${textArg("match", query)}`
			}),
		),
	/**
	 * `snippet(table, column, start, end, ellipsis, tokens)`: a fragment of the
	 * column around the match, the matched terms between `start` and `end`.
	 */
	snippet: <S extends Fts5Source>(
		source: S,
		column: FtsColumn<S> | number,
		start: string,
		end: string,
		ellipsis: string,
		tokens: number,
	): Expr<string, SourceOfFts<S> | SqliteOnly> =>
		makeExpr(
			aggregateFree("snippet", () => {
				const target = hidden("snippet", source)
				if (target === undefined) return "NULL"
				if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > 64) {
					return fail(new QueryBuilderDefect({ message: `fts5.snippet: tokens must be an integer from 1 to 64, got ${tokens}` }), "NULL")
				}
				const texts = [start, end, ellipsis].map((value) => compile(str(value)))
				return `snippet(${target.sql}, ${columnIndex("snippet", target.info, column)}, ${texts.join(", ")}, ${tokens})`
			}),
			Schema.String as Schema.Codec<string, unknown>,
		),
	/** `highlight(table, column, start, end)`: the whole column, matched terms between `start` and `end`. NULL for a NULL column. */
	highlight: <S extends Fts5Source>(source: S, column: FtsColumn<S> | number, start: string, end: string): Expr<string | null, SourceOfFts<S> | SqliteOnly> =>
		makeExpr(
			aggregateFree("highlight", () => {
				const target = hidden("highlight", source)
				if (target === undefined) return "NULL"
				return `highlight(${target.sql}, ${columnIndex("highlight", target.info, column)}, ${compile(str(start))}, ${compile(str(end))})`
			}),
			Schema.NullOr(Schema.String) as Schema.Codec<string | null, unknown>,
		),
	/**
	 * `bm25(table, ...weights)`: the match's relevance, a real where lower is
	 * better (sort ascending). One weight per column, in column order.
	 */
	bm25: <S extends Fts5Source>(source: S, ...weights: ReadonlyArray<number>): Expr<number, SourceOfFts<S> | SqliteOnly> =>
		makeExpr(
			aggregateFree("bm25", () => {
				const target = hidden("bm25", source)
				if (target === undefined) return "NULL"
				if (weights.some((weight) => !Number.isFinite(weight))) {
					return fail(new QueryBuilderDefect({ message: "fts5.bm25: every weight must be a finite number" }), "NULL")
				}
				return `bm25(${[target.sql, ...weights.map(String)].join(", ")})`
			}),
			Schema.Finite as Schema.Codec<number, unknown>,
		),
}
