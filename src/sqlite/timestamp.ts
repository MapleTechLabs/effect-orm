// SQLite timestamp text: the form `SQLite.timestamp` writes and reads.
import type { DateTime, Schema } from "effect"
import { textTimestamp } from "../sql/text-timestamp"

// Years SQLite's date functions and the text form cover: four digits, no sign. Past 9999, toISOString writes `+010000-…`.
const sqlite = textTimestamp({ minYear: 0, maxYear: 9999, label: "SQLite's text timestamps", noun: "a timestamp", title: "sqliteTimestamp" })

/**
 * An instant as SQLite's own text form, `YYYY-MM-DD HH:MM:SS.SSS` in UTC: what
 * `strftime('%Y-%m-%d %H:%M:%f')` and `datetime(..., 'subsec')` write. SQLite
 * compares text by bytes, so a column only orders by time when every value has
 * one form; this is the form SQLite's own functions produce (see `timestampNow`).
 */
export const sqliteTimestampText = sqlite.text

/** Reads SQLite's form and ISO-8601 (zoneless text is UTC); writes SQLite's form. */
export const SqliteTimestamp: Schema.Codec<DateTime.Utc, string> = sqlite.codec

/**
 * What a timestamp comparison or param accepts (a `DateTime.Utc`, a `Date`,
 * timestamp text), written in SQLite's form after `adjust` (truncation to
 * seconds, for `param.dateTimeSeconds`).
 */
export const sqliteTimestampLiteral = sqlite.literal

export const SqliteTimestampLiteral = sqliteTimestampLiteral()

/**
 * A `defaultExpr` for a `timestamp` column: the current time in the form the
 * column writes. `CURRENT_TIMESTAMP` writes no milliseconds, so its values
 * compare as earlier than the same instant written by the builder.
 */
export const timestampNow = "(strftime('%Y-%m-%d %H:%M:%f', 'now'))"
