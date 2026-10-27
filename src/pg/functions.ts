// Postgres functions.
//
// The shared operators (`eq`, `and`, `in_`, `like`, arithmetic, `not`) come
// from the builder and render the same everywhere. These are the ones whose
// Postgres spelling or result type differs from ClickHouse's: `count(*)` rather
// than `count()`, `FILTER (WHERE …)` rather than `-If` combinators, and
// aggregates over no rows returning NULL rather than 0.

import { fail } from "../ch/failure"
import { Schema, type DateTime } from "effect"
import { QueryBuilderDefect, QueryBuilderError } from "../ch/errors"
import { makeCond, makeExpr, type Condition, type Expr } from "../ch/expr"
import { schemaOf, withoutNull } from "../ch/define-fn"
import { compile, known, str } from "../sql/sql-fragment"
import { encodeLiteral } from "../ch/literal"
import { jsonPathSchema, type JsonContained, type JsonKey, type JsonPath, type JsonPathValue } from "../ch/json-path"
import type { CHType } from "../ch/types"
import { builtins } from "../ch/functions/builtin"
import * as T from "./types"

const sql = (expr: Expr<unknown> | Condition): string => compile(expr.toFragment())

const aggregate = builtins("postgres", "aggregate")
const scalar = builtins("postgres", "scalar")

const nullableNumber = Schema.NullOr(T.PgNumber) as Schema.Codec<number | null, unknown>
const int8 = T.int8.schema as Schema.Codec<number, unknown>

// Aggregates

/** `count(*)`. */
export const count = (): Expr<number> => makeExpr(aggregate.lazy(() => "count(*)", "count"), int8)

/** `count(DISTINCT expr)`. */
export const countDistinct = <Q = never>(expr: Expr<unknown, Q>): Expr<number, Q> =>
	makeExpr(aggregate.lazy(() => `count(DISTINCT ${sql(expr)})`), int8)

/** `count(*) FILTER (WHERE condition)`: ClickHouse's `countIf`. */
export const countIf = <Q = never>(condition: Condition<Q>): Expr<number, Q> =>
	makeExpr(aggregate.lazy(() => `count(*) FILTER (WHERE ${sql(condition)})`), int8)

/** `sum(expr)`. NULL over no rows, and a string for int8/numeric inputs on the
 *  wire, which the result codec reads as a number. */
export const sum = <Q = never>(expr: Expr<number | null, Q>): Expr<number | null, Q> =>
	makeExpr(aggregate.lazy(() => `sum(${sql(expr)})`), nullableNumber)

/** `sum(expr) FILTER (WHERE condition)`: ClickHouse's `sumIf`. */
export const sumIf = <Q1 = never, Q2 = never>(
	expr: Expr<number | null, Q1>,
	condition: Condition<Q2>,
): Expr<number | null, Q1 | Q2> =>
	makeExpr(aggregate.lazy(() => `sum(${sql(expr)}) FILTER (WHERE ${sql(condition)})`), nullableNumber)

/** `avg(expr)`. NULL over no rows. */
export const avg = <Q = never>(expr: Expr<number | null, Q>): Expr<number | null, Q> =>
	makeExpr(aggregate.lazy(() => `avg(${sql(expr)})`), nullableNumber)

const nullableOf = <A>(expr: Expr<A>): Schema.Codec<A | null, unknown> | undefined => {
	const schema = schemaOf<A>(expr)
	return schema === undefined ? undefined : (Schema.NullOr(schema) as Schema.Codec<A | null, unknown>)
}

/** `min(expr)`, decoding as `expr` does. NULL over no rows. */
export const min = <A, Q = never>(expr: Expr<A, Q>): Expr<A | null, Q> => makeExpr(aggregate.lazy(() => `min(${sql(expr)})`), nullableOf(expr))

/** `max(expr)`, decoding as `expr` does. NULL over no rows. */
export const max = <A, Q = never>(expr: Expr<A, Q>): Expr<A | null, Q> => makeExpr(aggregate.lazy(() => `max(${sql(expr)})`), nullableOf(expr))

/** `percentile_cont(fraction) WITHIN GROUP (ORDER BY expr)`: an interpolated
 *  quantile, ClickHouse's `quantileExact` family. */
export const percentileCont = <Q = never>(fraction: number, expr: Expr<number | null, Q>): Expr<number | null, Q> => {
	return makeExpr(
		aggregate.lazy(() =>
			fraction >= 0 && fraction <= 1
				? `percentile_cont(${fraction}) WITHIN GROUP (ORDER BY ${sql(expr)})`
				: fail(new QueryBuilderDefect({ message: `percentileCont: fraction must be within [0, 1], got ${fraction}` }), "NULL"),
		),
		nullableNumber,
	)
}

/** `array_agg(expr)`. NULL over no rows. */
export const arrayAgg = <A, Q = never>(expr: Expr<A, Q>): Expr<ReadonlyArray<A> | null, Q> => {
	const element = schemaOf<A>(expr)
	return makeExpr(
		aggregate.lazy(() => `array_agg(${sql(expr)})`),
		element === undefined ? undefined : (Schema.NullOr(Schema.Array(element)) as Schema.Codec<ReadonlyArray<A> | null, unknown>),
	)
}

// Time

const timestamptz = T.timestamptz.schema as Schema.Codec<DateTime.Utc, unknown>

export type DateTruncUnit = "second" | "minute" | "hour" | "day" | "week" | "month" | "quarter" | "year"

/** `date_trunc(unit, ts, 'UTC')`: buckets in UTC whatever the session time
 *  zone, as ClickHouse's `toStartOf*` functions do. Postgres 12+. */
export const dateTrunc = <Q = never>(unit: DateTruncUnit, ts: Expr<DateTime.Utc, Q>): Expr<DateTime.Utc, Q> =>
	makeExpr(scalar.lazy(() => `date_trunc(${compile(str(unit))}, ${sql(ts)}, 'UTC')`), timestamptz)

/** `date_bin(seconds, ts, epoch)`: fixed-width buckets aligned to the Unix
 *  epoch, ClickHouse's `toStartOfInterval`. Postgres 14+. */
export const dateBin = <Q = never>(seconds: number, ts: Expr<DateTime.Utc, Q>): Expr<DateTime.Utc, Q> => {
	return makeExpr(
		scalar.lazy(() =>
			Number.isSafeInteger(seconds) && seconds > 0
				? `date_bin(make_interval(secs => ${seconds}), ${sql(ts)}, TIMESTAMPTZ '1970-01-01 00:00:00+00')`
				: fail(new QueryBuilderDefect({ message: `dateBin: bucket width must be a positive whole number of seconds, got ${seconds}` }), "NULL"),
		),
		timestamptz,
	)
}

/** `now()`: the transaction's start time. */
export const now = (): Expr<DateTime.Utc> => makeExpr(scalar.lazy(() => "now()", "now"), timestamptz)

// Strings and values

const text = T.text.schema as Schema.Codec<string, unknown>

export const lower = <Q = never>(expr: Expr<string, Q>): Expr<string, Q> => makeExpr(scalar.lazy(() => `lower(${sql(expr)})`), text)
export const upper = <Q = never>(expr: Expr<string, Q>): Expr<string, Q> => makeExpr(scalar.lazy(() => `upper(${sql(expr)})`), text)
export const length = <Q = never>(expr: Expr<string, Q>): Expr<number, Q> =>
	makeExpr(scalar.lazy(() => `length(${sql(expr)})`), T.int4.schema as Schema.Codec<number, unknown>)

/** `coalesce(expr, fallback)`, no longer nullable. */
export const coalesce = <A, Q1 = never, Q2 = never>(expr: Expr<A | null, Q1>, fallback: Expr<A, Q2>): Expr<A, Q1 | Q2> =>
	makeExpr(
		scalar.lazy(() => `coalesce(${sql(expr)}, ${sql(fallback)})`),
		schemaOf<A>(fallback) ?? withoutNull(schemaOf<A | null>(expr)),
	)

/** `expr ->> key`: a jsonb field as text, NULL when it is absent. */
export const jsonText = <Q = never>(expr: Expr<unknown, Q>, key: string): Expr<string | null, Q> =>
	makeExpr(scalar.lazy(() => `(${sql(expr)} ->> ${compile(str(key))})`), Schema.NullOr(Schema.String) as Schema.Codec<string | null, unknown>)

// jsonb paths
//
// The path's type and decoder come from the column's schema (src/ch/json-path.ts);
// only the SQL below is Postgres's. Keys are written as literals, not bound, so
// an expression index on `payload -> 'profile'` matches the query.

const describePath = (path: ReadonlyArray<JsonKey>): string => JSON.stringify(path)

/** One key of a path as SQL: a string literal, or an array index. */
const pathKey = (key: JsonKey, path: ReadonlyArray<JsonKey>): string =>
	typeof key === "string"
		? compile(str(key))
		: Number.isSafeInteger(key)
			? String(key)
			: fail(new QueryBuilderDefect({ message: `jsonPath ${describePath(path)}: an array index must be a whole number, got ${key}` }), "0")

/** The keys as `-> k1 -> k2`, the last one with `last` (`->` or `->>`). */
const arrows = (path: ReadonlyArray<JsonKey>, last: "->" | "->>"): string =>
	path.length === 0
		? fail(new QueryBuilderDefect({ message: "jsonPath: a path needs at least one key" }), "")
		: path.map((key, i) => ` ${i === path.length - 1 ? last : "->"} ${pathKey(key, path)}`).join("")

/** The schema at `path` inside `expr`'s document; a path the schema does not have is a defect when rendered. */
const pathSchema = (
	expr: Expr<unknown, any>,
	path: ReadonlyArray<JsonKey>,
): { readonly schema: Schema.Codec<unknown, unknown> | undefined; readonly check: () => void } => {
	if (expr.schema === undefined) return { schema: undefined, check: () => undefined }
	const found = jsonPathSchema(expr.schema, path)
	return found._tag === "Found"
		? { schema: found.schema, check: () => undefined }
		: {
				schema: Schema.Unknown as Schema.Codec<unknown, unknown>,
				check: () => fail(new QueryBuilderDefect({ message: `jsonPath ${describePath(path)}: the column's schema has no such path (${found.reason})` }), undefined),
			}
}

/** A value as JSON text through `schema`, bound, cast to jsonb. `null` is JSON null; `undefined` has no JSON. */
const jsonValue = (schema: Schema.Codec<unknown, unknown>, value: unknown, context: string): string =>
	value === undefined
		? fail(new QueryBuilderError({ code: "InvalidArguments", message: `${context}: undefined has no JSON form` }), "NULL")
		: `${encodeLiteral(Schema.fromJsonString(schema), value, context)}::jsonb`

/**
 * `expr -> 'k1' -> 'k2'`: the jsonb value at a path, typed and decoded by the
 * column's schema. `jsonPath($.payload, "profile", "city")` on a
 * `jsonb(Schema.Struct({ profile: Schema.Struct({ city: Schema.String }) }))`
 * column is an `Expr<string | null>`; a number key indexes an array. `null` when
 * a key is absent. Compared with a value, the value is encoded by the field's
 * schema and bound as JSON: `.eq("Kyiv")` matches the JSON string `"Kyiv"`.
 */
export const jsonPath = <A, const P extends JsonPath<A>, Q = never>(
	expr: Expr<A, Q>,
	...path: P
): Expr<Exclude<JsonPathValue<A, P>, undefined> | null, Q> => {
	const keys = path as unknown as ReadonlyArray<JsonKey>
	const { schema, check } = pathSchema(expr as Expr<unknown, any>, keys)
	const context = `jsonPath ${describePath(keys)}`
	return makeExpr(
		scalar.lazy(() => {
			check()
			return `(${sql(expr)}${arrows(keys, "->")})`
		}, "jsonPath"),
		schema === undefined ? undefined : (Schema.NullOr(schema) as Schema.Codec<Exclude<JsonPathValue<A, P>, undefined> | null, unknown>),
		(value) => known(() => encodeLiteral(Schema.fromJsonString(schema ?? Schema.Unknown), value, context)),
	)
}

/**
 * `expr -> 'k1' ->> 'k2'`: the value at a path as text, `null` when a key is
 * absent. A JSON string reads without its quotes; a number or object as its JSON
 * text. For `like`, `ilike` and text comparisons.
 */
export const jsonPathText = <A, const P extends JsonPath<A>, Q = never>(expr: Expr<A, Q>, ...path: P): Expr<string | null, Q> => {
	const keys = path as unknown as ReadonlyArray<JsonKey>
	const { check } = pathSchema(expr as Expr<unknown, any>, keys)
	return makeExpr(
		scalar.lazy(() => {
			check()
			return `(${sql(expr)}${arrows(keys, "->>")})`
		}, "jsonPathText"),
		Schema.NullOr(Schema.String) as Schema.Codec<string | null, unknown>,
		(value) => known(() => encodeLiteral(Schema.String, value, `jsonPathText ${describePath(keys)}`)),
	)
}

/**
 * `expr @> value::jsonb`: whether the document contains `value`, at any depth.
 * Objects match on the keys given, arrays on the elements given (in any order).
 * The value is bound as JSON text, as given: write a transformed field in its
 * stored form. A GIN index on the column serves it.
 */
export const jsonContains = <A, Q = never>(expr: Expr<A, Q>, value: JsonContained<A>): Condition<Q> =>
	makeCond(
		scalar.lazy(
			() => `(${sql(expr)} @> ${jsonValue(Schema.Unknown as Schema.Codec<unknown, unknown>, value, "jsonContains")})`,
			"jsonContains",
		),
	)

/**
 * `jsonb_set(expr, ARRAY['k1', 'k2'], value::jsonb)`: the document with one
 * path replaced, to write in `set` without reading the row first. The value is
 * encoded by the field's schema. The last key is created if it is absent; a
 * missing parent leaves the document unchanged, and a NULL document stays NULL.
 * Nest calls to set several paths.
 */
export const jsonSet = <A, const P extends JsonPath<A>, Q = never>(
	expr: Expr<A, Q>,
	path: P,
	value: Exclude<JsonPathValue<A, P>, undefined>,
): Expr<A, Q> => {
	const keys = path as unknown as ReadonlyArray<JsonKey>
	const { schema, check } = pathSchema(expr as Expr<unknown, any>, keys)
	const context = `jsonSet ${describePath(keys)}`
	return makeExpr(
		scalar.lazy(() => {
			check()
			if (keys.length === 0) return fail(new QueryBuilderDefect({ message: "jsonSet: a path needs at least one key" }), "NULL")
			// jsonb_set takes the path as text[], an array index too.
			const text = keys.map((key) => (typeof key === "number" ? `${pathKey(key, keys)}::text` : pathKey(key, keys)))
			return `jsonb_set(${sql(expr)}, ARRAY[${text.join(", ")}], ${jsonValue(schema ?? (Schema.Unknown as Schema.Codec<unknown, unknown>), value, context)})`
		}, "jsonSet"),
		expr.schema,
	)
}

/** `greatest(a, b, ...)`, decoding as `first` does. Postgres skips NULL arguments. */
export const greatest = <A, Q = never>(first: Expr<A, Q>, ...rest: ReadonlyArray<Expr<A, Q>>): Expr<A, Q> =>
	makeExpr(scalar.lazy(() => `greatest(${[first, ...rest].map(sql).join(", ")})`), schemaOf<A>(first))

/** `least(a, b, ...)`, decoding as `first` does. Postgres skips NULL arguments. */
export const least = <A, Q = never>(first: Expr<A, Q>, ...rest: ReadonlyArray<Expr<A, Q>>): Expr<A, Q> =>
	makeExpr(scalar.lazy(() => `least(${[first, ...rest].map(sql).join(", ")})`), schemaOf<A>(first))

/**
 * `CASE WHEN c1 THEN v1 ... ELSE otherwise END`, decoding as `otherwise` does.
 * Every branch has the result's type.
 */
export const caseWhen = <A, Q = never>(
	branches: ReadonlyArray<readonly [Condition<Q>, Expr<A, Q>]>,
	otherwise: Expr<A, Q>,
): Expr<A, Q> =>
	makeExpr(
		scalar.lazy(
			() => `CASE ${branches.map(([when, then]) => `WHEN ${sql(when)} THEN ${sql(then)}`).join(" ")} ELSE ${sql(otherwise)} END`,
		),
		schemaOf<A>(otherwise),
	)

/** A condition as a boolean value, to select it or `set` a column from it. */
export const asBoolean = <Q = never>(condition: Condition<Q>): Expr<boolean, Q> =>
	makeExpr(scalar.lazy(() => `(${sql(condition)})`), Schema.Boolean as Schema.Codec<boolean, unknown>)

/**
 * A value written as a column type writes it: encoded by its codec and bound,
 * so `typedValue(T.columns.at, ms)` is a timestamptz wherever an expression goes.
 */
export const typedValue = <A>(type: CHType<string, A, any>, value: A): Expr<A> =>
	makeExpr(known(() => encodeLiteral(type.literalSchema, value, "typedValue")), type.schema as Schema.Codec<A, unknown>)
