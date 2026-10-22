// Value generators, and the column types the literal oracle round-trips.
import fc from "fast-check"
import { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as PG from "@maple-dev/effect-orm/postgres"

export type Dialect = "clickhouse" | "postgres"

// Strings

/**
 * Fragments that have broken some SQL writer somewhere: quote and escape
 * characters, comment openers, every placeholder syntax this library or a
 * driver uses, line separators, and code points that change length between
 * UTF-16 and UTF-8.
 */
const NASTY = [
	"'", "''", "\\", "\\'", "\\\\", '"', "`", "\n", "\r\n", "\t", "\b", "\f", "\v", "\x1b", "\x7f",
	"%", "_", "\\%", "\\_", "--", "/*", "*/", ";", "?", "$1", "$$", ":name", "{p:String}",
	"__PARAM_", "__PARAM_string_x__", "NULL", "\\N", "e'", "E'", "U&'", " ", " ",
	" ", "﻿", "​", "é", "é", "😀", "👩‍👩‍👧", "\ud800", "\udfff", "Ω", "İ", "ß",
]

/** Any string, biased hard towards the fragments above. `\0` only where the dialect stores it. */
export const nastyString = (dialect: Dialect | "both"): fc.Arbitrary<string> => {
	const unit = fc.oneof(
		{ weight: 3, arbitrary: fc.constantFrom(...NASTY) },
		{ weight: 2, arbitrary: fc.string({ unit: "binary", maxLength: 3 }) },
		{ weight: 2, arbitrary: fc.string({ unit: fc.constantFrom(..."abcxyz019 "), maxLength: 4 }) },
		...(dialect === "clickhouse" ? [{ weight: 1, arbitrary: fc.constant("\0") }] : []),
	)
	return fc
		.array(unit, { maxLength: 6 })
		.map((parts) => parts.join(""))
		// Postgres `text` cannot hold U+0000, and PGlite's TextDecoder drops a leading BOM:
		// the database's and the driver's limits, not the builder's.
		.filter((s) => dialect === "clickhouse" || (!s.includes("\0") && !s.startsWith("\ufeff")))
}

/** Strings whose byte order every target agrees on: lowercase ASCII and a few symbols. */
export const plainString = fc.string({ unit: fc.constantFrom(..."abcdeghiklmnoprstuwxy_-' "), maxLength: 8 })

// Times

const MIN_DT = Date.UTC(1970, 0, 1)
const MAX_DT = Date.UTC(2106, 1, 7, 6, 28, 15) // DateTime is a UInt32 of seconds
const MIN_DT64 = Date.UTC(1900, 0, 1)
const MAX_DT64 = Date.UTC(2299, 11, 31, 23, 59, 59, 999)
// PGlite hands timestamps to JS as `Date`s built with two-digit-year rules, so
// years 0–99 come back as 1900–1999 before the builder sees them.
const MIN_PG = Date.UTC(100, 0, 1)
const MAX_PG = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

const utc = (ms: number): DateTime.Utc => DateTime.makeUnsafe(ms)
const pad = (n: number, width = 2) => String(n).padStart(width, "0")
/** `YYYY-MM-DD hh:mm:ss[.sss]`, written here rather than by the code under test. */
const wireDateTime = (ms: number, fraction: boolean): string => {
	const d = new Date(ms)
	const base = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
	return fraction ? `${base}.${pad(d.getUTCMilliseconds(), 3)}` : base
}

// Comparing decoded values

/**
 * A decoded value in a form `toEqual` compares meaningfully: a `DateTime` as
 * its instant, `-0` as `0`. Applied to both sides of every row comparison.
 */
export const normalize = (value: unknown): unknown => {
	if (DateTime.isDateTime(value)) return `@${new Date(DateTime.toEpochMillis(value)).toISOString()}`
	if (value instanceof Date) return `@${value.toISOString()}`
	if (typeof value === "number") return Object.is(value, -0) ? 0 : value
	if (Array.isArray(value)) return value.map(normalize)
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]))
	}
	return value
}

// The literal catalog

/**
 * A column type and how to put a value of it into a row *without* the builder.
 *
 * `source` writes a one-row, one-column (`v`) SELECT from the value's JSON — a
 * path through the database's own JSON parser, independent of the literal
 * writer under test — so comparing the builder's literal against `v` is not
 * the builder checking itself.
 */
/**
 * The JSON a reference row is parsed from. `__PARAM_` is written `\u005f_PARAM_`:
 * the reference SQL is raw text, and the builder rightly refuses raw SQL that
 * contains its placeholder prefix.
 */
export const referenceJson = (wire: unknown): string =>
	JSON.stringify({ v: wire }).replaceAll("__PARAM_", "\\u005f_PARAM_")

/** Whether every string inside `value` is well-formed UTF-16 (no lone surrogates). */
export const wellFormed = (value: unknown): boolean => {
	// String.prototype.isWellFormed, spelled out (the tests' lib target predates it):
	// iterating by code point yields a lone surrogate as itself.
	if (typeof value === "string") {
		for (const ch of value) {
			const code = ch.codePointAt(0)!
			if (code >= 0xd800 && code <= 0xdfff) return false
		}
		return true
	}
	if (Array.isArray(value)) return value.every(wellFormed)
	if (value !== null && typeof value === "object") {
		return Object.entries(value).every(([k, v]) => wellFormed(k) && wellFormed(v))
	}
	return true
}

export interface LiteralType {
	readonly id: string
	readonly dialect: Dialect
	readonly type: CH.CHType<string, any, any>
	readonly value: fc.Arbitrary<unknown>
	/** The value as the JSON the database parses. */
	readonly wire: (value: unknown) => unknown
	readonly source: (json: string, value: unknown) => string
	/** Whether `$.v.eq(value)` is meaningful for this type. */
	readonly comparable: boolean
}

const chSource = (sqlType: string) => (json: string) =>
	`SELECT v FROM format(JSONEachRow, 'v ${sqlType.replaceAll("'", "\\'")}', '${json.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}')`

const pgJson = (json: string) => `CAST('${json.replaceAll("'", "''")}' AS jsonb)`
const pgScalar = (sqlType: string) => (json: string) => `SELECT CAST(${pgJson(json)}->>'v' AS ${sqlType}) AS "v"`
const pgArray = (sqlType: string) => (json: string) =>
	`SELECT CAST(ARRAY(SELECT jsonb_array_elements_text(${pgJson(json)}->'v')) AS ${sqlType}[]) AS "v"`

const ch = (
	id: string,
	type: CH.CHType<string, any, any>,
	value: fc.Arbitrary<unknown>,
	options: { wire?: (value: unknown) => unknown; comparable?: boolean; source?: (value: unknown) => string } = {},
): LiteralType => ({
	id: `clickhouse:${id}`,
	dialect: "clickhouse",
	type,
	value,
	wire: options.wire ?? ((v) => v),
	source: (json, v) => (options.source ? options.source(v) : chSource(type.sql)(json)),
	comparable: options.comparable ?? true,
})
const pg = (
	id: string,
	type: CH.CHType<string, any, any>,
	value: fc.Arbitrary<unknown>,
	options: { wire?: (value: unknown) => unknown; array?: boolean } = {},
): LiteralType => ({
	id: `postgres:${id}`,
	dialect: "postgres",
	type,
	value,
	wire: options.wire ?? ((v) => v),
	source: options.array ? pgArray(type.sql.replace(/\[\]$/, "")) : pgScalar(type.sql),
	comparable: true,
})

const finite = fc.double({ noNaN: true, noDefaultInfinity: true })
const int32 = fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 })
const nullOr = <A>(arb: fc.Arbitrary<A>) => fc.option(arb, { nil: null, freq: 4 })
const dateTimeWire = (fraction: boolean) => (value: unknown) =>
	wireDateTime(DateTime.toEpochMillis(value as DateTime.Utc), fraction)

export const literalTypes: ReadonlyArray<LiteralType> = [
	ch("String", CH.string, nastyString("clickhouse")),
	ch("Int32", CH.int32, int32),
	ch("Int64", CH.int64, fc.maxSafeInteger()),
	ch("UInt32", CH.uint32, fc.nat({ max: 2 ** 32 - 1 })),
	ch("UInt64", CH.uint64, fc.maxSafeNat()),
	// ClickHouse's text float parser (JSON input, `toFloat64('…')`) can be 1 ULP off unless
	// precise_float_parsing is on, so the reference row is built from the IEEE bits instead.
	ch("Float64", CH.float64, finite, {
		source: (v) => {
			const view = new DataView(new ArrayBuffer(8))
			view.setFloat64(0, v as number)
			return `SELECT reinterpretAsFloat64(toUInt64(${view.getBigUint64(0)})) AS v`
		},
	}),
	ch("Bool", CH.bool, fc.boolean()),
	ch("DateTime", CH.dateTime, fc.integer({ min: MIN_DT / 1000, max: MAX_DT / 1000 }).map((s) => utc(s * 1000)), {
		wire: dateTimeWire(false),
	}),
	ch("DateTime64", CH.dateTime64, fc.integer({ min: MIN_DT64, max: MAX_DT64 }).map(utc), { wire: dateTimeWire(true) }),
	ch("Nullable(String)", CH.nullable(CH.string), nullOr(nastyString("clickhouse"))),
	ch("Nullable(Int64)", CH.nullable(CH.int64), nullOr(fc.maxSafeInteger())),
	ch("Array(String)", CH.array(CH.string), fc.array(nastyString("clickhouse"), { maxLength: 4 })),
	ch("Array(Nullable(Int64))", CH.array(CH.nullable(CH.int64)), fc.array(nullOr(fc.maxSafeInteger()), { maxLength: 4 })),
	ch("Array(Array(Int32))", CH.array(CH.array(CH.int32)), fc.array(fc.array(int32, { maxLength: 3 }), { maxLength: 3 })),
	ch("Map(String, String)", CH.map(CH.string, CH.string), fc.dictionary(nastyString("clickhouse"), nastyString("clickhouse"), { maxKeys: 3 }), {
		comparable: false,
	}),
	ch("Map(String, Int64)", CH.map(CH.string, CH.int64), fc.dictionary(nastyString("clickhouse"), fc.maxSafeInteger(), { maxKeys: 3 }), {
		comparable: false,
	}),

	pg("text", PG.text, nastyString("postgres")),
	pg("int4", PG.int4, int32),
	pg("int8", PG.int8, fc.maxSafeInteger()),
	pg("float8", PG.float8, finite),
	pg("boolean", PG.bool, fc.boolean()),
	pg("timestamptz", PG.timestamptz, fc.integer({ min: MIN_PG, max: MAX_PG }).map(utc), {
		wire: (value) => new Date(DateTime.toEpochMillis(value as DateTime.Utc)).toISOString(),
	}),
	pg("nullable(text)", PG.nullable(PG.text), nullOr(nastyString("postgres"))),
	pg("nullable(int8)", PG.nullable(PG.int8), nullOr(fc.maxSafeInteger())),
	pg("text[]", PG.array(PG.text), fc.array(nastyString("postgres"), { maxLength: 4 }), { array: true }),
]
