import { Schema, type DateTime } from "effect"
import { makeExpr, operandOf, toFragment, type Comparable, type Condition, type Expr, type ParamsIn, type Widen } from "../ch/expr"
import { acceptsSqlNull, mergeResultSchemas, schemaOf, withoutNull } from "../ch/define-fn"
import { QueryBuilderDefect } from "../ch/errors"
import { fail } from "../ch/failure"
import { builtins, type SqliteOnly } from "../ch/functions/builtin"
import { sqlWindowFunctions } from "../ch/functions/sql-window"
import type { CHType, InferTS } from "../ch/types"
import { compile, str } from "../sql/sql-fragment"

// Each result carries `SqliteOnly`, as `builtins("sqlite", …)` refuses them for
// another dialect at compile: the type refuses them there too.
const aggregate = builtins("sqlite", "aggregate")
const scalar = builtins("sqlite", "scalar")
const sql = (expr: Expr<unknown> | Condition): string => compile(expr.toFragment())
/** An argument as SQL: an expression as it renders, a plain value as a literal (a fraction bound). */
const arg = (value: unknown): string => compile(toFragment(value))
const nullableNumber = Schema.NullOr(Schema.Finite)
const textSchema = Schema.String as Schema.Codec<string, unknown>
const finite = Schema.Finite as Schema.Codec<number, unknown>
const intSchema = Schema.Int as Schema.Codec<number, unknown>

/** `schema`, or `NullOr(schema)` when any of `inputs` can be NULL: the scalar functions return NULL for a NULL argument. */
const nullWith = <A>(schema: Schema.Codec<A, unknown>, ...inputs: ReadonlyArray<unknown>): Schema.Codec<any, unknown> =>
	inputs.some((input) => {
		const inner = schemaOf(input)
		return input === null || (inner !== undefined && acceptsSqlNull(inner))
	})
		? Schema.NullOr(schema)
		: schema

/** What a plain argument decodes as, where a result can be it (`iif(c, $.n, 0)`). */
const valueSchema = (value: unknown): Schema.Codec<any, unknown> | undefined => {
	const schema = schemaOf(value)
	if (schema !== undefined) return schema
	if (value === null) return Schema.Null
	if (typeof value === "string") return textSchema
	if (typeof value === "number") return Number.isInteger(value) ? intSchema : finite
	// SQLite has no boolean: a written `true` reads back as 1.
	if (typeof value === "boolean") return Schema.BooleanFromBit as Schema.Codec<boolean, unknown>
	return undefined
}

/** A JSON path: `$`, then keys and indexes (`$.a.b`, `$[0]`). Written as a literal. */
const jsonPath = (name: string, path: string): string =>
	typeof path === "string" && path.startsWith("$")
		? compile(str(path))
		: fail(new QueryBuilderDefect({ message: `${name}: a JSON path starts with "$", got ${JSON.stringify(path)}` }), "'$'")

/** The value of an argument: an expression's type, a plain value's widened type. */
export type ValueOfArg<X> = X extends Expr<any> ? Exclude<X["_phantom"], undefined> : Widen<X>

/** A plain value or an expression, as a scalar function takes its arguments. */
export type ScalarArg = Expr<any> | string | number | boolean | null

/** The `| null` of an argument: what a SQLite scalar function returns for a NULL argument. */
type NullOf<X> = Extract<ValueOfArg<X>, null>

// Aggregates

export const count = (): Expr<number, SqliteOnly> => makeExpr(aggregate.lazy(() => "count(*)", "count"), Schema.Int)
export const countDistinct = <P>(expr: Expr<unknown, P>): Expr<number, P | SqliteOnly> =>
	makeExpr(aggregate.lazy(() => `count(DISTINCT ${sql(expr)})`, "count"), Schema.Int)
export const countIf = <P>(condition: Condition<P>): Expr<number, P | SqliteOnly> =>
	makeExpr(aggregate.lazy(() => `count(*) FILTER (WHERE ${sql(condition)})`, "count"), Schema.Int)
export const sum = <P>(expr: Expr<number | null, P>): Expr<number | null, P | SqliteOnly> =>
	makeExpr(aggregate.lazy(() => `sum(${sql(expr)})`, "sum"), nullableNumber)
export const avg = <P>(expr: Expr<number | null, P>): Expr<number | null, P | SqliteOnly> =>
	makeExpr(aggregate.lazy(() => `avg(${sql(expr)})`, "avg"), nullableNumber)
export const min = <A, P>(expr: Expr<A, P>): Expr<A | null, P | SqliteOnly> => {
	const schema = schemaOf<A>(expr)
	return makeExpr(aggregate.lazy(() => `min(${sql(expr)})`, "min"), schema === undefined ? undefined : Schema.NullOr(schema))
}
export const max = <A, P>(expr: Expr<A, P>): Expr<A | null, P | SqliteOnly> => {
	const schema = schemaOf<A>(expr)
	return makeExpr(aggregate.lazy(() => `max(${sql(expr)})`, "max"), schema === undefined ? undefined : Schema.NullOr(schema))
}

/**
 * `json_group_array(expr)`: the group's values as a JSON array, decoded as an
 * array of `expr`'s type, or as `type` when given (a `json(schema)` type, say,
 * for values SQLite writes as JSON rather than text).
 */
export function jsonGroupArray<A, P>(expr: Expr<A, P>): Expr<ReadonlyArray<A>, P | SqliteOnly>
export function jsonGroupArray<A, P, C extends CHType<string, any, any>>(expr: Expr<A, P>, type: C): Expr<InferTS<C>, P | SqliteOnly>
export function jsonGroupArray(expr: Expr<unknown, any>, type?: CHType<string, any, any>): Expr<unknown, any> {
	const element = schemaOf(expr)
	return makeExpr(
		aggregate.lazy(() => `json_group_array(${sql(expr)})`, "json_group_array"),
		type !== undefined ? type.schema : element === undefined ? undefined : Schema.fromJsonString(Schema.Array(element)),
	)
}

/**
 * `json_group_object(key, value)`: the group as a JSON object, decoded as a
 * record of `value`'s type, or as `type` when given.
 */
export function jsonGroupObject<A, P1, P2>(key: Expr<string | number, P1>, value: Expr<A, P2>): Expr<Readonly<Record<string, A>>, P1 | P2 | SqliteOnly>
export function jsonGroupObject<P1, P2, C extends CHType<string, any, any>>(
	key: Expr<string | number, P1>,
	value: Expr<unknown, P2>,
	type: C,
): Expr<InferTS<C>, P1 | P2 | SqliteOnly>
export function jsonGroupObject(key: Expr<unknown, any>, value: Expr<unknown, any>, type?: CHType<string, any, any>): Expr<unknown, any> {
	const element = schemaOf(value)
	return makeExpr(
		aggregate.lazy(() => `json_group_object(${sql(key)}, ${sql(value)})`, "json_group_object"),
		type !== undefined ? type.schema : element === undefined ? undefined : Schema.fromJsonString(Schema.Record(Schema.String, element)),
	)
}

// Scalars

export const lower = <P>(expr: Expr<string | null, P>): Expr<string | null, P | SqliteOnly> =>
	makeExpr(scalar.lazy(() => `lower(${sql(expr)})`, "lower"), Schema.NullOr(Schema.String))
export const upper = <P>(expr: Expr<string | null, P>): Expr<string | null, P | SqliteOnly> =>
	makeExpr(scalar.lazy(() => `upper(${sql(expr)})`, "upper"), Schema.NullOr(Schema.String))
/** Text length in SQLite characters, or blob length in bytes. */
export const length = <P>(expr: Expr<string | Uint8Array | null, P>): Expr<number | null, P | SqliteOnly> =>
	makeExpr(scalar.lazy(() => `length(${sql(expr)})`, "length"), Schema.NullOr(Schema.Int))

/**
 * `coalesce(first, fallback)`: `first` unless it is NULL. The fallback is an
 * expression or a plain value, written as a comparison with `first` writes it.
 */
export function coalesce<A, P1, P2>(first: Expr<A | null, P1>, fallback: Expr<A, P2>): Expr<A, P1 | P2 | SqliteOnly>
export function coalesce<A, P1>(first: Expr<A | null, P1>, fallback: Comparable<NonNullable<A>>): Expr<NonNullable<A>, P1 | SqliteOnly>
export function coalesce(first: Expr<unknown, any>, fallback: unknown): Expr<unknown, any> {
	return makeExpr(
		scalar.lazy(() => `coalesce(${sql(first)}, ${compile(operandOf(first, fallback))})`, "coalesce"),
		schemaOf(fallback) ?? withoutNull(schemaOf(first)) ?? valueSchema(fallback),
	)
}

/** `ifnull(expr, fallback)`: SQLite's two-argument `coalesce`. */
export function ifnull<A, P1, P2>(expr: Expr<A | null, P1>, fallback: Expr<A, P2>): Expr<A, P1 | P2 | SqliteOnly>
export function ifnull<A, P1>(expr: Expr<A | null, P1>, fallback: Comparable<NonNullable<A>>): Expr<NonNullable<A>, P1 | SqliteOnly>
export function ifnull(expr: Expr<unknown, any>, fallback: unknown): Expr<unknown, any> {
	return makeExpr(
		scalar.lazy(() => `ifnull(${sql(expr)}, ${compile(operandOf(expr, fallback))})`, "ifnull"),
		schemaOf(fallback) ?? withoutNull(schemaOf(expr)) ?? valueSchema(fallback),
	)
}

/**
 * `(a || b || …)`: the arguments as one text, NULL as soon as one is NULL.
 * Each is an expression or a plain value (`concat($.a, ":", $.b)`).
 */
export const concat = <const Args extends readonly [ScalarArg, ScalarArg, ...ScalarArg[]]>(
	...args: Args
): Expr<string | NullOf<Args[number]>, ParamsIn<Args[number]> | SqliteOnly> =>
	makeExpr(scalar.lazy(() => `(${args.map(arg).join(" || ")})`, "concat"), nullWith(textSchema, ...args))

/** `nullif(expr, value)`: NULL when `expr` equals `value`, else `expr`. */
export const nullif = <A, P1, P2 = never>(expr: Expr<A, P1>, value: Comparable<NonNullable<A>> | Expr<A, P2>): Expr<A | null, P1 | P2 | SqliteOnly> => {
	const schema = schemaOf<A>(expr)
	return makeExpr(
		scalar.lazy(() => `nullif(${sql(expr)}, ${compile(operandOf(expr, value))})`, "nullif"),
		schema === undefined ? undefined : Schema.NullOr(schema),
	)
}

/**
 * `iif(condition, then, otherwise)`: `then` where the condition holds, else
 * `otherwise`. Either is an expression or a plain value; the result decodes as
 * either branch can.
 */
export const iif = <Q, const T extends ScalarArg, const E extends ScalarArg>(
	condition: Condition<Q>,
	then: T,
	otherwise: E,
): Expr<ValueOfArg<T> | ValueOfArg<E>, Q | ParamsIn<T> | ParamsIn<E> | SqliteOnly> =>
	makeExpr(
		scalar.lazy(() => `iif(${sql(condition)}, ${arg(then)}, ${arg(otherwise)})`, "iif"),
		mergeResultSchemas([valueSchema(then), valueSchema(otherwise)]),
	)

/**
 * `CASE WHEN c1 THEN v1 … ELSE otherwise END`. Each value and `otherwise` is
 * an expression or a plain value; without `otherwise` an unmatched row is NULL.
 */
export const caseWhen = <
	const B extends ReadonlyArray<readonly [Condition, ScalarArg]>,
	const E extends ScalarArg = null,
>(
	branches: B,
	otherwise?: E,
): Expr<ValueOfArg<B[number][1]> | ValueOfArg<E>, ParamsIn<B[number][0]> | ParamsIn<B[number][1]> | ParamsIn<E> | SqliteOnly> =>
	makeExpr(
		scalar.lazy(() => {
			if (branches.length === 0) return fail(new QueryBuilderDefect({ message: "caseWhen: needs at least one [condition, value] branch" }), "NULL")
			const whens = branches.map(([when, then]) => `WHEN ${sql(when)} THEN ${arg(then)}`).join(" ")
			return `CASE ${whens} ELSE ${arg(otherwise ?? null)} END`
		}, "case"),
		mergeResultSchemas([...branches.map(([, then]) => valueSchema(then)), valueSchema(otherwise ?? null)]),
	)

/**
 * SQLite's multi-argument `max(a, b, …)`: the largest argument, NULL as soon as
 * one is NULL (unlike Postgres's `greatest`, which skips NULLs).
 */
export const greatest = <const Args extends readonly [ScalarArg, ScalarArg, ...ScalarArg[]]>(
	...args: Args
): Expr<ValueOfArg<Args[number]>, ParamsIn<Args[number]> | SqliteOnly> => extremum("max", args)

/** SQLite's multi-argument `min(a, b, …)`: the smallest argument, NULL as soon as one is NULL. */
export const least = <const Args extends readonly [ScalarArg, ScalarArg, ...ScalarArg[]]>(
	...args: Args
): Expr<ValueOfArg<Args[number]>, ParamsIn<Args[number]> | SqliteOnly> => extremum("min", args)

const extremum = (name: "min" | "max", args: ReadonlyArray<unknown>): Expr<any, any> =>
	makeExpr(scalar.lazy(() => `${name}(${args.map(arg).join(", ")})`, name), mergeResultSchemas(args.map(valueSchema)))

/**
 * `CAST(expr AS <type's SQL>)`, decoded as `type`: `cast($.embeds, SQLite.text)`
 * reads a JSON column as its text, `cast(x, SQLite.integer)` truncates a real.
 * NULL stays NULL.
 */
export const cast = <A, P, C extends CHType<string, any, any>>(expr: Expr<A, P>, type: C): Expr<InferTS<C> | Extract<A, null>, P | SqliteOnly> =>
	makeExpr(
		scalar.lazy(() =>
			/^[A-Za-z][A-Za-z0-9_ ]*(\([0-9, ]*\))?$/.test(type.sql)
				? `CAST(${sql(expr)} AS ${type.sql})`
				: fail(new QueryBuilderDefect({ message: `cast: ${JSON.stringify(type.sql)} is not a SQLite type name` }), "NULL"),
		"cast"),
		nullWith(type.schema as Schema.Codec<InferTS<C>, unknown>, expr),
	)

/** `substr(expr, start, length)`: characters from the 1-based `start`. */
export const substr = <A extends string | null, P, const S extends ScalarArg = number, const L extends ScalarArg = number>(
	expr: Expr<A, P>,
	start: S,
	length?: L,
): Expr<string | Extract<A, null>, P | ParamsIn<S> | ParamsIn<L> | SqliteOnly> =>
	makeExpr(
		scalar.lazy(() => `substr(${[sql(expr), arg(start), ...(length === undefined ? [] : [arg(length)])].join(", ")})`, "substr"),
		nullWith(textSchema, expr),
	)

const trimmer = (name: "trim" | "ltrim" | "rtrim") =>
	<A extends string | null, P, const C extends ScalarArg = string>(
		expr: Expr<A, P>,
		characters?: C,
	): Expr<string | Extract<A, null>, P | ParamsIn<C> | SqliteOnly> =>
		makeExpr(
			scalar.lazy(() => `${name}(${[sql(expr), ...(characters === undefined ? [] : [arg(characters)])].join(", ")})`, name),
			nullWith(textSchema, expr),
		)

/** `trim(expr, characters)`: without spaces (or `characters`) at either end. */
export const trim = trimmer("trim")
/** `ltrim(expr, characters)`: as `trim`, at the start only. */
export const ltrim = trimmer("ltrim")
/** `rtrim(expr, characters)`: as `trim`, at the end only. */
export const rtrim = trimmer("rtrim")

/** `replace(expr, search, replacement)`: every occurrence of `search` replaced. */
export const replace = <A extends string | null, P, const S extends ScalarArg, const R extends ScalarArg>(
	expr: Expr<A, P>,
	search: S,
	replacement: R,
): Expr<string | Extract<A, null> | NullOf<S> | NullOf<R>, P | ParamsIn<S> | ParamsIn<R> | SqliteOnly> =>
	makeExpr(scalar.lazy(() => `replace(${sql(expr)}, ${arg(search)}, ${arg(replacement)})`, "replace"), nullWith(textSchema, expr, search, replacement))

/** `instr(haystack, needle)`: the 1-based position of `needle`, 0 when absent. */
export const instr = <A extends string | null, P, const N extends ScalarArg>(
	haystack: Expr<A, P>,
	needle: N,
): Expr<number | Extract<A, null> | NullOf<N>, P | ParamsIn<N> | SqliteOnly> =>
	makeExpr(scalar.lazy(() => `instr(${sql(haystack)}, ${arg(needle)})`, "instr"), nullWith(intSchema, haystack, needle))

/** `abs(expr)`. */
export const abs = <A extends number | null, P>(expr: Expr<A, P>): Expr<number | Extract<A, null>, P | SqliteOnly> =>
	makeExpr(scalar.lazy(() => `abs(${sql(expr)})`, "abs"), nullWith(finite, expr))

/** `round(expr, digits)`: rounded to `digits` (0) decimal places, as a real. */
export const round = <A extends number | null, P>(expr: Expr<A, P>, digits?: number): Expr<number | Extract<A, null>, P | SqliteOnly> =>
	makeExpr(
		scalar.lazy(() => {
			if (digits !== undefined && !Number.isSafeInteger(digits)) {
				return fail(new QueryBuilderDefect({ message: `round: digits must be an integer, got ${digits}` }), "NULL")
			}
			return `round(${sql(expr)}${digits === undefined ? "" : `, ${digits}`})`
		}, "round"),
		nullWith(finite, expr),
	)

// JSON

/**
 * `json_extract(expr, path)`, decoded as `type`. The type is what you assert
 * the path holds: pass `nullable(type)` when it can be missing (SQLite returns
 * NULL then). `$.a.b`, `$[0]` and `$."odd key"` are paths.
 */
export const jsonExtract = <P, C extends CHType<string, any, any>>(expr: Expr<unknown, P>, path: string, type: C): Expr<InferTS<C>, P | SqliteOnly> =>
	makeExpr(scalar.lazy(() => `json_extract(${sql(expr)}, ${jsonPath("jsonExtract", path)})`, "json_extract"), type.schema as Schema.Codec<InferTS<C>, unknown>)

/**
 * SQLite's `json(expr)`: JSON text, minified, and marked as JSON for the JSON
 * functions around it. Named `json_` because `json(schema)` is the column type.
 */
export const json_ = <A, P>(expr: Expr<A, P>): Expr<string | Extract<A, null>, P | SqliteOnly> =>
	makeExpr(scalar.lazy(() => `json(${sql(expr)})`, "json"), nullWith(textSchema, expr))

/**
 * `json_set(expr, path, value)`: the JSON with `path` set to `value`. A plain
 * string is set as a JSON string; an expression from `json_`, `jsonSet` or
 * `jsonExtract` of an object is set as JSON.
 */
export const jsonSet = <A, P, const V extends ScalarArg>(
	expr: Expr<A, P>,
	path: string,
	value: V,
): Expr<string | Extract<A, null>, P | ParamsIn<V> | SqliteOnly> =>
	makeExpr(scalar.lazy(() => `json_set(${sql(expr)}, ${jsonPath("jsonSet", path)}, ${arg(value)})`, "json_set"), nullWith(textSchema, expr))

// Dates and times
//
// SQLite's date functions read text (`YYYY-MM-DD HH:MM:SS`), a Julian day
// number, or with the `'unixepoch'` modifier a Unix time. They return NULL for
// a value they cannot read, so every result is nullable.

/** A time value as the date functions read it: a column, an expression, `'now'` or a literal. */
export type TimeValue<P = never> = Expr<string | number | DateTime.Utc | null, P> | string | number

const timeFn = <R>(name: string, schema: Schema.Codec<R, unknown>, leading: ReadonlyArray<string>, value: unknown, modifiers: ReadonlyArray<string>) =>
	makeExpr(
		scalar.lazy(() => `${name}(${[...leading.map((text) => compile(str(text))), arg(value), ...modifiers.map((text) => compile(str(text)))].join(", ")})`, name),
		Schema.NullOr(schema),
	)

/** `julianday(value, ...modifiers)`: the Julian day number, a real. `julianday(a) - julianday(b)` is a difference in days. */
export const julianday = <P = never>(value: TimeValue<P>, ...modifiers: ReadonlyArray<string>): Expr<number | null, P | SqliteOnly> =>
	timeFn("julianday", finite, [], value, modifiers)
/** `date(value, ...modifiers)`: `YYYY-MM-DD`. */
export const date = <P = never>(value: TimeValue<P>, ...modifiers: ReadonlyArray<string>): Expr<string | null, P | SqliteOnly> =>
	timeFn("date", textSchema, [], value, modifiers)
/** `datetime(value, ...modifiers)`: `YYYY-MM-DD HH:MM:SS` (with `'subsec'`, milliseconds too). */
export const datetime = <P = never>(value: TimeValue<P>, ...modifiers: ReadonlyArray<string>): Expr<string | null, P | SqliteOnly> =>
	timeFn("datetime", textSchema, [], value, modifiers)
/** `strftime(format, value, ...modifiers)`. */
export const strftime = <P = never>(format: string, value: TimeValue<P>, ...modifiers: ReadonlyArray<string>): Expr<string | null, P | SqliteOnly> =>
	timeFn("strftime", textSchema, [format], value, modifiers)
/** `unixepoch(value, ...modifiers)`: seconds since 1970, an integer (a real with `'subsec'`). SQLite 3.38+. */
export const unixepoch = <P = never>(value: TimeValue<P>, ...modifiers: ReadonlyArray<string>): Expr<number | null, P | SqliteOnly> =>
	timeFn("unixepoch", finite, [], value, modifiers)

// Window functions, used through `over(expr, windowSpec(...))`.

const windows = sqlWindowFunctions("sqlite", intSchema)

/** `expr OVER (spec)`: an aggregate or window function over a window; see `windowSpec`. */
export const over = windows.over
/** `lead(expr, offset, fallback)`: `expr` of a later row of the window, NULL past its end unless a fallback is given. */
export const lead = windows.lead
/** `lag(expr, offset, fallback)`: `expr` of an earlier row of the window. */
export const lag = windows.lag
/** `row_number()`: the 1-based position in the partition. */
export const rowNumber = windows.rowNumber
/** `rank()`: the rank, with gaps after ties. */
export const rank = windows.rank
/** `dense_rank()`: the rank, without gaps. */
export const denseRank = windows.denseRank
/** `first_value(expr)`: `expr` of the frame's first row. */
export const firstValue = windows.firstValue
/** `last_value(expr)`: `expr` of the frame's last row. */
export const lastValue = windows.lastValue

export {
	currentRow,
	following,
	preceding,
	rangeBetween,
	rowsBetween,
	unboundedFollowing,
	unboundedPreceding,
	windowSpec,
	type CompiledWindowSpec,
	type WindowFrameBound,
	type WindowOrderDirection,
	type WindowRowsFrame,
	type WindowSpec,
} from "../ch/functions/window"
