// Seed data from a table's column Schemas.
//
// Each column type already carries an Effect `Schema`, so its values come from
// `Arbitrary.schema` with no generator configuration of their own. What a
// Schema does not say is the range the database can store (a `UInt8` decodes
// to any finite number, a `timestamptz` to any instant), so the built-in
// column types add those bounds here. Every column samples from its own seed,
// derived from the run's seed and the column's key: adding a column does not
// change the values of the others. See docs/seeding.md.

import { Arbitrary, DateTime, Effect, MutableHashSet, Schema } from "effect"
import type * as SchemaAST from "effect/SchemaAST"
import { insertInto } from "../ch/insert"
import type { Table } from "../ch/table"
import { chDateTime64Literal, chDateTimeLiteral, type CHType, type ColumnDefs, type InferTS } from "../ch/types"
import { Database } from "../database/database"
import type { DatabaseError } from "../database/errors"
import type { CompiledQueryDecodeError } from "../ch/compile"
import type { QueryBuilderError } from "../ch/errors"

/** Seeding could not make the rows: a column has no arbitrary, an override does not fit, or an option is wrong. */
export class SeedError extends Schema.TaggedError<SeedError>()("@maple-dev/effect-orm/SeedError", {
	table: Schema.String,
	column: Schema.optional(Schema.String),
	message: Schema.String,
}) {}

/** A bare `string` means the table did not say, which is read as none. */
type Known<K extends string> = string extends K ? never : K

type Simplify<A> = { [K in keyof A]: A[K] } & {}

/**
 * One seeded row of a table, as decoded values. Every writable column is
 * present except the ones with a database default, which are present only
 * when an override gives them a value.
 */
export type SeedRow<Cols extends ColumnDefs, Defaulted extends string = never, Computed extends string = never> = Simplify<
	{
		readonly [K in Exclude<keyof Cols & string, Known<Defaulted> | Known<Computed>>]: InferTS<Cols[K]>
	} & {
		readonly [K in Exclude<Known<Defaulted> & keyof Cols, Known<Computed>>]?: InferTS<Cols[K]>
	}
>

/** The seeded row of a table value: `SeedRowOf<typeof Users>`. */
export type SeedRowOf<T> =
	T extends Table<any, infer Cols, infer Defaulted, infer Computed> ? SeedRow<Cols, Defaulted, Computed> : never

type WritableKeys<T> =
	T extends Table<any, infer Cols, any, infer Computed> ? Exclude<keyof Cols & string, Known<Computed>> : never
type ColumnsOf<T> = T extends Table<any, infer Cols, any, any> ? Cols : never

/**
 * What a column gets instead of its derived values: one value for every row,
 * an `Arbitrary` to sample (`pick(ids)` for a foreign key), or a function of
 * the row's index, such as ``(i) => `user${i}@example.com` ``.
 */
export type ColumnOverride<A> = A | Arbitrary.Arbitrary<A> | ((index: number) => A)

export interface ArbitraryOptions<T> {
	/** Per-column values in place of the derived ones. A defaulted column is generated only when it has one. */
	readonly columns?: { readonly [K in WritableKeys<T>]?: ValueOrArbitrary<InferTS<ColumnsOf<T>[K]>> }
	/**
	 * The tenant every row belongs to. Required when the table declares a
	 * tenant column, unless `crossTenant` is set.
	 */
	readonly tenant?: unknown
	/** Generate the tenant column like any other, so rows belong to many tenants. */
	readonly crossTenant?: boolean
}

type ValueOrArbitrary<A> = A | Arbitrary.Arbitrary<A>

export interface RowsOptions<T> extends Omit<ArbitraryOptions<T>, "columns"> {
	/** How many rows. */
	readonly count: number
	/** The same seed, table and options give the same rows. Default `0`. */
	readonly seed?: string | number
	readonly columns?: { readonly [K in WritableKeys<T>]?: ColumnOverride<InferTS<ColumnsOf<T>[K]>> }
	/**
	 * Columns whose values must differ between rows. A Postgres table's
	 * one-column primary key and `unique` columns are added from its DDL.
	 */
	readonly unique?: ReadonlyArray<WritableKeys<T>>
}

export interface InsertOptions<T> extends RowsOptions<T> {
	/** Rows per INSERT statement. Default 100. */
	readonly batchSize?: number
}

type AnyTable = Table<string, ColumnDefs, string, string>

// Storage bounds of the built-in column types

// ClickHouse stores a DateTime as a UInt32 of seconds (1970 to 2106-02-07) and
// a DateTime64 from 1900 to 2299, and reads a literal in the server's time
// zone. A day off each end keeps a value in range in every zone.
const DAY = 86_400_000
const MIN_DATETIME = Date.UTC(1970, 0, 1) + DAY
const MAX_DATETIME = Date.UTC(2106, 1, 7, 6, 28, 15) - DAY
const MIN_DATETIME64 = Date.UTC(1900, 0, 1) + DAY
const MAX_DATETIME64 = Date.UTC(2299, 11, 31, 23, 59, 59, 999) - DAY
// Postgres stores 4713 BC to 294276 AD, but a driver can read the years 0 to 99
// as 1900 to 1999, and ISO-8601 text has four-digit years only.
const MIN_TIMESTAMPTZ = Date.UTC(100, 0, 1)
const MAX_TIMESTAMPTZ = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

const integerRanges: Readonly<Record<string, readonly [number, number]>> = {
	UInt8: [0, 2 ** 8 - 1],
	UInt16: [0, 2 ** 16 - 1],
	UInt32: [0, 2 ** 32 - 1],
	UInt64: [0, Number.MAX_SAFE_INTEGER],
	Int32: [-(2 ** 31), 2 ** 31 - 1],
	Int64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	int2: [-(2 ** 15), 2 ** 15 - 1],
	int4: [-(2 ** 31), 2 ** 31 - 1],
	int8: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
}

const FLOAT4_MAX = 3.4028234663852886e38

/** Values from a column's own Schema: the decoded side, with its checks. */
const fromSchema = (schema: Schema.Top): Arbitrary.Arbitrary<unknown> =>
	Arbitrary.schema(Schema.toType(schema as Schema.Codec<unknown, unknown>))

/** An instant in `[min, max]` milliseconds, in the form the column decodes to. */
const instant = (
	type: CHType<string, any, any>,
	min: number,
	max: number,
	seconds: boolean,
): Arbitrary.Arbitrary<unknown> => {
	const is = Schema.is(Schema.toType(type.schema as Schema.Codec<unknown, unknown>))
	const millis = seconds
		? Arbitrary.map(Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: min / 1000, maximum: Math.floor(max / 1000) }))), (s) => s * 1000)
		: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max })))
	if (is(DateTime.makeUnsafe(0))) return Arbitrary.map(millis, (ms) => DateTime.makeUnsafe(ms))
	if (is(0)) return millis
	// A string-typed ClickHouse DateTime: the literal the server reads back.
	const format = type._tag === "DateTime" ? chDateTimeLiteral : chDateTime64Literal
	return Arbitrary.map(millis, (ms) => format(DateTime.makeUnsafe(ms)))
}

const bounded = (type: CHType<string, any, any>, checks: [SchemaAST.Check<number>, ...Array<SchemaAST.Check<number>>]) =>
	Arbitrary.schema(Schema.toType(type.schema as Schema.Codec<number, unknown>).check(...checks))

const noNul = (value: unknown): boolean => typeof value !== "string" || !value.includes("\0")

/** A plain object or one with no prototype, as `Schema.Record` makes them; not a `DateTime` or a `Date`. */
const isRecord = (value: unknown): value is Record<string, unknown> => {
	if (value === null || typeof value !== "object") return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

/** `value` with every `-0` written as `0`: no column type but float reads a `-0` back. */
const positiveZero = (value: unknown): unknown => {
	if (typeof value === "number") return Object.is(value, -0) ? 0 : value
	if (Array.isArray(value)) return value.some((item) => !Object.is(positiveZero(item), item)) ? value.map(positiveZero) : value
	if (isRecord(value)) {
		const entries = Object.entries(value)
		return entries.some(([, v]) => !Object.is(positiveZero(v), v)) ? Object.fromEntries(entries.map(([k, v]) => [k, positiveZero(v)])) : value
	}
	return value
}

/**
 * Whether every string in `value` is well-formed UTF-16. A lone surrogate
 * cannot travel as UTF-8, so the database would store another string.
 */
const wellFormed = (value: unknown): boolean => {
	if (typeof value === "string") {
		for (const ch of value) {
			const code = ch.codePointAt(0)!
			if (code >= 0xd800 && code <= 0xdfff) return false
		}
		return true
	}
	if (Array.isArray(value)) return value.every(wellFormed)
	if (isRecord(value)) {
		return Object.entries(value).every(([k, v]) => wellFormed(k) && wellFormed(v))
	}
	return true
}

/**
 * Values a column of this type can store. Throws, as `Arbitrary.schema` does,
 * when a Schema has no arbitrary; the caller turns that into a `SeedError`.
 */
const columnArbitrary = (type: CHType<string, any, any>): Arbitrary.Arbitrary<unknown> => {
	switch (type._tag) {
		case "Nullable": {
			// One row in four is NULL.
			const inner = columnArbitrary(type.element!)
			return Arbitrary.flatMap(Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))), (n) =>
				n === 0 ? Arbitrary.Constant(null) : inner,
			)
		}
		case "Array":
			return Arbitrary.array(columnArbitrary(type.element!), { maxLength: 4 })
		case "Map":
			return Arbitrary.map(
				Arbitrary.array(Arbitrary.all([Arbitrary.schema(Schema.String), columnArbitrary(type.element!)]), { maxLength: 3 }),
				(entries) => Object.fromEntries(entries),
			)
		case "DateTime":
			return instant(type, MIN_DATETIME, MAX_DATETIME, true)
		case "DateTime64":
			return instant(type, MIN_DATETIME64, MAX_DATETIME64, false)
		case "timestamptz":
			return instant(type, MIN_TIMESTAMPTZ, MAX_TIMESTAMPTZ, false)
		case "float4":
			// Rounded to single precision, so a value too small for a real is sent as 0 and reads back as sent.
			return Arbitrary.map(bounded(type, [Schema.isBetween({ minimum: -FLOAT4_MAX, maximum: FLOAT4_MAX })]), Math.fround)
		case "uuid":
			// Lowercase, the form Postgres reads a uuid back in.
			return Arbitrary.map(Arbitrary.schema(Schema.String.check(Schema.isUUID(4))), (uuid) => uuid.toLowerCase())
		case "text":
			// Postgres `text` cannot hold U+0000.
			return Arbitrary.filter(fromSchema(type.schema), noNul)
		case "jsonb": {
			const json = Schema.toType(type.schema as Schema.Codec<unknown, unknown>).ast._tag === "Unknown"
			return Arbitrary.filter(json ? Arbitrary.schema(Schema.Json) : fromSchema(type.schema), (value) => {
				const text = JSON.stringify(value)
				return text !== undefined && !text.includes("\\u0000")
			})
		}
	}
	const range = integerRanges[type._tag]
	if (range !== undefined) return bounded(type, [Schema.isInt(), Schema.isBetween({ minimum: range[0], maximum: range[1] })])
	return fromSchema(type.schema)
}

/** `columnArbitrary`, kept to values the column's own Schema accepts (a brand, a refinement). */
const columnValues = (table: AnyTable, column: string): Effect.Effect<Arbitrary.Arbitrary<unknown>, SeedError> => {
	const type = table.columns[column]!
	return Effect.try({
		try: () => {
			const is = Schema.is(Schema.toType(type.schema as Schema.Codec<unknown, unknown>))
			return Arbitrary.filter(Arbitrary.map(columnArbitrary(type), positiveZero), (value) => wellFormed(value) && is(value))
		},
		catch: (cause) =>
			new SeedError({
				table: table.name,
				column,
				message: `no arbitrary for ${type.sql}: ${cause instanceof Error ? cause.message : String(cause)}; give the column an override`,
			}),
	})
}

/** Pick one of `values` per row: a foreign key into rows seeded before. */
export const pick = <const A>(values: readonly [A, ...Array<A>]): Arbitrary.Arbitrary<A> =>
	Arbitrary.map(Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: values.length - 1 }))), (i) => values[i]!)

/** The columns a seed writes: every writable column, less the defaulted ones without an override. */
const seededColumns = (table: AnyTable, overrides: Readonly<Record<string, unknown>>): ReadonlyArray<string> => {
	const computed = new Set<string>(table.computed ?? [])
	const defaults = new Set<string>(table.defaults ?? [])
	return Object.keys(table.columns).filter(
		(column) => !computed.has(column) && (!defaults.has(column) || overrides[column] !== undefined),
	)
}

/** `tenant` as an override of the tenant column, or the error for a tenanted table without one. */
const tenantOverride = (
	table: AnyTable,
	options: { readonly tenant?: unknown; readonly crossTenant?: boolean | undefined },
): Effect.Effect<Readonly<Record<string, unknown>>, SeedError> => {
	const column = table.tenantColumn
	if (column === undefined || options.crossTenant === true) {
		return options.tenant === undefined
			? Effect.succeed({})
			: Effect.fail(new SeedError({ table: table.name, message: column === undefined ? "the table has no tenant column; drop `tenant`" : "give `tenant` or `crossTenant`, not both" }))
	}
	if (options.tenant === undefined) {
		return Effect.fail(
			new SeedError({ table: table.name, column, message: `the table has the tenant column ${column}; give \`tenant\`, or \`crossTenant: true\`` }),
		)
	}
	return Effect.succeed({ [column]: options.tenant })
}

const checkValue = (table: AnyTable, column: string, value: unknown): Effect.Effect<void, SeedError> =>
	Schema.is(Schema.toType(table.columns[column]!.schema as Schema.Codec<unknown, unknown>))(value)
		? Effect.void
		: Effect.fail(new SeedError({ table: table.name, column, message: `the override value ${String(value)} is not a value of ${table.columns[column]!.sql}` }))

const checkOverrides = (
	table: AnyTable,
	overrides: Readonly<Record<string, unknown>>,
): Effect.Effect<void, SeedError> =>
	Effect.forEach(
		Object.entries(overrides),
		([column, override]) =>
			!Object.hasOwn(table.columns, column) || (table.computed ?? []).includes(column)
				? Effect.fail(new SeedError({ table: table.name, column, message: "not a writable column of the table" }))
				: override === undefined || Arbitrary.isArbitrary(override) || typeof override === "function"
					? Effect.void
					: checkValue(table, column, override),
		{ discard: true },
	)

/**
 * An `Arbitrary` of whole rows of `table`, for property tests over a
 * repository. Fails with `SeedError` when a column has no arbitrary.
 */
export const arbitrary = <T extends Table<string, any, any, any>>(
	table: T,
	options: ArbitraryOptions<T> = {},
): Effect.Effect<Arbitrary.Arbitrary<SeedRowOf<T>>, SeedError> =>
	Effect.gen(function* () {
		const t = table as unknown as AnyTable
		const overrides = { ...(options.columns as Readonly<Record<string, unknown>> | undefined), ...(yield* tenantOverride(t, options)) }
		yield* checkOverrides(t, overrides)
		const columns: Record<string, Arbitrary.Arbitrary<unknown>> = {}
		for (const column of seededColumns(t, overrides)) {
			const override = overrides[column]
			columns[column] =
				override === undefined
					? yield* columnValues(t, column)
					: Arbitrary.isArbitrary(override)
						? override
						: Arbitrary.Constant(override)
		}
		return Arbitrary.all(columns) as unknown as Arbitrary.Arbitrary<SeedRowOf<T>>
	})

/** Single-column uniques a Postgres table declares, as column keys. */
const declaredUnique = (table: AnyTable): ReadonlyArray<string> => {
	const ddl = (table as { readonly ddl?: unknown }).ddl as
		| {
				readonly dialect: string
				readonly table: { readonly primaryKey: { readonly columns: ReadonlyArray<string> } | null }
				readonly uniques: ReadonlyArray<{ readonly columns: ReadonlyArray<string> }>
		  }
		| undefined
	if (ddl?.dialect !== "postgres") return []
	const keyOf = new Map(Object.keys(table.columns).map((key) => [table.columns[key]!.sqlName ?? key, key]))
	return [ddl.table.primaryKey?.columns ?? [], ...ddl.uniques.map((unique) => unique.columns)]
		.filter((columns) => columns.length === 1)
		.map((columns) => keyOf.get(columns[0]!)!)
		.filter((key) => key !== undefined)
}

/** `count` values of one column, distinct when `unique`. */
const sampleColumn = (
	table: AnyTable,
	column: string,
	values: Arbitrary.Arbitrary<unknown>,
	count: number,
	seed: string,
	unique: boolean,
): Effect.Effect<ReadonlyArray<unknown>, SeedError> =>
	Effect.gen(function* () {
		const fail = (message: string) => new SeedError({ table: table.name, column, message })
		const sampled = yield* Arbitrary.sampleEffect(values, { count: unique ? count * 4 + 16 : count, seed }).pipe(
			Effect.mapError(() => fail("the column's arbitrary rejected too many values; give the column an override")),
		)
		if (!unique) return sampled
		const seen = MutableHashSet.empty<unknown>()
		const distinct: Array<unknown> = []
		for (const value of sampled) {
			if (distinct.length === count) break
			if (MutableHashSet.has(seen, value)) continue
			MutableHashSet.add(seen, value)
			distinct.push(value)
		}
		return distinct.length === count
			? distinct
			: yield* Effect.fail(fail(`found ${distinct.length} distinct values of ${count}; give the column an override, such as a function of the row index`))
	})

/**
 * `count` rows of `table`, from its column Schemas. The same `seed` gives the
 * same rows. Nothing is written: pass them to `insertInto(table).values(rows)`,
 * or use `insert`.
 */
export const rows = <T extends Table<string, any, any, any>>(
	table: T,
	options: RowsOptions<T>,
): Effect.Effect<ReadonlyArray<SeedRowOf<T>>, SeedError> =>
	Effect.gen(function* () {
		const t = table as unknown as AnyTable
		const { count } = options
		if (!Number.isSafeInteger(count) || count < 0) {
			return yield* Effect.fail(new SeedError({ table: t.name, message: `count must be a non-negative integer, got ${count}` }))
		}
		const seed = String(options.seed ?? 0)
		const overrides = { ...(options.columns as Readonly<Record<string, unknown>> | undefined), ...(yield* tenantOverride(t, options)) }
		yield* checkOverrides(t, overrides)
		const unique = new Set<string>([...declaredUnique(t), ...(options.unique ?? [])])
		const columns = seededColumns(t, overrides)
		const out: Array<Record<string, unknown>> = Array.from({ length: count }, () => ({}))
		for (const column of columns) {
			const override = overrides[column]
			let values: ReadonlyArray<unknown>
			if (override === undefined || Arbitrary.isArbitrary(override)) {
				const source = override === undefined ? yield* columnValues(t, column) : (override as Arbitrary.Arbitrary<unknown>)
				// Each column its own stream: a new column leaves the others' values as they were.
				values = yield* sampleColumn(t, column, source, count, `${seed}:${t.name}.${column}`, unique.has(column))
			} else if (typeof override === "function") {
				values = Array.from({ length: count }, (_, i) => (override as (index: number) => unknown)(i))
				for (const value of values) yield* checkValue(t, column, value)
			} else {
				values = Array.from({ length: count }, () => override)
			}
			values.forEach((value, i) => void (out[i]![column] = value))
		}
		return out as unknown as ReadonlyArray<SeedRowOf<T>>
	})

/**
 * `rows`, inserted through `insertInto(table).values(...)` on the `Database`
 * in context, `batchSize` rows per statement, in order. Returns the rows, so
 * a later seed can `pick` from their keys. A failed batch stops the seed;
 * wrap it in `transaction` to keep all or nothing where the dialect has
 * transactions. A `crossTenant` seed declares its inserts `crossTenant()`.
 */
export const insert = <T extends Table<string, any, any, any>>(
	table: T,
	options: InsertOptions<T>,
): Effect.Effect<
	ReadonlyArray<SeedRowOf<T>>,
	SeedError | DatabaseError | QueryBuilderError | CompiledQueryDecodeError,
	Database
> =>
	Effect.gen(function* () {
		const batchSize = options.batchSize ?? 100
		if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
			return yield* Effect.fail(new SeedError({ table: table.name, message: `batchSize must be a positive integer, got ${batchSize}` }))
		}
		const seeded = yield* rows(table, options)
		const db = yield* Database
		for (let start = 0; start < seeded.length; start += batchSize) {
			const batch = insertInto(table as unknown as AnyTable).values(seeded.slice(start, start + batchSize) as never)
			yield* db.run((options.crossTenant === true ? batch.crossTenant() : batch) as never)
		}
		return seeded
	})
