// BOUNDARY: This module owns unparsed values on their way into SQL — whatever a
// caller wrote on the right of a comparison — and narrows them, through the
// column's codec where there is one, before they reach a fragment.
// Expression System
//
// Typed expressions that compile to SqlFragment. Every Expr<T> carries a
// phantom TSType so TypeScript can infer output row types from SELECT clauses.

import { type Brand, DateTime, Result, Schema } from "effect"
import type { SqlFragment } from "../sql/sql-fragment"
import { raw, str, ident, compile, as_ as sqlAs, known } from "../sql/sql-fragment"
import { activeSqlSyntax } from "../sql/sql-syntax"
import { chDateTimeLiteral, CHFloatResult, CHNumber, string as chString, type CHType, type InferTS } from "./types"
import { encodeColumnLiteral } from "./literal"
import { QueryBuilderError } from "./errors"
import { markTenantColumn, markTenantPredicate, tenantColumnOf, tenantPredicatesOf } from "./tenant"

// Core interfaces

/**
 * What a value of this type can be compared against in SQL.
 *
 * A `DateTime` column is a `DateTime.Utc` when it comes back, but writing a
 * bound as `'2026-01-01 00:00:00'` or a `Date` is how anyone actually writes
 * one — and all three serialize to the same literal.
 */
export type Comparable<TSType> = TSType extends DateTime.Utc ? DateTime.Utc | Date | string : TSType

/**
 * What a comparison widens a column's type to: a literal union to its
 * primitive (`"open" | "closed"` compares against any `string`; the server
 * checks the value), but a branded type stays branded.
 *
 * A brand is the claim that a value is one kind of id and not another, so an
 * `OrgId` column compares against an `OrgId`: a value, another `OrgId` column,
 * or a param declared with the column's type (`param.of(OrgIdColumn, "orgId")`).
 * A plain `string`, a `UserId`, or `param.string` is a type error, which is
 * what catches `$.OrgId.eq(userId)`.
 */
export type Widen<TSType> = TSType extends Brand.Brand<any>
	? TSType
	: TSType extends string
		? string
		: TSType extends number
			? number
			: TSType

// Params in the type
//
// An expression remembers the `param.*` placeholders it contains, so a query
// can say which params it needs and `compile` / `Database.run` can require
// them. Each one is a `ParamEntry`; an expression's are a union of them, `never`
// when it has none.
//
// The entries ride on a phantom *function parameter*, which makes them
// contravariant: an `Expr<T, Entries>` is assignable to a plain `Expr<T>`, so
// every function written against `Expr<T>` still accepts one. A function that
// does not pass its arguments' entries on to its result drops them from the
// type; the param is then still checked when compiling, just not by the type.

/** One `param.*` placeholder: its name and the value it is filled with. */
export interface ParamEntry<Name extends string = string, Value = unknown> {
	readonly name: Name
	readonly value: Value
}

/** The params of an expression, condition, or a union or array of them. */
export type ParamsIn<X> = 0 extends 1 & X
	? never
	: X extends { readonly _params?: (entries: infer P) => void }
		? 0 extends 1 & P
			? never
			: [P] extends [ParamEntry]
				? P
				: never
		: never

/** The value a param needs: every entry's type for that name, intersected
 *  per entry (a `boolean` entry stays `boolean`, not `true & false`). */
type ValueOf<P, N> =
	UnionToIntersection<P extends { readonly name: N; readonly value: infer V } ? { readonly v: V } : never> extends {
		readonly v: infer V
	}
		? V
		: never

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never

/**
 * The params object a set of entries asks for: one key per name. A name used
 * with two value types needs a value of both.
 */
export type ParamsRecord<P> = [P] extends [never]
	? {}
	: [P] extends [ParamEntry]
		? { readonly [N in P["name"]]: ValueOf<P, N> }
		: {}

/**
 * `unknown` when `Given` fills every param in `P` with a value of its type;
 * otherwise a property spelling out the params object that is needed. Extra
 * keys are allowed, so one params object can serve several queries.
 */
export type ParamsSatisfied<P, Given> = [P] extends [never]
	? unknown
	: Given extends ParamsRecord<P>
		? unknown
		: { readonly paramsRequired: ParamsRecord<P> }

export interface Expr<TSType, P = never> {
	readonly _brand: "Expr"
	readonly _phantom?: TSType
	/** phantom: the `param.*` placeholders inside this expression. */
	readonly _params?: (entries: P) => void
	/**
	 * How this expression's wire value decodes, when the builder knows it.
	 *
	 * Column refs take it from their table; function wrappers declare their own
	 * result type. `compile` folds the selected expressions' schemas into the
	 * row schema, so a query built entirely from typed pieces validates its rows
	 * without anyone writing a schema. Absent for `rawExpr`/`dynamicColumn`,
	 * where there is nothing to read it from.
	 */
	readonly schema?: Schema.Codec<TSType, unknown>
	toFragment(): SqlFragment

	// Comparison — returns Condition. `Expr<TSType>` is listed alongside the
	// widened form because `Expr` is invariant: a literal-union column must
	// accept both its own refs and plain-primitive exprs (params, other columns).
	// The widened arms sit in contravariant positions, which TypeScript's
	// `extends Expr<infer T>` inference would prefer — the reason `InferOutput`
	// reads the `_phantom` property instead of structurally inferring T.
	//
	// A plain value is never `null`: `x = NULL` is never true in SQL, so it is
	// refused here and at compile time. Use `isNull()` / `isNotNull()`.
	eq<Q = never>(other: Operand<TSType, Q>): Condition<P | Q>
	neq<Q = never>(other: Operand<TSType, Q>): Condition<P | Q>
	gt<Q = never>(other: Operand<TSType, Q>): Condition<P | Q>
	gte<Q = never>(other: Operand<TSType, Q>): Condition<P | Q>
	lt<Q = never>(other: Operand<TSType, Q>): Condition<P | Q>
	lte<Q = never>(other: Operand<TSType, Q>): Condition<P | Q>

	// String operations. A `Nullable(String)` matches like a `String`.
	like(this: Expr<string | null>, pattern: string): Condition<P>
	notLike(this: Expr<string | null>, pattern: string): Condition<P>
	ilike(this: Expr<string | null>, pattern: string): Condition<P>

	// NULL and ranges
	/** `expr IS NULL`. */
	isNull(): Condition<P>
	/** `expr IS NOT NULL`. */
	isNotNull(): Condition<P>
	/** `expr BETWEEN low AND high`, both ends included. */
	between<Q1 = never, Q2 = never>(low: Operand<TSType, Q1>, high: Operand<TSType, Q2>): Condition<P | Q1 | Q2>
	/** `expr NOT BETWEEN low AND high`. */
	notBetween<Q1 = never, Q2 = never>(low: Operand<TSType, Q1>, high: Operand<TSType, Q2>): Condition<P | Q1 | Q2>

	// IN / NOT IN. An empty list is false (`IN`) or true (`NOT IN`), written
	// `1 = 0` / `1 = 1`, rather than the `IN ()` no database accepts.
	in_(...values: Array<Comparable<Widen<NonNullable<TSType>>>>): Condition<P>
	notIn(...values: Array<Comparable<Widen<NonNullable<TSType>>>>): Condition<P>

	// JSON represents non-finite division results as null. Other arithmetic
	// propagates SQL NULL from either operand.
	div<R extends number | null, Q = never>(this: Expr<number | null>, n: R | Expr<R, Q>): Expr<Quotient<TSType, R>, P | Q>
	mul<R extends number | null, Q = never>(
		this: Expr<number | null>,
		n: R | Expr<R, Q>,
	): Expr<number | Extract<TSType | R, null>, P | Q>
	add<R extends number | null, Q = never>(
		this: Expr<number | null>,
		n: R | Expr<R, Q>,
	): Expr<number | Extract<TSType | R, null>, P | Q>
	sub<R extends number | null, Q = never>(
		this: Expr<number | null>,
		n: R | Expr<R, Q>,
	): Expr<number | Extract<TSType | R, null>, P | Q>
	mod<R extends number | null, Q = never>(this: Expr<number | null>, n: R | Expr<R, Q>): Expr<Quotient<TSType, R>, P | Q>
}

/**
 * What a comparison takes on its right: a value of the column's type (never
 * `null`), or an expression of it.
 */
export type Operand<TSType, Q = never> =
	| Comparable<Widen<NonNullable<TSType>>>
	| Expr<TSType, Q>
	| Expr<Widen<TSType>, Q>

/**
 * What `/` and `%` decode to. A numeric literal divisor of magnitude >= 1
 * cannot manufacture `inf`/`nan` from a finite dividend, so `x.div(1_000_000)`
 * stays as nullable as `x`. Anything else — a zero, a literal below 1 (which
 * can overflow: `1 / 5e-324` is `inf`), a plain `number`, another expression —
 * can, and ClickHouse sends both as JSON `null`. A literal below 1 is spotted
 * by how it prints: `0.5`, `-0.5`, or `1e-7`.
 */
export type Quotient<L, R> = [R] extends [number]
	? 0 extends R
		? number | null
		: `${R}` extends `0.${string}` | `-0.${string}` | `${string}e-${string}`
			? number | null
			: number | Extract<L, null>
	: number | null

export interface ColumnRef<Name extends string, ColType extends CHType<string, any>> extends Expr<
	InferTS<ColType>
> {
	readonly columnName: Name
	/**
	 * Access a key in a Map column: `$.Attrs.get("http.method")`.
	 *
	 * The result decodes as the map's *value* type, read off the column's
	 * `element`. A `Map(String, String)` subscript is an `Expr<string>` that
	 * knows it is one, so selecting it no longer costs the query its row schema.
	 */
	get(this: ColumnRef<Name, CHType<"Map", any, any>>, key: string): Expr<MapValueOf<ColType>>
}

/**
 * A Map column's value type, defaulting to `string`.
 *
 * Wrapped in tuples so an `any` column type — `ColumnRef<"Attrs", any>`, which
 * is how a helper shared across two tables usually types its accessor — takes
 * the `infer` branch and yields `any`, rather than distributing into `unknown`
 * and failing to assign anywhere.
 */
export type MapValueOf<ColType> = [ColType] extends [CHType<"Map", Record<string, infer V>, any>] ? V : string

export interface Condition<P = never> {
	readonly _brand: "Condition"
	/** phantom: the `param.*` placeholders inside this condition. */
	readonly _params?: (entries: P) => void
	toFragment(): SqlFragment
	and<Q = never>(other: Condition<Q>): Condition<P | Q>
	or<Q = never>(other: Condition<Q>): Condition<P | Q>
}

// Core helpers (exported for define-fn.ts and consumer extensibility)

/** An already-built expression or condition, rather than a value to encode. */
export const isExprLike = (value: unknown): value is Expr<unknown> =>
	value != null &&
	typeof value === "object" &&
	"_brand" in value &&
	((value as { readonly _brand?: unknown })._brand === "Expr" ||
		(value as { readonly _brand?: unknown })._brand === "Condition") &&
	"toFragment" in value &&
	typeof (value as { readonly toFragment?: unknown }).toFragment === "function"

export function toFragment(value: unknown): SqlFragment {
	if (isExprLike(value)) return value.toFragment()
	if (typeof value === "string") return str(value)
	if (typeof value === "number") return raw(String(value))
	if (typeof value === "boolean") return known(() => untypedLiteral(value))
	// A DateTime column compares against a DateTime value, so the literal has to
	// be the dialect's own form (ClickHouse's is tz-less) rather than whatever
	// `String(value)` produces.
	if (DateTime.isDateTime(value)) return known(() => dateTimeLiteral(DateTime.toUtc(value)))
	if (value instanceof Date) return known(() => dateTimeLiteral(DateTime.makeUnsafe(value)))
	return raw(String(value))
}

/** A value with no column type to encode it, in the active dialect's syntax.
 *  ClickHouse writes booleans as `1`/`0`, which is also the rendering outside
 *  a compile. */
const untypedLiteral = (value: boolean): string =>
	activeSqlSyntax()?.literal(value, "an untyped boolean") ?? (value ? "1" : "0")

const dateTimeLiteral = (value: DateTime.Utc): string =>
	activeSqlSyntax()?.dateTimeLiteral(value) ?? compile(str(chDateTimeLiteral(value)))

// Expr implementation

/**
 * A plain `null` (or `undefined`) on the right of a comparison. `x = NULL` is
 * never true, so this is refused rather than written. A failure, not a defect:
 * the value usually comes from data the types said could not be null.
 */
const refusedNull = (value: null | undefined): never => {
	throw new QueryBuilderError({
		code: "InvalidArguments",
		message: `compared against ${String(value)}, which SQL never matches; use isNull() / isNotNull()`,
	})
}

/**
 * `expr IN (…)` / `expr NOT IN (…)`. An empty list has no SQL spelling, so it
 * is written as the constant it means: nothing is in it, everything is not.
 */
const inCond = (
	fragment: SqlFragment,
	op: "IN" | "NOT IN",
	values: ReadonlyArray<() => SqlFragment>,
): Condition<any> =>
	makeCond(
		known(() =>
			values.length === 0
				? op === "IN"
					? "1 = 0"
					: "1 = 1"
				: `${compile(fragment)} ${op} (${values.map((v) => compile(v())).join(", ")})`,
		),
	)

/** Whether a codec accepts `null` — asked, not inferred from its AST, so it
 *  stays right across Effect versions and across `T.custom` schemas. */
const acceptsNull = (schema: Schema.Codec<any, any> | undefined): boolean =>
	schema !== undefined && Result.isSuccess(Schema.decodeUnknownResult(schema)(null))

/** Numeric promotion and SQL NULL propagation share one runtime codec. The
 *  result type is the caller's claim — see {@link Quotient} for `/` and `%`. */
const arith = <Result>(
	lhs: SqlFragment,
	op: string,
	rhs: number | null | Expr<number | null>,
	lhsSchema?: Schema.Codec<any, any>,
): Expr<Result, any> => {
	const rhsSchema = typeof rhs === "number" || rhs === null ? undefined : rhs.schema
	// `x / 1000000` is finite whenever `x` is. A literal below 1 in magnitude
	// can overflow a large dividend (`1 / 5e-324` is `inf`), so only |d| >= 1
	// keeps the strict codec — the same rule `Quotient` applies to the type.
	const safeDivisor = typeof rhs === "number" && Number.isFinite(rhs) && Math.abs(rhs) >= 1
	const nullable =
		((op === "/" || op === "%") && !safeDivisor) ||
		rhs === null ||
		acceptsNull(lhsSchema) ||
		acceptsNull(rhsSchema)
	// `+`, `-`, `*` can overflow a Float64 to `inf`, sent as JSON null: NaN.
	const overflows = op === "+" || op === "-" || op === "*"
	return makeExpr(
		known(() => `${compile(lhs)} ${op} ${compile(toFragment(rhs))}`),
		(nullable ? Schema.NullOr(CHNumber) : overflows ? CHFloatResult : CHNumber) as Schema.Codec<Result, any>,
	) as Expr<Result, any>
}

/**
 * An expression from a fragment and the codec its wire value decodes with.
 *
 * The schema is a required argument that accepts `undefined`, rather than an
 * optional one. Omitting it entirely was the last silent way to cost a query
 * its whole row schema — derivation is all-or-nothing, so one unschema'd field
 * makes the query decode nothing — and `undefined` is what a wrapper *forwards*
 * when its own argument was untyped (`schemaOf(arg)`), not what it means to
 * write. For an expression that genuinely has no type, use
 * {@link makeUntypedExpr}, which says so.
 */
export function makeExpr<T>(
	fragment: SqlFragment,
	schema: Schema.Codec<T, any> | undefined,
	/**
	 * How a plain value compared against this expression becomes a literal.
	 *
	 * Set for column refs, which know their own type: `$.Attrs.eq({ a: "b" })`
	 * then emits `map('a', 'b')` instead of `[object Object]`. Expressions with
	 * no type to read fall back to guessing from the JS value.
	 */
	literal?: (value: unknown) => SqlFragment,
): Expr<T, any> {
	/** An operand: another expression as-is, a plain value through the codec. */
	function operand(value: unknown): SqlFragment {
		if (value === null || value === undefined) return refusedNull(value)
		return literal !== undefined && !isExprLike(value) ? literal(value) : toFragment(value)
	}

	// Keep operand rendering lazy so nested subqueries reach the owning compiler.
	// `any` params: the phantom is a type-level fact, and every method's result
	// carries what its signature says.
	const self: Expr<T, any> = {
		_brand: "Expr" as const,
		...(schema !== undefined ? { schema } : undefined),
		toFragment: () => fragment,

		eq: (other) => makeCond(known(() => `${compile(fragment)} = ${compile(operand(other))}`)),
		neq: (other) => makeCond(known(() => `${compile(fragment)} != ${compile(operand(other))}`)),
		gt: (other) => makeCond(known(() => `${compile(fragment)} > ${compile(operand(other))}`)),
		gte: (other) => makeCond(known(() => `${compile(fragment)} >= ${compile(operand(other))}`)),
		lt: (other) => makeCond(known(() => `${compile(fragment)} < ${compile(operand(other))}`)),
		lte: (other) => makeCond(known(() => `${compile(fragment)} <= ${compile(operand(other))}`)),

		isNull: () => makeCond(known(() => `${compile(fragment)} IS NULL`)),
		isNotNull: () => makeCond(known(() => `${compile(fragment)} IS NOT NULL`)),
		between: (low, high) =>
			makeCond(known(() => `${compile(fragment)} BETWEEN ${compile(operand(low))} AND ${compile(operand(high))}`)),
		notBetween: (low, high) =>
			makeCond(known(() => `${compile(fragment)} NOT BETWEEN ${compile(operand(low))} AND ${compile(operand(high))}`)),

		like: (pattern: string) => makeCond(known(() => `${compile(fragment)} LIKE ${compile(str(pattern))}`)),
		notLike: (pattern: string) => makeCond(known(() => `${compile(fragment)} NOT LIKE ${compile(str(pattern))}`)),
		ilike: (pattern: string) => makeCond(known(() => `${compile(fragment)} ILIKE ${compile(str(pattern))}`)),

		in_: (...values) => inCond(fragment, "IN", values.map((v) => () => operand(v))),
		notIn: (...values) => inCond(fragment, "NOT IN", values.map((v) => () => operand(v))),

		// NOTE: these do NOT parenthesize their result, so chaining follows SQL
		// operator precedence rather than call order — `a.sub(b).div(c)` compiles
		// to `a - b / c`, i.e. `a - (b / c)`. Order the calls so precedence works
		// in your favour, or bind an intermediate alias in a sub-query.
		//
		// The result is always `CHNumber` rather than the operand's own type:
		// ClickHouse promotes across the arithmetic operators (`UInt64 / UInt64`
		// is a Float64), and `CHNumber` is the one codec that reads every numeric
		// wire form either backend can send.
		div: <R extends number | null>(n: R | Expr<R>) => arith<Quotient<T, R>>(fragment, "/", n, schema),
		mul: <R extends number | null>(n: R | Expr<R>) =>
			arith<number | Extract<T | R, null>>(fragment, "*", n, schema),
		add: <R extends number | null>(n: R | Expr<R>) =>
			arith<number | Extract<T | R, null>>(fragment, "+", n, schema),
		sub: <R extends number | null>(n: R | Expr<R>) =>
			arith<number | Extract<T | R, null>>(fragment, "-", n, schema),
		mod: <R extends number | null>(n: R | Expr<R>) => arith<Quotient<T, R>>(fragment, "%", n, schema),
	}
	return self
}

/**
 * An expression with no declared result type — {@link untypedExpr}'s
 * counterpart for a caller assembling its own fragment.
 *
 * Selecting one costs the whole query its derived row schema, which
 * `CompiledQuery.rowSchemaSource` reports as `"none"`. The legitimate use is a
 * value that never becomes a row.
 */
export function makeUntypedExpr<T = unknown>(
	fragment: SqlFragment,
	literal?: (value: unknown) => SqlFragment,
): Expr<T, any> {
	return makeExpr<T>(fragment, undefined, literal)
}

// Retain column descriptors through direct projections into derived sources.
const columnTypes = new WeakMap<Expr<any>, CHType<string, any, any>>()
export const columnTypeOf = (expr: Expr<any>): CHType<string, any, any> | undefined => columnTypes.get(expr)

// ColumnRef implementation

export function makeColumnRef<Name extends string, ColType extends CHType<string, any>>(
	name: Name,
	/**
	 * Unqualified column name. Differs from `name` for joined accessors, where
	 * `name` is `alias.Column` — so `$.p.TenantId.eq(…)` still marks the query as
	 * scoped.  Defaults to `name` for the unqualified case.
	 */
	columnName?: string,
	/**
	 * The owning table's tenant column, if it declared one. An equality or
	 * membership test on that column is what marks a query as tenant-scoped
	 * (`CompiledQuery.tenantScope`). Row-per-tenant is the usual ClickHouse
	 * multi-tenancy shape, but whether a schema has one — and what it is called —
	 * is a schema decision, so it travels with the table rather than being a
	 * constant here.
	 */
	tenantColumn?: string,
	/** The column's declared type, whose schema decodes its wire value. */
	columnType?: ColType,
): ColumnRef<Name, ColType> {
	// `alias.Column` when qualified: the qualifier is quoted segment by segment,
	// the column as one identifier (a ClickHouse `Nested` column has a dot).
	const qualified = columnName !== undefined && name.endsWith(`.${columnName}`)
	const fragment = qualified ? ident(columnName, name.slice(0, -columnName.length - 1)) : ident(name)
	const base = makeExpr<InferTS<ColType>>(
		fragment,
		columnType?.schema as Schema.Codec<InferTS<ColType>, any> | undefined,
		columnType === undefined
			? undefined
			: (value) => raw(encodeColumnLiteral(columnType, value, columnName ?? name)),
	)
	if (columnType !== undefined) columnTypes.set(base, columnType)
	const isTenantColumn = tenantColumn !== undefined && (columnName ?? name) === tenantColumn
	const baseEq = base.eq
	const baseIn = base.in_
	if (isTenantColumn) markTenantColumn(base, name)
	const bound = (value: unknown): SqlFragment | undefined => {
		if (isExprLike(value)) {
			// Only placeholders are known constants. Column equality, raw SQL,
			// and arbitrary computed expressions do not pin a tenant.
			return "_paramName" in value ? value.toFragment() : undefined
		}
		if (value === null || value === undefined) return undefined
		return columnType === undefined
			? toFragment(value)
			: raw(encodeColumnLiteral(columnType, value, columnName ?? name))
	}
	return Object.assign(
		base,
		isTenantColumn
			? {
					eq: (other: any) => {
						const condition = baseEq(other)
						const right = isExprLike(other) ? tenantColumnOf(other) : undefined
						const value = bound(other)
						return markTenantPredicate(
							condition,
							right !== undefined
								? [{ left: name, right }]
								: value === undefined
									? []
									: [{ column: name, value }],
						)
					},
					in_: (...values: ReadonlyArray<any>) => {
						const condition = (baseIn as any)(...values)
						const value = values.length === 1 ? bound(values[0]) : undefined
						return markTenantPredicate(
							condition,
							value === undefined ? [] : [{ column: name, value }],
						)
					},
				}
			: {},
		{
			columnName: name as Name,
			get(key: string): Expr<any> {
				return makeExpr<any>(known(() => `${compile(fragment)}[${compile(str(key))}]`), columnType?.element?.schema)
			},
		},
	) as ColumnRef<Name, ColType>
}

// Condition implementation

export function makeCond(fragment: SqlFragment): Condition<any> {
	return {
		_brand: "Condition" as const,
		toFragment: () => fragment,
		and(other) {
			return markTenantPredicate(
				makeCond(known(() => `(${compile(fragment)} AND ${compile(other.toFragment())})`)),
				[...tenantPredicatesOf(this), ...tenantPredicatesOf(other)],
			)
		},
		or: (other) => makeCond(known(() => `(${compile(fragment)} OR ${compile(other.toFragment())})`)),
	}
}

// Literals

export function lit(value: string): Expr<string>
export function lit(value: number): Expr<number>
export function lit(value: string | number): Expr<string> | Expr<number> {
	// A literal knows its own type, so it carries the matching codec. Without one
	// a single `CH.lit("all")` in a SELECT costs the whole query its row schema,
	// since derivation is all-or-nothing.
	if (typeof value === "string") return makeExpr<string>(str(value), chString.schema)
	return makeExpr<number>(raw(String(value)), CHNumber as Schema.Codec<number, any>)
}

// Subquery expressions
//
// `exists` / `inSubquery` / `notInSubquery` live in `./subquery`, not here —
// they accept a `CHQuery` and so need `compileCH`, which this module cannot
// import without closing a cycle. Reach them from the package root.

/**
 * Reference an outer query's column in a correlated subquery.
 * Usage: `outerRef("t.Id")` or `outerRef("Id")`
 */
export function outerRef<T = string>(name: string): Expr<T> {
	return makeUntypedExpr<T>(raw(name))
}

export function inList<T extends string>(expr: Expr<T>, values: readonly string[]): Condition {
	return inCond(expr.toFragment(), "IN", values.map((v) => () => str(v)))
}

export function inExprList<T>(expr: Expr<T>, values: readonly Expr<T>[]): Condition {
	return inCond(expr.toFragment(), "IN", values.map((v) => () => v.toFragment()))
}

export function notInList(expr: Expr<string>, values: readonly string[]): Condition {
	return inCond(expr.toFragment(), "NOT IN", values.map((v) => () => str(v)))
}

/**
 * Conditions AND-joined, an `undefined` one skipped: `and(a, when(x, f), b)`.
 * With none left it is `undefined`, which a `where` list skips in turn. Tenant
 * evidence carries through, as with `.and`.
 */
export function and<const C extends ReadonlyArray<Condition>>(...conditions: C): Condition<ParamsIn<C[number]>>
export function and<const C extends ReadonlyArray<Condition | undefined>>(
	...conditions: C
): Condition<ParamsIn<C[number]>> | undefined
export function and(...conditions: ReadonlyArray<Condition | undefined>): Condition | undefined {
	const present = conditions.filter((c): c is Condition => c !== undefined)
	if (present.length <= 1) return present[0]
	return markTenantPredicate(
		makeCond(known(() => `(${present.map((c) => compile(c.toFragment())).join(" AND ")})`)),
		present.flatMap((c) => tenantPredicatesOf(c)),
	)
}

/**
 * Conditions OR-joined, an `undefined` one skipped. With none left it is
 * `undefined`. An OR proves no tenant, so it carries no tenant evidence.
 */
export function or<const C extends ReadonlyArray<Condition>>(...conditions: C): Condition<ParamsIn<C[number]>>
export function or<const C extends ReadonlyArray<Condition | undefined>>(
	...conditions: C
): Condition<ParamsIn<C[number]>> | undefined
export function or(...conditions: ReadonlyArray<Condition | undefined>): Condition | undefined {
	const present = conditions.filter((c): c is Condition => c !== undefined)
	if (present.length <= 1) return present[0]
	return makeCond(known(() => `(${present.map((c) => compile(c.toFragment())).join(" OR ")})`))
}

/** Wrap a condition in NOT (...). */
export function not<P = never>(condition: Condition<P>): Condition<P> {
	return makeCond(known(() => `NOT (${compile(condition.toFragment())})`))
}

// Raw expression (escape hatch)

/**
 * SQL the builder cannot express, as an expression of a declared type.
 *
 * The type is required. Optional is how a raw expression ends up carrying a
 * TypeScript type nothing checks: `rawExpr<number>("sum(x)")` tells the compiler
 * the column is a number and tells the runtime nothing, so a `UInt64` arriving
 * quoted reaches a `Schema.Number` several layers downstream. Declaring
 * `T.float64` costs one argument and makes both directions agree.
 *
 * For SQL whose result genuinely has no type to declare — a sort tuple that is
 * only ever an argument, never a selected value — use {@link untypedExpr}, which
 * says so.
 */
export function rawExpr<T>(sql: string, type: CHType<string, T, any>): Expr<T> {
	return makeExpr<T>(raw(sql), type.schema)
}

/**
 * SQL with no declared result type.
 *
 * Deliberately separate from {@link rawExpr} and deliberately awkward to reach
 * for: selecting one costs the whole query its derived row schema, so the query
 * decodes nothing. `CompiledQuery.rowSchemaSource` reports that as `"none"` and
 * `untypedColumns` names the aliases responsible, so a codebase that cares can
 * assert on it.
 *
 * The legitimate use is a value that never becomes a row: an `ORDER BY` key, an
 * `argMin` tiebreaker, a tuple compared against another tuple.
 */
export function untypedExpr<T = unknown>(sql: string): Expr<T> {
	return makeUntypedExpr<T>(raw(sql))
}

export function rawCond(sql: string): Condition {
	return makeCond(raw(sql))
}

/**
 * An expression from a runtime column name — a `GROUP BY` alias referenced in
 * `HAVING`, or a column of a source the builder cannot see.
 *
 * Pass the column type where you know it: without one the expression has no
 * schema, and one unschema'd field stops the whole query deriving a row schema.
 */
export function dynamicColumn<T = string>(name: string, type?: CHType<string, T, any>): Expr<T> {
	return makeExpr<T>(raw(name), type?.schema)
}

// Aliased expression — used by query compilation

export function aliased<T>(expr: Expr<T>, alias: string): SqlFragment {
	return sqlAs(expr.toFragment(), alias)
}

// Conditional helpers (for optional WHERE clauses)

export function when<T, P = never>(
	value: T | undefined | false | null,
	fn: (v: T) => Condition<P>,
): Condition<P> | undefined {
	if (value === undefined || value === null || value === false) return undefined
	return fn(value)
}

export function whenTrue<P = never>(value: boolean | undefined, fn: () => Condition<P>): Condition<P> | undefined {
	if (!value) return undefined
	return fn()
}
