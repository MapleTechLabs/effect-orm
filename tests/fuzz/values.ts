// Value generators and helpers shared by every dialect's literal catalog
// (`dialects/*.ts`): strings that break SQL writers, times, and normalising
// decoded values for comparison.
import fc from "fast-check"
import { Arbitrary, DateTime, Schema } from "effect"
import type * as CH from "@maple-dev/effect-orm/clickhouse"
import type { StringRules } from "./dialects/types"

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

/** Strings every dialect stores unchanged. */
export const portableStrings: StringRules = { nul: false, leadingBom: false }

/** Any string, biased hard towards the fragments above, within what the dialect can store. */
export const nastyString = (rules: StringRules): fc.Arbitrary<string> => {
	const unit = fc.oneof(
		{ weight: 3, arbitrary: fc.constantFrom(...NASTY) },
		{ weight: 2, arbitrary: fc.string({ unit: "binary", maxLength: 3 }) },
		{ weight: 2, arbitrary: fc.string({ unit: fc.constantFrom(..."abcxyz019 "), maxLength: 4 }) },
		...(rules.nul ? [{ weight: 1, arbitrary: fc.constant("\0") }] : []),
	)
	return fc
		.array(unit, { maxLength: 6 })
		.map((parts) => parts.join(""))
		// e.g. Postgres `text` cannot hold U+0000, and PGlite's TextDecoder drops a leading BOM:
		// the database's and the driver's limits, not the builder's.
		.filter((s) => (rules.nul || !s.includes("\0")) && (rules.leadingBom || !s.startsWith("\ufeff")))
}

/** Strings whose byte order every target agrees on: lowercase ASCII and a few symbols. */
export const plainString = fc.string({ unit: fc.constantFrom(..."abcdeghiklmnoprstuwxy_-' "), maxLength: 8 })

// Times

export const utc = (ms: number): DateTime.Utc => DateTime.makeUnsafe(ms)
const pad = (n: number, width = 2) => String(n).padStart(width, "0")
/** `YYYY-MM-DD hh:mm:ss[.sss]`, written here rather than by the code under test. */
export const wireDateTime = (ms: number, fraction: boolean): string => {
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
	/** `<dialect>:<type>`; appears in property names, `regressions.ts` and `known-issues.ts`. */
	readonly id: string
	readonly type: CH.CHType<string, any, any>
	readonly value: fc.Arbitrary<unknown> | Arbitrary.Arbitrary<unknown>
	/** The value as the JSON the database parses. */
	readonly wire: (value: unknown) => unknown
	readonly source: (json: string, value: unknown) => string
	/** Whether `$.v.eq(value)` is meaningful for this type. */
	readonly comparable: boolean
	/** Canonicalize a driver representation with a coarser textual precision (e.g. float4). */
	readonly normalizeValue?: (value: unknown) => unknown
}

export const finite = fc.double({ noNaN: true, noDefaultInfinity: true })
export const int32 = fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 })
export const nullOr = <A>(arb: fc.Arbitrary<A>) => fc.option(arb, { nil: null, freq: 4 })
export const dateTimeWire = (fraction: boolean) => (value: unknown) =>
	wireDateTime(DateTime.toEpochMillis(value as DateTime.Utc), fraction)

/** One schema supplies nested JSON payloads and their native shrinking. */
export const jsonPayloadSchema = Schema.Struct({
	message: Schema.String.check(Schema.isMaxLength(40)),
	values: Schema.Array(Schema.NullOr(Schema.Finite)).check(Schema.isMaxLength(4)),
	meta: Schema.Struct({ active: Schema.Boolean, tags: Schema.Array(Schema.String.check(Schema.isMaxLength(16))).check(Schema.isMaxLength(3)) }),
})
export const jsonPayload = (rules: StringRules) => Arbitrary.schema(jsonPayloadSchema).pipe(
	Arbitrary.filter((value) => wellFormed(value) && [value.message, ...value.meta.tags].every((s) =>
		(rules.nul || !s.includes("\0")) && (rules.leadingBom || !s.startsWith("\ufeff")))),
)
