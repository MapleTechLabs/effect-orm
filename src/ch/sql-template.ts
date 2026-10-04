// `CH.sql`: SQL the builder has no syntax for, written as a template inside an
// expression or condition.
//
//   CH.sql(PG.text)`pg_current_xact_id()::xid::text`
//   CH.sql(T.uint64)`${$.Count} + ${1}`
//   CH.sql.cond`${$.meta} @> ${CH.param.string("filter")}::jsonb`
//
// Each `${value}` renders the way the rest of the builder renders it: an
// expression, column or param as its SQL (a param stays a placeholder, bound on
// Postgres), a builder query as a subquery compiled with the outer query, and a
// plain value as the dialect's escaped literal. A value with no literal form (an
// array or object, whose SQL type the template cannot know) fails the compile;
// pass it as a typed param instead. Nothing interpolated becomes SQL text except
// through `sql.raw`, which says so.
//
// Like `Db.sql` for whole statements, but this one is a builder expression: it
// renders at compile time, for the dialect being compiled for.

import { QueryBuilderError } from "./errors"
import { type Condition, type Expr, isExprLike, makeCond, makeExpr, makeUntypedExpr, toFragment } from "./expr"
import { compileCHUnsafe } from "./compile"
import type { CHQuery } from "./query"
import { renderSubquery } from "./subquery-context"
import type { CHType } from "./types"
import { compile, lazy, quoteIdentPath, type SqlFragment } from "../sql/sql-fragment"

const RawTag = "@maple-dev/effect-orm/SqlRaw"
const IdentTag = "@maple-dev/effect-orm/SqlIdent"

/** SQL text spliced as-is. From `sql.raw`. */
export interface SqlRaw {
	readonly _tag: typeof RawTag
	readonly sql: string
}

/** A name quoted by the dialect. From `sql.ident`. */
export interface SqlIdent {
	readonly _tag: typeof IdentTag
	readonly name: string
}

/** Anything a `CH.sql` template interpolates. */
export type SqlTemplateValue =
	| Expr<any>
	| Condition
	| CHQuery<any, any, any, any>
	| SqlRaw
	| SqlIdent
	| string
	| number
	| bigint
	| boolean
	| Date
	| null
	| { readonly _tag: "Utc" }

const tagged = <Tag extends string>(value: unknown, tag: Tag): value is { readonly _tag: Tag } =>
	typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === tag

const isQuery = (value: unknown): value is CHQuery<any, any, any, any> =>
	typeof value === "object" &&
	value !== null &&
	"_state" in value &&
	typeof (value as { readonly select?: unknown }).select === "function" &&
	!("_tag" in value)

// Plain names only, as for `Db.sql.identifier`: letters, digits and `_`, dotted
// for `schema.table`.
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

/** One interpolated value as SQL, in the dialect being compiled for. */
const renderValue = (value: unknown): string => {
	if (tagged(value, RawTag)) return (value as SqlRaw).sql
	if (tagged(value, IdentTag)) {
		const { name } = value as SqlIdent
		if (!PLAIN_NAME.test(name)) {
			throw new QueryBuilderError({
				code: "InvalidLiteral",
				message: `sql.ident: ${JSON.stringify(name)} is not a plain identifier (letters, digits, _, dotted for schema.table)`,
			})
		}
		return quoteIdentPath(name)
	}
	if (isQuery(value)) {
		return `(${renderSubquery(value, (query) =>
			typeof query === "string" ? query : compileCHUnsafe(query, {}, { skipFormat: true, deferParams: true }).sql,
		)})`
	}
	if (value === null) return "NULL"
	if (typeof value === "bigint") return String(value)
	if (typeof value === "number" && !Number.isFinite(value)) {
		throw new QueryBuilderError({ code: "InvalidLiteral", message: `sql\`\`: ${value} has no SQL literal` })
	}
	if (
		isExprLike(value) ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		value instanceof Date ||
		tagged(value, "Utc")
	) {
		return compile(toFragment(value))
	}
	throw new QueryBuilderError({
		code: "InvalidLiteral",
		message: `sql\`\`: cannot write ${Array.isArray(value) ? "an array" : typeof value} as a literal without its SQL type; pass it as a typed param (param.of(type, name))`,
	})
}

/** The template as one fragment, rendered when the enclosing query compiles. */
const fragmentOf = (strings: ReadonlyArray<string>, values: ReadonlyArray<unknown>): SqlFragment =>
	lazy(() => strings.reduce((text, part, index) => (index === 0 ? part : text + renderValue(values[index - 1]) + part), ""))

type Tag<A> = (strings: TemplateStringsArray, ...values: ReadonlyArray<SqlTemplateValue>) => A

export interface SqlTag {
	/**
	 * An expression of `type`: `CH.sql(PG.text)\`...\``. The type decodes the
	 * value when it is selected, so the query keeps its row schema.
	 */
	<T>(type: CHType<string, T, any>): Tag<Expr<T>>
	/**
	 * An expression with no declared type. Selecting one costs the query its row
	 * schema, as `untypedExpr` does; give a type where the value is selected.
	 */
	(strings: TemplateStringsArray, ...values: ReadonlyArray<SqlTemplateValue>): Expr<unknown>
	/** A condition, for `where`, `having`, a join's ON, or `CH.and` / `CH.or`. */
	readonly cond: Tag<Condition>
	/** SQL text spliced as-is. Only for text under your control, never for input. */
	readonly raw: (sql: string) => SqlRaw
	/** A table or column name, quoted by the dialect. Plain names only, dotted for `schema.table`. */
	readonly ident: (name: string) => SqlIdent
	/** Values joined by `separator` (default `, `), each rendered as an interpolation is. */
	readonly join: (values: ReadonlyArray<SqlTemplateValue>, separator?: string) => Expr<unknown>
}

const isTemplateStrings = (value: unknown): value is TemplateStringsArray =>
	Array.isArray(value) && Object.hasOwn(value, "raw")

/**
 * SQL the builder has no syntax for, inside an expression or condition. See the
 * module comment for how each interpolated value renders.
 */
export const sql: SqlTag = Object.assign(
	(first: CHType<string, any, any> | TemplateStringsArray, ...values: ReadonlyArray<SqlTemplateValue>): any => {
		if (isTemplateStrings(first)) return makeUntypedExpr(fragmentOf(first, values))
		const type = first
		return (strings: TemplateStringsArray, ...inner: ReadonlyArray<SqlTemplateValue>) =>
			makeExpr(fragmentOf(strings, inner), type.schema)
	},
	{
		cond: (strings: TemplateStringsArray, ...values: ReadonlyArray<SqlTemplateValue>): Condition =>
			makeCond(fragmentOf(strings, values)),
		raw: (text: string): SqlRaw => ({ _tag: RawTag, sql: text }),
		ident: (name: string): SqlIdent => ({ _tag: IdentTag, name }),
		join: (values: ReadonlyArray<SqlTemplateValue>, separator = ", "): Expr<unknown> =>
			makeUntypedExpr(lazy(() => values.map(renderValue).join(separator))),
	},
)
