// MySQL DATETIME(3) values: the text the builder writes and the wire forms it reads.
import { DateTime, Schema, SchemaGetter } from "effect"
import { pgTimestampToIso } from "../pg/types"

/** Years DATETIME documents: 1000 to 9999. */
const inRange = (epochMillis: number): boolean => {
	const year = new Date(epochMillis).getUTCFullYear()
	return year >= 1000 && year <= 9999
}
const rangeMessage = (epochMillis: number) => `year ${new Date(epochMillis).getUTCFullYear()} is outside 1000-9999, which MySQL's DATETIME covers`

const textOf = (epochMillis: number): string => {
	const iso = new Date(epochMillis).toISOString()
	return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`
}

/** An instant as DATETIME(3) text in UTC, `YYYY-MM-DD HH:MM:SS.SSS`. Throws outside 1000-9999. */
export const mysqlDateTimeText = (epochMillis: number): string => {
	if (!inRange(epochMillis)) throw new RangeError(rangeMessage(epochMillis))
	return textOf(epochMillis)
}

const dateTimeInRange = Schema.makeFilter((value: DateTime.Utc) => (inRange(DateTime.toEpochMillis(value)) ? undefined : rangeMessage(DateTime.toEpochMillis(value))), {
	title: "mysqlDateTimeRange",
})
const dateInRange = Schema.makeFilter(
	(value: Date) => (Number.isNaN(value.getTime()) ? "an invalid Date" : inRange(value.getTime()) ? undefined : rangeMessage(value.getTime())),
	{ title: "mysqlDateTimeRange" },
)
const isDateTimeText = Schema.makeFilter(
	(value: string) => {
		const millis = Date.parse(pgTimestampToIso(value))
		if (Number.isNaN(millis)) return `\`${value}\` is not a DATETIME: expected \`YYYY-MM-DD HH:MM:SS[.SSS]\``
		return inRange(millis) ? undefined : rangeMessage(millis)
	},
	{ title: "mysqlDateTime" },
)

const fromText = Schema.String.pipe(
	Schema.check(isDateTimeText),
	Schema.decodeTo(Schema.DateTimeUtc.pipe(Schema.check(dateTimeInRange)), {
		decode: SchemaGetter.transform((value: string) => DateTime.makeUnsafe(pgTimestampToIso(value))),
		encode: SchemaGetter.transform((value: DateTime.Utc) => textOf(DateTime.toEpochMillis(value))),
	}),
)

/**
 * A DATETIME read as UTC. mysql2 sends a `Date` (built in its `timezone`
 * option, which must be `"Z"`), or the text with `dateStrings: true`.
 * Encodes to the text, which binds and compares with a DATETIME column.
 */
export const MysqlDateTime: Schema.Codec<DateTime.Utc, string | Date> = Schema.Union([
	fromText,
	Schema.Date.pipe(
		Schema.check(dateInRange),
		Schema.decodeTo(Schema.DateTimeUtc, {
			decode: SchemaGetter.transform((value: Date) => DateTime.makeUnsafe(value.getTime())),
			encode: SchemaGetter.transform((value: DateTime.Utc) => new Date(DateTime.toEpochMillis(value))),
		}),
	),
]) as unknown as Schema.Codec<DateTime.Utc, string | Date>

/** What a DATETIME comparison or param accepts (a `DateTime.Utc`, a `Date`, DATETIME text), written as the text. */
export const MysqlDateTimeLiteral: Schema.Codec<unknown, unknown> = Schema.Union([
	fromText,
	Schema.String.pipe(
		Schema.decodeTo(Schema.Date.pipe(Schema.check(dateInRange)), {
			decode: SchemaGetter.transform((value: string) => new Date(pgTimestampToIso(value))),
			encode: SchemaGetter.transform((value: Date) => textOf(value.getTime())),
		}),
	),
	Schema.String.pipe(
		Schema.check(isDateTimeText),
		Schema.decodeTo(Schema.String.pipe(Schema.check(isDateTimeText)), {
			decode: SchemaGetter.transform((value: string) => value),
			encode: SchemaGetter.transform((value: string) => textOf(Date.parse(pgTimestampToIso(value)))),
		}),
	),
]) as Schema.Codec<unknown, unknown>

/** A `defaultExpr` for a `datetime` column: the current time with milliseconds. */
export const dateTimeNow = "(CURRENT_TIMESTAMP(3))"
