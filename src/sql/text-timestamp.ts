// Timestamps stored as `YYYY-MM-DD HH:MM:SS.SSS` UTC text: SQLite's `timestamp`
// and MySQL's `DATETIME(3)`. One factory, so the two differ only in the years
// they cover and how they name themselves in an error.
import { DateTime, Schema, SchemaGetter } from "effect"
import { pgTimestampToIso } from "../pg/types"

export interface TextTimestampRules {
	/** The earliest and latest year the type covers. */
	readonly minYear: number
	readonly maxYear: number
	/** What the type is called in an error: "SQLite's text timestamps", "MySQL's DATETIME". */
	readonly label: string
	/** What a bad value is called: `` `x` is not a timestamp ``. */
	readonly noun: string
	/** The schema check titles. */
	readonly title: string
}

/** The text of an instant already checked to be in range. */
export const timestampText = (epochMillis: number): string => {
	const iso = new Date(epochMillis).toISOString()
	return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`
}

export const textTimestamp = (rules: TextTimestampRules) => {
	const span = `${String(rules.minYear).padStart(4, "0")}-${rules.maxYear}`
	const inRange = (epochMillis: number): boolean => {
		const year = new Date(epochMillis).getUTCFullYear()
		return year >= rules.minYear && year <= rules.maxYear
	}
	const rangeMessage = (epochMillis: number) => `year ${new Date(epochMillis).getUTCFullYear()} is outside ${span}, which ${rules.label} cover${rules.label.endsWith("s") ? "" : "s"}`

	/** The text of an instant; throws outside the years the type covers. */
	const text = (epochMillis: number): string => {
		if (!inRange(epochMillis)) throw new RangeError(`${new Date(epochMillis).toISOString()} is outside ${span}, which ${rules.label} cover${rules.label.endsWith("s") ? "" : "s"}`)
		return timestampText(epochMillis)
	}

	// Each check sits on the decoded side, so a value outside the range is refused before an encoder sees it.
	const dateTimeInRange = Schema.makeFilter((value: DateTime.Utc) => (inRange(DateTime.toEpochMillis(value)) ? undefined : rangeMessage(DateTime.toEpochMillis(value))), {
		title: `${rules.title}Range`,
	})
	const dateInRange = Schema.makeFilter(
		(value: Date) => (Number.isNaN(value.getTime()) ? "an invalid Date" : inRange(value.getTime()) ? undefined : rangeMessage(value.getTime())),
		{ title: `${rules.title}Range` },
	)
	const isText = Schema.makeFilter(
		(value: string) => {
			const millis = Date.parse(pgTimestampToIso(value))
			if (Number.isNaN(millis)) return `\`${value}\` is not ${rules.noun}: expected \`YYYY-MM-DD HH:MM:SS[.SSS]\` or ISO-8601`
			return inRange(millis) ? undefined : rangeMessage(millis)
		},
		{ title: rules.title },
	)

	/** Reads the text and ISO-8601 (zoneless text is UTC); writes the text. */
	const codec: Schema.Codec<DateTime.Utc, string> = Schema.String.pipe(
		Schema.check(isText),
		Schema.decodeTo(Schema.DateTimeUtc.pipe(Schema.check(dateTimeInRange)), {
			decode: SchemaGetter.transform((value: string) => DateTime.makeUnsafe(pgTimestampToIso(value))),
			encode: SchemaGetter.transform((value: DateTime.Utc) => timestampText(DateTime.toEpochMillis(value))),
		}),
	)

	/** An in-range `Date`, as a driver sends one. */
	const fromDate: Schema.Codec<DateTime.Utc, Date> = Schema.Date.pipe(
		Schema.check(dateInRange),
		Schema.decodeTo(Schema.DateTimeUtc, {
			decode: SchemaGetter.transform((value: Date) => DateTime.makeUnsafe(value.getTime())),
			encode: SchemaGetter.transform((value: DateTime.Utc) => new Date(DateTime.toEpochMillis(value))),
		}),
	)

	/**
	 * What a comparison or param accepts (a `DateTime.Utc`, a `Date`, the
	 * text), written as the text after `adjust` (truncation to seconds, for
	 * `param.dateTimeSeconds`).
	 */
	const literal = (adjust: (epochMillis: number) => number = (millis) => millis): Schema.Codec<unknown, unknown> =>
		Schema.Union([
			Schema.String.pipe(
				Schema.check(isText),
				Schema.decodeTo(Schema.DateTimeUtc.pipe(Schema.check(dateTimeInRange)), {
					decode: SchemaGetter.transform((value: string) => DateTime.makeUnsafe(pgTimestampToIso(value))),
					encode: SchemaGetter.transform((value: DateTime.Utc) => timestampText(adjust(DateTime.toEpochMillis(value)))),
				}),
			),
			Schema.String.pipe(
				Schema.decodeTo(Schema.Date.pipe(Schema.check(dateInRange)), {
					decode: SchemaGetter.transform((value: string) => new Date(pgTimestampToIso(value))),
					encode: SchemaGetter.transform((value: Date) => timestampText(adjust(value.getTime()))),
				}),
			),
			Schema.String.pipe(
				Schema.check(isText),
				Schema.decodeTo(Schema.String.pipe(Schema.check(isText)), {
					decode: SchemaGetter.transform((value: string) => value),
					encode: SchemaGetter.transform((value: string) => timestampText(adjust(Date.parse(pgTimestampToIso(value))))),
				}),
			),
		]) as Schema.Codec<unknown, unknown>

	return { text, codec, fromDate, literal }
}

/** Floors an instant to whole seconds, for `param.dateTimeSeconds`. */
export const toSeconds = (epochMillis: number): number => Math.floor(epochMillis / 1000) * 1000
