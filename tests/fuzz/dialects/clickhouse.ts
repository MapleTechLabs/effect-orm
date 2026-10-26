// ClickHouse: live only when EFFECT_ORM_CLICKHOUSE_URL is set. Two targets,
// because `join_use_nulls` changes what an unmatched LEFT JOIN row holds.
import fc from "fast-check"
import { Arbitrary, Schema } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import { clickhouseContext } from "../../core-cases"
import { dateTimeWire, finite, int32, nastyString, nullOr, utc, wireDateTime, type LiteralType } from "../values"
import { decode, type FuzzDialect, type FuzzTarget, type Outcome, type Semantics, type StringRules } from "./types"

export const clickhouseEndpoint = process.env.EFFECT_ORM_CLICKHOUSE_URL
const user = process.env.EFFECT_ORM_CLICKHOUSE_USER ?? "default"
const password = process.env.EFFECT_ORM_CLICKHOUSE_PASSWORD ?? ""

/** POST raw SQL; the text reply, or the server's error. */
export const clickhouseText = async (
	sql: string,
	settings: Record<string, string> = {},
): Promise<{ readonly ok: boolean; readonly text: string }> => {
	const url = new URL(clickhouseEndpoint!)
	for (const [key, value] of Object.entries({ default_format: "JSONEachRow", session_timezone: "UTC", ...settings })) {
		url.searchParams.set(key, value)
	}
	// A soak sends tens of thousands of requests; a dropped socket is the harness's problem, not a finding.
	for (let attempt = 1; ; attempt++) {
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "X-ClickHouse-User": user, "X-ClickHouse-Key": password },
				body: sql,
				signal: AbortSignal.timeout(10_000),
			})
			return { ok: response.ok, text: await response.text() }
		} catch (error) {
			const code = (error as { cause?: { code?: string } }).cause?.code ?? String(error)
			if (attempt >= 5) throw new Error(`ClickHouse unreachable after ${attempt} attempts (${code}) — infrastructure, not a finding`)
			await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt))
		}
	}
}

/**
 * A ClickHouse server bug, not the builder's: the common-expression rewrite can
 * leave a one-argument and() (`a AND ((b AND a) OR a)`, `(a OR 0 OR a) AND (a OR 0)`,
 * and more shapes than a matcher keeps up with), which fails with this error.
 * The query is run again with the rewrite off, and its rows still checked.
 */
const SERVER_AND_BUG = /Number of arguments for function "and" should be at least 2/

const runClickHouse = async (compiled: CH.CompiledQuery<any>, settings: Record<string, string>): Promise<Outcome> => {
	let { ok, text } = await clickhouseText(compiled.sql, settings)
	if (!ok && SERVER_AND_BUG.test(text)) ({ ok, text } = await clickhouseText(compiled.sql, { ...settings, optimize_extract_common_expressions: "0" }))
	if (!ok) return { _tag: "DatabaseError", message: text.trim() }
	const wire = text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as unknown)
	return decode(compiled, wire)
}

const semantics: Semantics = {
	missingJoinColumn: "default",
	integerDivision: "float",
	modulo: "clickhouse",
	nulls: { asc: "last", desc: "last" },
	// ClickHouse answers an aggregate over no rows with a default its optimizer moves around
	// (`min(-1 + x)` is rewritten `-1 + min(x)`, so it is -1, not 0).
	emptyAggregate: "unmodelled",
	likeIgnoresCase: false,
}

/**
 * An UPDATE is an `ALTER TABLE … UPDATE` mutation, which runs in the background
 * unless asked to wait, and a lightweight DELETE may too. Waiting makes a write
 * visible to the read that follows it, as the writes suite needs.
 */
const syncWrites = { mutations_sync: "2", lightweight_deletes_sync: "2" }

const target = (name: string, joinUseNulls: boolean): FuzzTarget => ({
	name,
	available: clickhouseEndpoint !== undefined,
	semantics: joinUseNulls ? { ...semantics, missingJoinColumn: "null" } : semantics,
	run: (compiled) =>
		runClickHouse(compiled, {
			...syncWrites,
			join_use_nulls: joinUseNulls ? "1" : "0",
			output_format_json_quote_64bit_integers: joinUseNulls ? "1" : "0",
		}),
})

// Literals

const strings: StringRules = { nul: true, leadingBom: true }
const MIN_DT = Date.UTC(1970, 0, 1)
const MAX_DT = Date.UTC(2106, 1, 7, 6, 28, 15) // DateTime is a UInt32 of seconds
const MIN_DT64 = Date.UTC(1900, 0, 1)
const MAX_DT64 = Date.UTC(2299, 11, 31, 23, 59, 59, 999)

/** The reference row, parsed by ClickHouse's JSON reader rather than written by the builder. */
const jsonSource = (sqlType: string) => (json: string) =>
	`SELECT v FROM format(JSONEachRow, 'v ${sqlType.replaceAll("'", "\\'")}', '${json.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}')`

const literal = (
	id: string,
	type: CH.CHType<string, any, any>,
	value: LiteralType["value"],
	options: { wire?: (value: unknown) => unknown; comparable?: boolean; source?: (value: unknown) => string } = {},
): LiteralType => ({
	id: `clickhouse:${id}`,
	type,
	value,
	wire: options.wire ?? ((v) => v),
	source: (json, v) => (options.source ? options.source(v) : jsonSource(type.sql)(json)),
	comparable: options.comparable ?? true,
})

const nasty = nastyString(strings)
const literals: ReadonlyArray<LiteralType> = [
	literal("String", CH.string, nasty),
	literal("brand(String)", CH.brand(CH.string, Schema.String.pipe(Schema.brand("FuzzText"))), nasty),
	literal("custom(Int32)", CH.custom("Int32", CH.int32.schema), int32),
	literal("Int32", CH.int32, int32),
	literal("Int64", CH.int64, fc.maxSafeInteger()),
	literal("UInt8", CH.uint8, fc.nat({ max: 255 })),
	literal("UInt16", CH.uint16, fc.nat({ max: 65535 })),
	literal("UInt32", CH.uint32, fc.nat({ max: 2 ** 32 - 1 })),
	literal("UInt64", CH.uint64, fc.maxSafeNat()),
	// ClickHouse's text float parser (JSON input, `toFloat64('…')`) can be 1 ULP off unless
	// precise_float_parsing is on, so the reference row is built from the IEEE bits instead.
	literal("Float64", CH.float64, finite, {
		source: (v) => {
			const view = new DataView(new ArrayBuffer(8))
			view.setFloat64(0, v as number)
			return `SELECT reinterpretAsFloat64(toUInt64(${view.getBigUint64(0)})) AS v`
		},
	}),
	literal("Bool", CH.bool, Arbitrary.schema(CH.bool.schema)),
	literal("DateTime", CH.dateTime, fc.integer({ min: MIN_DT / 1000, max: MAX_DT / 1000 }).map((s) => utc(s * 1000)), {
		wire: dateTimeWire(false),
	}),
	literal("DateTime64", CH.dateTime64, fc.integer({ min: MIN_DT64, max: MAX_DT64 }).map(utc), { wire: dateTimeWire(true) }),
	literal("DateTimeString", CH.dateTimeString, fc.integer({ min: MIN_DT / 1000, max: MAX_DT / 1000 }).map((s) => wireDateTime(s * 1000, false))),
	literal("DateTime64String", CH.dateTime64String, fc.integer({ min: MIN_DT64, max: MAX_DT64 }).map((ms) => wireDateTime(ms, true))),
	literal("LowCardinality(String)", CH.lowCardinality(CH.string), nasty),
	literal("SimpleAggregateFunction(max, Int64)", CH.simpleAggregateFunction("max", CH.int64), fc.maxSafeInteger()),
	literal("DateTime64(0)", CH.precision(CH.dateTime64, 0), fc.integer({ min: MIN_DT64 / 1000, max: Math.floor(MAX_DT64 / 1000) }).map((s) => utc(s * 1000)), { wire: dateTimeWire(false) }),
	literal("Nullable(String)", CH.nullable(CH.string), nullOr(nasty)),
	literal("Nullable(Int64)", CH.nullable(CH.int64), nullOr(fc.maxSafeInteger())),
	literal("Array(String)", CH.array(CH.string), fc.array(nasty, { maxLength: 4 })),
	literal("Array(Nullable(Int64))", CH.array(CH.nullable(CH.int64)), fc.array(nullOr(fc.maxSafeInteger()), { maxLength: 4 })),
	literal("Array(Array(Int32))", CH.array(CH.array(CH.int32)), fc.array(fc.array(int32, { maxLength: 3 }), { maxLength: 3 })),
	literal("Map(String, String)", CH.map(CH.string, CH.string), fc.dictionary(nasty, nasty, { maxKeys: 3 }), { comparable: false }),
	literal("Map(String, Int64)", CH.map(CH.string, CH.int64), fc.dictionary(nasty, fc.maxSafeInteger(), { maxKeys: 3 }), { comparable: false }),
]

export const clickhouse: FuzzDialect = {
	name: "clickhouse",
	module: CH as never,
	context: clickhouseContext,
	strings,
	ilike: true,
	literals,
	writes: {
		insertSelect: true,
		update: true,
		delete: true,
		onConflict: false,
		returning: false,
		defaultCells: true,
		scratch: {
			table: (name) =>
				CH.table(name, {
					external: true,
					columns: { Id: CH.int64, OrgId: CH.string, Name: CH.string, Note: CH.nullable(CH.string), Qty: CH.column(CH.int64, { default: 5 }) },
				}),
			create: (name) => [`CREATE TABLE ${name} (Id Int64, OrgId String, Name String, Note Nullable(String), Qty Int64 DEFAULT 5) ENGINE = MergeTree ORDER BY Id`],
			drop: (name) => `DROP TABLE IF EXISTS ${name}`,
			exec: async (sql) => {
				const { ok, text } = await clickhouseText(sql, syncWrites)
				if (!ok) throw new Error(text.trim())
			},
		},
	},
	targets: [target("clickhouse", false), target("clickhouse-join-nulls", true)],
}
