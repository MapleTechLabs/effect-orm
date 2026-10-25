import { Schema, SchemaGetter } from "effect"
import { brand, custom, type CHType } from "../ch/types"
import { SqliteTimestamp, SqliteTimestampLiteral } from "./timestamp"

export { sqliteTimestampText } from "./timestamp"

/** A SQLite storage type and the codec for its wire values. */
export type SqliteType<Tag extends string, A, I = A> = CHType<Tag, A, I>

export const text = custom("text", Schema.String)
/**
 * Past 2^53 a driver's number is no longer the stored integer (node:sqlite and
 * D1 both read INTEGER as a JS number), so a value outside the safe range is a
 * decode error, not a silently different number. Use a custom codec for a
 * driver's bigint mode.
 */
const SafeInt = Schema.Number.check(
	Schema.makeFilter((value: number) => (Number.isSafeInteger(value) ? undefined : `${value} is not a safe integer; SQLite integers past 2^53 lose precision as JS numbers`), {
		title: "safeInteger",
	}),
)
/** A JavaScript safe integer; see `SafeInt`. */
export const integer = custom("integer", SafeInt)
export const real = custom("real", Schema.Finite)
/** SQLite stores booleans as 0/1. Other integers are not booleans. */
export const boolean = custom("integer", Schema.BooleanFromBit)
/** An instant stored as SQLite timestamp text; see `sqliteTimestampText`. */
export const timestamp = custom("text", SqliteTimestamp, SqliteTimestampLiteral)

const bytes = Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).pipe(
	Schema.decodeTo(Schema.Uint8Array, {
		decode: SchemaGetter.transform((value) => new Uint8Array(value)),
		encode: SchemaGetter.transform((value) => Array.from(value)),
	}),
)
/** Node sends Uint8Array; D1 can send an array of bytes. */
export const blob = custom("blob", Schema.Union([Schema.Uint8Array, bytes]))
/** JSON is stored as TEXT and decoded through the caller's schema. */
export const json = <A, I>(schema: Schema.Codec<A, I>) => custom("text", Schema.fromJsonString(schema))

export const nullable = <Tag extends string, A, I>(type: SqliteType<Tag, A, I>): SqliteType<"Nullable", A | null, I | null> => ({
	_tag: "Nullable",
	sql: type.sql,
	schema: Schema.NullOr(type.schema),
	literalSchema: Schema.NullOr(type.literalSchema),
	element: type,
})

export { brand, custom }
