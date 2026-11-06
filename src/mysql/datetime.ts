// MySQL DATETIME(3) values: the text the builder writes and the wire forms it reads.
import { type DateTime, Schema } from "effect"
import { textTimestamp, toSeconds } from "../sql/text-timestamp"

// The years DATETIME documents.
const datetime = textTimestamp({ minYear: 1000, maxYear: 9999, label: "MySQL's DATETIME", noun: "a DATETIME", title: "mysqlDateTime" })

/** An instant as DATETIME(3) text in UTC, `YYYY-MM-DD HH:MM:SS.SSS`. Throws outside 1000-9999. */
export const mysqlDateTimeText = datetime.text

/**
 * A DATETIME read as UTC. mysql2 sends a `Date` (built in its `timezone`
 * option, which must be `"Z"`), or the text with `dateStrings: true`.
 * Encodes to the text, which binds and compares with a DATETIME column.
 */
export const MysqlDateTime = Schema.Union([datetime.codec, datetime.fromDate]) as unknown as Schema.Codec<DateTime.Utc, string | Date>

/** What a DATETIME comparison or param accepts (a `DateTime.Utc`, a `Date`, DATETIME text), written as the text. */
export const MysqlDateTimeLiteral = datetime.literal()
/** The same, floored to whole seconds, for `param.dateTimeSeconds`. */
export const MysqlDateTimeSecondsLiteral = datetime.literal(toSeconds)

/**
 * A `defaultExpr` for a `datetime` column: the current time in UTC, with
 * milliseconds. `UTC_TIMESTAMP`, not `CURRENT_TIMESTAMP`, which is the
 * session's time zone, while the column is read as UTC.
 */
export const dateTimeNow = "(UTC_TIMESTAMP(3))"
