// SQLite timestamp text: the form `SQLite.timestamp` writes and reads.
import { DateTime, Schema, SchemaGetter } from "effect"
import { pgTimestampToIso } from "../pg/types"

/**
 * An instant as SQLite's own text form, `YYYY-MM-DD HH:MM:SS.SSS` in UTC: what
 * `strftime('%Y-%m-%d %H:%M:%f')` and `datetime(..., 'subsec')` write. SQLite
 * compares text by bytes, so a column only orders by time when every value has
 * one form; this is the form SQLite's own functions produce (see `timestampNow`).
 */
export const sqliteTimestampText = (epochMillis: number): string => {
	if (!inRange(epochMillis)) throw new RangeError(`${new Date(epochMillis).toISOString()} is outside 0000-9999, which SQLite's text timestamps cover`)
	return textOf(epochMillis)
}

/** The text, for an instant already checked to be in range. */
const textOf = (epochMillis: number): string => {
	const iso = new Date(epochMillis).toISOString()
	return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`
}

/** Years SQLite's date functions and the text form cover: four digits, no sign. Past 9999, toISOString writes `+010000-…`. */
const inRange = (epochMillis: number): boolean => {
	const year = new Date(epochMillis).getUTCFullYear()
	return year >= 0 && year <= 9999
}
const rangeMessage = (epochMillis: number) => `year ${new Date(epochMillis).getUTCFullYear()} is outside 0000-9999, which SQLite's text timestamps cover`

// Each check sits on the decoded side, so a value outside the range is refused before an encoder sees it.
const dateTimeInRange = Schema.makeFilter((value: DateTime.Utc) => (inRange(DateTime.toEpochMillis(value)) ? undefined : rangeMessage(DateTime.toEpochMillis(value))), {
	title: "sqliteTimestampRange",
})
const dateInRange = Schema.makeFilter(
	(value: Date) => (Number.isNaN(value.getTime()) ? "an invalid Date" : inRange(value.getTime()) ? undefined : rangeMessage(value.getTime())),
	{ title: "sqliteTimestampRange" },
)

const isTimestampText = Schema.makeFilter(
	(value: string) => {
		const millis = Date.parse(pgTimestampToIso(value))
		if (Number.isNaN(millis)) return `\`${value}\` is not a timestamp: expected \`YYYY-MM-DD HH:MM:SS[.SSS]\` or ISO-8601`
		return inRange(millis) ? undefined : rangeMessage(millis)
	},
	{ title: "sqliteTimestamp" },
)

/** Reads SQLite's form and ISO-8601 (zoneless text is UTC); writes SQLite's form. */
export const SqliteTimestamp: Schema.Codec<DateTime.Utc, string> = Schema.String.pipe(
	Schema.check(isTimestampText),
	Schema.decodeTo(Schema.DateTimeUtc.pipe(Schema.check(dateTimeInRange)), {
		decode: SchemaGetter.transform((value: string) => DateTime.makeUnsafe(pgTimestampToIso(value))),
		encode: SchemaGetter.transform((value: DateTime.Utc) => textOf(DateTime.toEpochMillis(value))),
	}),
)

/**
 * What a timestamp comparison or param accepts (a `DateTime.Utc`, a `Date`,
 * timestamp text), written in SQLite's form after `adjust` (truncation to
 * seconds, for `param.dateTimeSeconds`).
 */
export const sqliteTimestampLiteral = (adjust: (epochMillis: number) => number = (millis) => millis): Schema.Codec<unknown, unknown> =>
	Schema.Union([
		Schema.String.pipe(
			Schema.check(isTimestampText),
			Schema.decodeTo(Schema.DateTimeUtc.pipe(Schema.check(dateTimeInRange)), {
				decode: SchemaGetter.transform((value: string) => DateTime.makeUnsafe(pgTimestampToIso(value))),
				encode: SchemaGetter.transform((value: DateTime.Utc) => textOf(adjust(DateTime.toEpochMillis(value)))),
			}),
		),
		Schema.String.pipe(
			Schema.decodeTo(Schema.Date.pipe(Schema.check(dateInRange)), {
				decode: SchemaGetter.transform((value: string) => new Date(pgTimestampToIso(value))),
				encode: SchemaGetter.transform((value: Date) => textOf(adjust(value.getTime()))),
			}),
		),
		Schema.String.pipe(
			Schema.check(isTimestampText),
			Schema.decodeTo(Schema.String.pipe(Schema.check(isTimestampText)), {
				decode: SchemaGetter.transform((value: string) => value),
				encode: SchemaGetter.transform((value: string) => textOf(adjust(Date.parse(pgTimestampToIso(value))))),
			}),
		),
	]) as Schema.Codec<unknown, unknown>

export const SqliteTimestampLiteral = sqliteTimestampLiteral()

/**
 * A `defaultExpr` for a `timestamp` column: the current time in the form the
 * column writes. `CURRENT_TIMESTAMP` writes no milliseconds, so its values
 * compare as earlier than the same instant written by the builder.
 */
export const timestampNow = "(strftime('%Y-%m-%d %H:%M:%f', 'now'))"
