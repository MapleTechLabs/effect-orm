// SQLite (node:sqlite, in-process) and D1 (a local workerd binding through
// Miniflare). D1 executes SQLite's SQL, so both share semantics and literals;
// they differ in the dialect they compile with and the database they run on.
import fc from "fast-check"
import { DateTime, Schema } from "effect"
import * as SQLite from "@maple-dev/effect-orm/sqlite"
import { d1Context, sqliteContext } from "../../core-cases"
import { d1Database, sqliteDatabase } from "../../sqlite-support"
import { finite, nastyString, nullOr, utc, type LiteralType } from "../values"
import { runWith, type DialectModule, type FuzzDialect, type Semantics, type StringRules } from "./types"

const semantics: Semantics = {
	missingJoinColumn: "null",
	integerDivision: "truncate",
	modulo: "integer",
	// NULL is SQLite's smallest value.
	nulls: { asc: "first", desc: "last" },
	emptyAggregate: "null",
	// Documented SQLite behaviour (docs/sqlite.md); the builder writes LIKE as is.
	likeIgnoresCase: true,
}

// Literals

// SQLite stores U+0000, but its drivers end text there, so the dialect refuses it.
const strings: StringRules = { nul: false, leadingBom: true }
// The years SQLite's text timestamps and date functions cover.
const MIN_TS = Date.UTC(0, 0, 1)
const MAX_TS = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

/**
 * A double as SQLite SQL that is exact without parsing a decimal: SQLite reads
 * some decimals (`1.23456789e-95`, as a literal or through json_extract) as a
 * neighbouring double. The integer mantissa is exact, and multiplying or
 * dividing by a power of two below 2^62 is exact while the result is a double.
 */
const exactReal = (value: number): string => {
	if (value === 0) return `SELECT 0.0 AS "v"`
	const view = new DataView(new ArrayBuffer(8))
	view.setFloat64(0, Math.abs(value))
	const bits = view.getBigUint64(0)
	const biased = Number(bits >> 52n)
	const fraction = bits & ((1n << 52n) - 1n)
	// value = mantissa * 2^exponent
	const mantissa = biased === 0 ? fraction : fraction | (1n << 52n)
	let exponent = (biased === 0 ? 1 : biased) - 1075
	let sql = `CAST(${value < 0 ? "-" : ""}${mantissa} AS REAL)`
	while (exponent !== 0) {
		const step = Math.min(Math.abs(exponent), 62)
		sql += `${exponent > 0 ? " * " : " / "}${2n ** BigInt(step)}`
		exponent -= Math.sign(exponent) * step
	}
	return `SELECT ${sql} AS "v"`
}

/** The reference row, read by SQLite's JSON functions rather than written by the builder. */
const jsonSource = (read: (value: string) => string) => (json: string) =>
	`SELECT ${read(`json_extract('${json.replaceAll("'", "''")}', '$.v')`)} AS "v"`

const literals = (dialect: string): ReadonlyArray<LiteralType> => {
	const nasty = nastyString(strings)
	const literal = (
		id: string,
		type: SQLite.SqliteType<string, any, any>,
		value: fc.Arbitrary<unknown>,
		options: { wire?: (value: unknown) => unknown; read?: (value: string) => string; source?: (value: unknown) => string; comparable?: boolean } = {},
	): LiteralType => ({
		id: `${dialect}:${id}`,
		type,
		value,
		wire: options.wire ?? ((v) => v),
		source: (json, v) => (options.source ? options.source(v) : jsonSource(options.read ?? ((x) => x))(json)),
		comparable: options.comparable ?? true,
	})
	return [
		literal("text", SQLite.text, nasty),
		literal("integer", SQLite.integer, fc.maxSafeInteger()),
		literal("real", SQLite.real, finite, { source: (v) => exactReal(v as number) }),
		literal("boolean", SQLite.boolean, fc.boolean()),
		// The reference row is SQLite's own text: datetime() writes the date and time, so a builder
		// value compares equal to what the database itself writes, not just to itself.
		literal("timestamp", SQLite.timestamp, fc.integer({ min: MIN_TS, max: MAX_TS }).map(utc), {
			source: (value) => {
				const ms = DateTime.toEpochMillis(value as DateTime.Utc)
				return `SELECT datetime(${Math.floor(ms / 1000)}, 'unixepoch') || '.' || printf('%03d', ${((ms % 1000) + 1000) % 1000}) AS "v"`
			},
		}),
		literal("blob", SQLite.blob, fc.uint8Array({ maxLength: 8 }), { wire: (value) => hex(value as Uint8Array), read: (v) => `unhex(${v})` }),
		literal("json", SQLite.json(Schema.Struct({ message: Schema.String })), fc.record({ message: nasty }), {
			wire: (value) => JSON.stringify(value),
			comparable: false,
		}),
		literal("nullable(text)", SQLite.nullable(SQLite.text), nullOr(nasty)),
		literal("nullable(integer)", SQLite.nullable(SQLite.integer), nullOr(fc.maxSafeInteger())),
	]
}

const sqliteDb = sqliteDatabase()
const d1Db = d1Database()

export const sqlite: FuzzDialect = {
	name: "sqlite",
	module: SQLite as never,
	context: sqliteContext,
	strings,
	ilike: false,
	literals: literals("sqlite"),
	targets: [{ name: "sqlite", available: true, semantics, run: (compiled) => runWith(compiled, sqliteDb.query) }],
	close: sqliteDb.close,
}

const d1Module: DialectModule = {
	...(SQLite as never as DialectModule),
	compile: (query, params) => SQLite.compile(query, params, { dialect: SQLite.d1Dialect }),
}

export const d1: FuzzDialect = {
	name: "d1",
	module: d1Module,
	context: d1Context,
	strings,
	ilike: false,
	literals: literals("d1"),
	targets: [{ name: "d1", available: true, semantics, run: (compiled) => runWith(compiled, d1Db.query) }],
	close: d1Db.close,
}
