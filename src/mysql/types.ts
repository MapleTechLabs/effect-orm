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

/** An integer as mysql2 sends one: a number, or the numeric string it sends for a wide one. */
export const MysqlInteger: Schema.Codec<number, number | string> = Schema.Union([Schema.Int, Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int))]) as unknown as Schema.Codec<
	number,
	number | string
>

const integer = (minimum: number, maximum: number): Schema.Codec<number, number | string> =>
	MysqlInteger.pipe(Schema.decodeTo(Schema.Number.check(Schema.isBetween({ minimum, maximum })))) as unknown as Schema.Codec<number, number | string>

const SafeInteger = MysqlInteger.pipe(
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
const decimalText = Schema.String.check(
	Schema.makeFilter((value: string) => (/^-?\d+(\.\d+)?$/.test(value) ? undefined : `\`${value}\` is not a decimal number`), { title: "mysqlDecimal" }),
)
/**
 * DECIMAL(p, s) as its exact decimal text: mysql2 sends DECIMAL as a string, and
 * a JS number would round it. A number (mysql2's `decimalNumbers`) is read as its text.
 */
export const decimal = <const P extends number, const S extends number>(precision: P, scale: S) =>
	custom(
		`decimal(${precision},${scale})` as `decimal(${P},${S})`,
		Schema.Union([
			decimalText,
			Schema.Finite.pipe(
				Schema.decodeTo(decimalText, {
					decode: SchemaGetter.transform((value: number) => String(value)),
					encode: SchemaGetter.transform((value: string) => Number(value)),
				}),
			),
		]) as unknown as Schema.Codec<string, string | number>,
	)
/** TINYINT(1), as MySQL spells BOOLEAN. Other integers are not booleans. */
export const boolean = custom("boolean", Schema.Union([Schema.BooleanFromBit, Schema.Boolean]) as unknown as Schema.Codec<boolean, 0 | 1 | boolean>)

/** DATETIME(3), an instant read and written in UTC. Give mysql2 `timezone: "Z"` (docs/mysql.md). */
export const datetime = custom("datetime(3)", MysqlDateTime, MysqlDateTimeLiteral)

/** A real calendar date: `2024-02-30` and MariaDB's zero dates are not. */
const isCalendarDate = (value: string): boolean => {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
	const date = new Date(`${value}T00:00:00.000Z`)
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}
const dateText = Schema.String.check(
	Schema.makeFilter((value: string) => (isCalendarDate(value) ? undefined : `\`${value}\` is not a DATE: expected a calendar date \`YYYY-MM-DD\``), { title: "mysqlDate" }),
)
const validDate = Schema.Date.check(
	Schema.makeFilter((value: Date) => (Number.isNaN(value.getTime()) ? "an invalid Date (a zero date?)" : undefined), { title: "mysqlDate" }),
)
/**
 * DATE, a calendar date with no time zone, as `YYYY-MM-DD` text. A `Date` from
 * mysql2 (with `timezone: "Z"`) is read in UTC. mysql2 builds a `Date` from a
 * MariaDB zero-in-date (`2024-02-00`) as another day, so read DATE as text
 * (`dateStrings: ["DATE"]`) or run with NO_ZERO_IN_DATE (docs/mysql.md).
 */
export const date = custom(
	"date",
	Schema.Union([
		dateText,
		validDate.pipe(
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
