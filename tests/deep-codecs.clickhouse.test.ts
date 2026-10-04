import { DateTime, Effect, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, it } from "@effect/vitest"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import { endpoint, execute } from "./clickhouse-support"

const One = CH.table("system.one", { external: true, columns: {} })

it.layer(FetchHttpClient.layer)("composed codecs against ClickHouse", (it) => {
	describe.skipIf(!endpoint)("live", () => {
		it.effect("decodes nullable array insertion and string conversions", () => Effect.gen(function* () {
			const nil = CH.nullIf(CH.lit(1), 1)
			const compiled = CH.compileUnsafe(CH.from(One).select(() => ({
				array: CH.arrayPushFront(CH.arrayOf(CH.lit(1)), nil),
				text: CH.toString(nil),
				hex: CH.hex(nil),
			})), {})
			expect((yield* execute(compiled)).rows).toEqual([{ array: [null, 1], text: null, hex: null }])
		}))

		it.effect("decodes a narrowed coalesce fallback", () => Effect.gen(function* () {
			const a = CH.rawExpr("CAST(NULL AS Nullable(String))", CH.nullable(CH.custom("String", Schema.Literal("a"))))
			const compiled = CH.compileUnsafe(CH.from(One).select(() => ({ result: CH.coalesce(a, CH.lit("b")) })), {})
			expect((yield* execute(compiled)).rows).toEqual([{ result: "b" }])
		}))

		it.effect("decodes overflowed aggregates and nonfinite numeric strings", () => Effect.gen(function* () {
			const Numbers = CH.table("numbers(2)", { external: true, columns: {} })
			const compiled = CH.compileUnsafe(CH.from(Numbers).select(() => ({
				total: CH.sum(CH.lit(1e308)),
				filtered: CH.sumIf(CH.lit(1e308), CH.lit(1).eq(1)),
				parsed: CH.toFloat64OrZero(CH.lit("1e400")),
			})), {})
			expect((yield* execute(compiled)).rows).toEqual([{ total: Number.NaN, filtered: Number.NaN, parsed: Number.NaN }])
		}))

		it.effect("normalizes zoned seconds params and retains conditional precision", () => Effect.gen(function* () {
			const seconds = CH.compileUnsafe(CH.from(One).select(() => ({
				time: CH.toDateTime(CH.param.dateTimeSeconds("time")),
			})), { time: "2026-01-02T00:00:00.500+02:00" })
			expect((yield* execute(seconds)).rows).toEqual([{ time: "2026-01-01 22:00:00" }])
			const result = CH.compileUnsafe(CH.from(One).select(() => ({
				time: CH.if_(CH.lit(0).eq(1), CH.rawExpr("toDateTime('2026-01-01 00:00:00')", CH.dateTime),
					CH.rawExpr("toDateTime64('2026-01-02 00:00:00.789', 3)", CH.dateTime64)),
			})), {})
			const rows = (yield* execute(result)).rows
			expect(DateTime.toEpochMillis(rows[0]!.time)).toBe(Date.parse("2026-01-02T00:00:00.789Z"))
			expect(yield* result.encodeRows(rows)).toEqual([{ time: "2026-01-02 00:00:00.789" }])
		}))
	})
})
