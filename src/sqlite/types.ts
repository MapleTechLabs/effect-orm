import { Schema, SchemaGetter } from "effect"
import { brand, custom, type CHType } from "../ch/types"
import { PgTimestampLiteral } from "../pg/types"

/** A SQLite storage type and the codec for its wire values. */
export type SqliteType<Tag extends string, A, I = A> = CHType<Tag, A, I>

export const text = custom("text", Schema.String)
/** A JavaScript safe integer; use a custom codec for a driver's bigint mode. */
export const integer = custom("integer", Schema.Int)
export const real = custom("real", Schema.Finite)
/** SQLite stores booleans as 0/1. Other integers are not booleans. */
export const boolean = custom("integer", Schema.BooleanFromBit)
/** An instant stored as ISO text. */
export const timestamp = custom("text", Schema.DateTimeUtcFromString, PgTimestampLiteral)

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
