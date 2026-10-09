// Postgres Column Types
//
// The same descriptor as the ClickHouse types (`CHType`): a SQL type name, the
// codec its wire value decodes with, and the codec a compared literal encodes
// with. Only the codecs differ. Postgres drivers disagree on wire forms (int8 and
// numeric arrive as strings from node-postgres and postgres.js, timestamptz as a
// `Date` or a string depending on parser settings), so each codec accepts every
// form a common driver sends, the way `CHNumber` accepts a quoted 64-bit integer.

import { DateTime, Schema, SchemaGetter } from "effect"
import { brand, chDateTimeToIso, custom, type CHType, type InferEncoded, type InferTS } from "../ch/types"

/** A Postgres column type. The ClickHouse descriptor under a dialect-neutral name. */
export type PgType<Tag extends string, A, I = A> = CHType<Tag, A, I>

/** A number as any Postgres driver sends one: a number, a numeric string, or a
 *  `bigint`. Decodes to `number`, so an int8 beyond 2^53 loses precision; declare
 *  `custom("int8", Schema.Union([Schema.BigInt, Schema.BigIntFromString]))`
 *  where that matters. */
export const PgNumber: Schema.Codec<number, number | string | bigint> = Schema.Union([
	Schema.Finite,
	Schema.FiniteFromString,
	Schema.BigInt.pipe(
		Schema.decodeTo(Schema.Finite, {
			decode: SchemaGetter.transform((value: bigint) => Number(value)),
			encode: SchemaGetter.transform((value: number) => globalThis.BigInt(value)),
		}),
	),
])

/**
 * Postgres's text form of a timestamptz (`2026-01-01 00:00:00.25+00`) as
 * ISO-8601, which `Date` parses the same way on every runtime. A zoneless value
 * is read as UTC, the same rule the ClickHouse types apply.
 */
export const pgTimestampToIso = (value: string): string => {
	const trimmed = value.trim()
	const zoned = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/.exec(trimmed)
	if (zoned) return `${zoned[1]}T${zoned[2]}${zoned[3]}:${zoned[4] ?? "00"}`
	return chDateTimeToIso(trimmed)
}

const isTimestamp = Schema.makeFilter(
	(value: string) =>
		Number.isNaN(Date.parse(pgTimestampToIso(value)))
			? `\`${value}\` is not a timestamp: expected ISO-8601 or \`YYYY-MM-DD hh:mm:ss[+zz]\``
			: undefined,
	{ title: "postgresTimestamp" },
)

/** A timestamptz from its text form. */
const TimestampFromString: Schema.Codec<DateTime.Utc, string> = Schema.String.pipe(
	Schema.check(isTimestamp),
	Schema.decodeTo(Schema.DateTimeUtc, {
		decode: SchemaGetter.transform((value: string) => DateTime.makeUnsafe(pgTimestampToIso(value))),
		encode: SchemaGetter.transform((value: DateTime.Utc) => DateTime.formatIso(value)),
	}),
)

/** A timestamptz as a driver sends it: a `Date` (the usual parse) or text. */
const PgTimestamptz: Schema.Codec<DateTime.Utc, Date | string> = Schema.Union([
	Schema.DateTimeUtcFromDate,
	TimestampFromString,
])

/**
 * Everything a timestamptz can be compared against (a `DateTime.Utc`, a `Date`,
 * or a timestamp string), written as an ISO-8601 instant by `format`, which
 * receives epoch milliseconds. Unlike a zoneless literal, an instant cannot be
 * read in the session's time zone.
 */
export const timestampLiteral = (format: (epochMillis: number) => string): Schema.Codec<unknown, unknown> =>
	Schema.Union([
		Schema.String.pipe(
			Schema.decodeTo(Schema.DateTimeUtc, {
				decode: SchemaGetter.transform((value: string) => DateTime.makeUnsafe(pgTimestampToIso(value))),
				encode: SchemaGetter.transform((value: DateTime.Utc) => format(DateTime.toEpochMillis(value))),
			}),
		),
		Schema.String.pipe(
			Schema.decodeTo(Schema.Date, {
				decode: SchemaGetter.transform((value: string) => new Date(value)),
				encode: SchemaGetter.transform((value: Date) => format(value.getTime())),
			}),
		),
		Schema.String.pipe(
			Schema.check(isTimestamp),
			Schema.decodeTo(Schema.String, {
				decode: SchemaGetter.transform((value: string) => value),
				encode: SchemaGetter.transform((value: string) => format(Date.parse(pgTimestampToIso(value)))),
			}),
		),
	]) as Schema.Codec<unknown, unknown>

const isoInstant = (epochMillis: number): string => new Date(epochMillis).toISOString()

export const PgTimestampLiteral: Schema.Codec<unknown, unknown> = timestampLiteral(isoInstant)

/** A timestamptz as a driver sends it, read as epoch milliseconds. */
const PgTimestamptzMillis: Schema.Codec<number, Date | string> = Schema.Union([
	Schema.Date.pipe(
		Schema.decodeTo(Schema.Finite, {
			decode: SchemaGetter.transform((value: Date) => value.getTime()),
			encode: SchemaGetter.transform((value: number) => new Date(value)),
		}),
	),
	Schema.String.pipe(
		Schema.check(isTimestamp),
		Schema.decodeTo(Schema.Finite, {
			decode: SchemaGetter.transform((value: string) => Date.parse(pgTimestampToIso(value))),
			encode: SchemaGetter.transform((value: number) => isoInstant(value)),
		}),
	),
])

/** What a `timestamptzMillis` takes: epoch milliseconds, or anything a timestamptz does. */
const PgTimestampMillisLiteral: Schema.Codec<unknown, unknown> = Schema.Union([
	Schema.String.pipe(
		Schema.decodeTo(Schema.Finite, {
			decode: SchemaGetter.transform((value: string) => Date.parse(value)),
			encode: SchemaGetter.transform((value: number) => isoInstant(value)),
		}),
	),
	PgTimestampLiteral,
]) as Schema.Codec<unknown, unknown>

// Scalars

export const text: PgType<"text", string> = custom("text", Schema.String)
export const uuid: PgType<"uuid", string> = custom("uuid", Schema.String)
export const bool: PgType<"boolean", boolean> = custom("boolean", Schema.Boolean)
export const int2: PgType<"int2", number, number | string | bigint> = custom("int2", PgNumber)
export const int4: PgType<"int4", number, number | string | bigint> = custom("int4", PgNumber)
export const int8: PgType<"int8", number, number | string | bigint> = custom("int8", PgNumber)
export const float4: PgType<"float4", number, number | string | bigint> = custom("float4", PgNumber)
export const float8: PgType<"float8", number, number | string | bigint> = custom("float8", PgNumber)
/** Decodes to `number`; precision beyond a double is lost. */
export const numeric: PgType<"numeric", number, number | string | bigint> = custom("numeric", PgNumber)
export const timestamptz: PgType<"timestamptz", DateTime.Utc, Date | string> = custom(
	"timestamptz",
	PgTimestamptz,
	PgTimestampLiteral,
)

/**
 * A timestamptz read as epoch milliseconds, for code that keeps time as a
 * number. Inserts and comparisons take milliseconds as well as a `Date`, a
 * `DateTime.Utc` or a timestamp string.
 */
export const timestamptzMillis: PgType<"timestamptz", number, Date | string> = custom(
	"timestamptz",
	PgTimestamptzMillis,
	PgTimestampMillisLiteral,
)

/**
 * A jsonb column, decoded with `schema` (anything, by default). Drivers parse
 * jsonb themselves, so rows arrive as values; a compared literal is written as
 * JSON text, which Postgres reads back as jsonb.
 */
export const jsonb = <A = unknown>(
	schema: Schema.Codec<A, any> = Schema.Unknown as Schema.Codec<A, any>,
): PgType<"jsonb", A, unknown> =>
	custom("jsonb", schema as Schema.Codec<A, unknown>, Schema.fromJsonString(schema) as Schema.Codec<unknown, unknown>)

// Compound types

export type PgArray<E extends PgType<string, any, any>> = PgType<
	"Array",
	ReadonlyArray<InferTS<E>>,
	ReadonlyArray<InferEncoded<E>>
>

export type PgNullable<T extends PgType<string, any, any>> = PgType<
	"Nullable",
	InferTS<T> | null,
	InferEncoded<T> | null
>

export const array = <E extends PgType<string, any, any>>(e: E): PgArray<E> => ({
	_tag: "Array",
	sql: `${e.sql}[]`,
	schema: Schema.Array(e.schema),
	literalSchema: Schema.Array(e.literalSchema) as Schema.Codec<unknown, unknown>,
	element: e,
}) as PgArray<E>

export const nullable = <T extends PgType<string, any, any>>(t: T): PgNullable<T> => ({
	_tag: "Nullable",
	sql: t.sql,
	schema: Schema.NullOr(t.schema),
	literalSchema: Schema.NullOr(t.literalSchema) as Schema.Codec<unknown, unknown>,
	element: t,
}) as PgNullable<T>

export { brand, custom }
