// MySQL / MariaDB column types.
//
// The ClickHouse descriptor (`CHType`) with MySQL's SQL type names and codecs
// for what mysql2 sends: integers as numbers (a BIGINT past 2^53 as a string
// with `supportBigNumbers`), DECIMAL as a string, TINYINT(1) as 0/1, DATETIME
// as a `Date` or text, binary as a `Buffer`, and JSON parsed (MySQL) or as
// text (MariaDB, where JSON is LONGTEXT).
import { Schema, SchemaGetter } from "effect"
import { brand, custom, type CHType } from "../ch/types"
import { MysqlDateTime, MysqlDateTimeLiteral } from "./datetime"

export { dateTimeNow, mysqlDateTimeText } from "./datetime"

/** A MySQL column type. */
export type MysqlType<Tag extends string, A, I = A> = CHType<Tag, A, I>

/** An integer in range, from a number or the numeric string mysql2 sends for a wide one. */
const integer = (minimum: number, maximum: number): Schema.Codec<number, number | string> => {
	const inRange = Schema.Int.check(Schema.isBetween({ minimum, maximum }))
	return Schema.Union([inRange, Schema.FiniteFromString.pipe(Schema.decodeTo(inRange))]) as unknown as Schema.Codec<number, number | string>
}

const SafeInteger = Schema.Union([Schema.Int, Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int))]).pipe(
	Schema.decodeTo(
		Schema.Number.check(
			Schema.makeFilter((value: number) => (Number.isSafeInteger(value) ? undefined : `${value} is not a safe integer; a BIGINT past 2^53 loses precision as a JS number`), {
				title: "safeInteger",
			}),
		),
	),
) as unknown as Schema.Codec<number, number | string>

export const varchar = <const N extends number>(length: N) => custom(`varchar(${length})` as `varchar(${N})`, Schema.String)
export const text = custom("text", Schema.String)
export const longtext = custom("longtext", Schema.String)

// A comparison may name any integer (`Id IN (-1)` on an unsigned column is
// false, not an error); a value outside the type is refused only on write.
const anyInteger = Schema.Int as unknown as Schema.Codec<unknown, unknown>
export const tinyint = custom("tinyint", integer(-128, 127), anyInteger)
export const smallint = custom("smallint", integer(-32768, 32767), anyInteger)
export const int = custom("int", integer(-2147483648, 2147483647), anyInteger)
export const intUnsigned = custom("int unsigned", integer(0, 4294967295), anyInteger)
/** A BIGINT within JavaScript's safe integers; a wider value is a decode error, not a different number. */
export const bigint = custom("bigint", SafeInteger)
export const double = custom("double", Schema.Union([Schema.Finite, Schema.FiniteFromString]) as unknown as Schema.Codec<number, number | string>)
/** DECIMAL(p, s) as its exact decimal text: mysql2 sends DECIMAL as a string, and a JS number would round it. */
export const decimal = <const P extends number, const S extends number>(precision: P, scale: S) =>
	custom(`decimal(${precision},${scale})` as `decimal(${P},${S})`, Schema.Union([Schema.String, Schema.Finite.pipe(Schema.decodeTo(Schema.String, {
		decode: SchemaGetter.transform((value: number) => String(value)),
		encode: SchemaGetter.transform((value: string) => Number(value)),
	}))]) as unknown as Schema.Codec<string, string>)
/** TINYINT(1), as MySQL spells BOOLEAN. Other integers are not booleans. */
export const boolean = custom("boolean", Schema.Union([Schema.BooleanFromBit, Schema.Boolean]) as unknown as Schema.Codec<boolean, 0 | 1>)

/** DATETIME(3), an instant read and written in UTC. Give mysql2 `timezone: "Z"` (docs/mysql.md). */
export const datetime = custom("datetime(3)", MysqlDateTime, MysqlDateTimeLiteral)

const dateText = Schema.String.check(
	Schema.makeFilter((value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? undefined : `\`${value}\` is not a DATE: expected \`YYYY-MM-DD\``), { title: "mysqlDate" }),
)
/** DATE, a calendar date with no time zone, as `YYYY-MM-DD` text. A `Date` from mysql2 (with `timezone: "Z"`) is read in UTC. */
export const date = custom(
	"date",
	Schema.Union([
		dateText,
		Schema.Date.pipe(
			Schema.decodeTo(dateText, {
				decode: SchemaGetter.transform((value: Date) => value.toISOString().slice(0, 10)),
				encode: SchemaGetter.transform((value: string) => new Date(`${value}T00:00:00.000Z`)),
			}),
		),
	]) as unknown as Schema.Codec<string, string>,
)

const bytes = Schema.Uint8Array.pipe(
	Schema.decodeTo(Schema.Uint8Array, {
		// A Buffer is a Uint8Array; copy it so a row holds a plain one.
		decode: SchemaGetter.transform((value: Uint8Array) => new Uint8Array(value)),
		encode: SchemaGetter.transform((value: Uint8Array) => value),
	}),
)
export const blob = custom("blob", bytes)
export const varbinary = <const N extends number>(length: N) => custom(`varbinary(${length})` as `varbinary(${N})`, bytes)

/**
 * JSON, decoded through the caller's schema. MySQL's JSON arrives parsed and
 * MariaDB's as text; a string on the wire is read as JSON text, so a top-level
 * JSON string value is not supported on MySQL. Writes send the text.
 */
export const json = <A, I>(schema: Schema.Codec<A, I>) =>
	custom(
		"json",
		Schema.Union([
			Schema.fromJsonString(schema),
			Schema.Unknown.pipe(
				Schema.decodeTo(schema as Schema.Codec<A, unknown>, {
					decode: SchemaGetter.transform((value: unknown) => value),
					encode: SchemaGetter.transform((value: unknown) => JSON.stringify(value)),
				}),
			),
		]) as unknown as Schema.Codec<A, string>,
	)

export const nullable = <Tag extends string, A, I>(type: MysqlType<Tag, A, I>): MysqlType<"Nullable", A | null, I | null> => ({
	_tag: "Nullable",
	sql: type.sql,
	schema: Schema.NullOr(type.schema),
	literalSchema: Schema.NullOr(type.literalSchema),
	element: type,
})

export { brand, custom }
