// SQLite timestamp text: the form `SQLite.timestamp` writes and reads.
import { DateTime, Schema, SchemaGetter } from "effect"
import { pgTimestampToIso, timestampLiteral } from "../pg/types"

/**
 * An instant as SQLite's own text form, `YYYY-MM-DD HH:MM:SS.SSS` in UTC: what
 * `strftime('%Y-%m-%d %H:%M:%f')` and `datetime(..., 'subsec')` write. SQLite
 * compares text by bytes, so a column only orders by time when every value has
 * one form; this is the form SQLite's own functions produce (see `timestampNow`).
 */
export const sqliteTimestampText = (epochMillis: number): string => {
	const iso = new Date(epochMillis).toISOString()
	return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`
}

/** Years SQLite's date functions and the text form cover: four digits, no sign. */
const inSqliteRange = Schema.makeFilter(
	(value: DateTime.Utc) => {
		const year = new Date(DateTime.toEpochMillis(value)).getUTCFullYear()
		return year >= 0 && year <= 9999 ? undefined : `year ${year} is outside 0000-9999, which SQLite's text timestamps cover`
	},
	{ title: "sqliteTimestampRange" },
)

const isTimestampText = Schema.makeFilter(
	(value: string) =>
		Number.isNaN(Date.parse(pgTimestampToIso(value)))
			? `\`${value}\` is not a timestamp: expected \`YYYY-MM-DD HH:MM:SS[.SSS]\` or ISO-8601`
			: undefined,
	{ title: "sqliteTimestamp" },
)

/** Reads SQLite's form and ISO-8601 (zoneless text is UTC); writes SQLite's form. */
export const SqliteTimestamp: Schema.Codec<DateTime.Utc, string> = Schema.String.pipe(
	Schema.check(isTimestampText),
	Schema.decodeTo(Schema.DateTimeUtc.pipe(Schema.check(inSqliteRange)), {
		decode: SchemaGetter.transform((value: string) => DateTime.makeUnsafe(pgTimestampToIso(value))),
		encode: SchemaGetter.transform((value: DateTime.Utc) => sqliteTimestampText(DateTime.toEpochMillis(value))),
	}),
)

/** What a timestamp comparison or param accepts (a `DateTime.Utc`, a `Date`, timestamp text), written in SQLite's form. */
export const SqliteTimestampLiteral = timestampLiteral(sqliteTimestampText)


/**
 * A `defaultExpr` for a `timestamp` column: the current time in the form the
 * column writes. `CURRENT_TIMESTAMP` writes no milliseconds, so its values
 * compare as earlier than the same instant written by the builder.
 */
export const timestampNow = "(strftime('%Y-%m-%d %H:%M:%f', 'now'))"
