import { DateTime, Effect, Result, Schema, SchemaGetter } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as CH from "./index"
import { mergeResultSchemas } from "./define-fn"
import { CHDateTimeSecondsLiteral } from "./types"

const decode = <A>(expr: CH.Expr<A>, value: unknown) => Schema.decodeUnknownSync(expr.schema!)(value)
const instant = DateTime.makeUnsafe("2026-01-02T00:00:00.789Z")

describe("composed result codecs", () => {
	it("keeps nullable inserted array elements", () => {
		const value = CH.arrayPushFront(CH.arrayOf(CH.lit(1)), CH.nullIf(CH.lit(2), 2))
		expectTypeOf(value).toEqualTypeOf<CH.Expr<ReadonlyArray<number | null>, CH.ClickHouseOnly>>()
		expect(decode(value, [null, 1])).toEqual([null, 1])
		const known = CH.arrayPushFront(CH.arrayOf(CH.lit(1)), CH.lit(2))
		expect(Result.isFailure(Schema.decodeUnknownResult(known.schema!)([null]))).toBe(true)
		const unknown = CH.arrayPushFront(CH.arrayOf(CH.lit(1)), CH.untypedExpr<number>("2"))
		expect(unknown.schema).toBeUndefined()
	})

	it("combines narrowed conditional and extremum codecs", () => {
		const a = CH.rawExpr("CAST(NULL AS Nullable(String))", CH.nullable(CH.custom("String", Schema.Literal("a"))))
		for (const expr of [CH.coalesce(a, CH.lit("b")), CH.ifNull(a, CH.lit("b"))]) {
			expect(decode(expr, "b")).toBe("b")
			expect(Result.isFailure(Schema.decodeUnknownResult(expr.schema!)(null))).toBe(true)
		}
		const one = CH.rawExpr("1", CH.custom("UInt8", Schema.Literal(1)))
		expect(decode(CH.greatest(one, CH.lit(2)), 2)).toBe(2)
	})

	it("retains nullable transformed codecs and refuses an incomplete composition", () => {
		const transformed = Schema.NullOr(Schema.String).pipe(Schema.decodeTo(Schema.NullOr(Schema.String), {
			decode: SchemaGetter.transform((value) => value === null ? null : value.toUpperCase()),
			encode: SchemaGetter.transform((value) => value === null ? null : value.toLowerCase()),
		}))
		const value = CH.rawExpr("CAST(NULL AS Nullable(String))", CH.custom("Nullable(String)", transformed))
		expect(decode(CH.coalesce(value, value), null)).toBeNull()
		expect(decode(CH.coalesce(value, CH.lit("fallback")), "hello")).toBe("HELLO")
		expect(Schema.encodeSync(CH.coalesce(value, CH.lit("fallback")).schema!)("HELLO")).toBe("hello")
		expect(CH.coalesce(value, CH.untypedExpr<string>("'b'")).schema).toBeUndefined()
	})

	it("propagates SQL NULL through string conversions", () => {
		const value = CH.nullIf(CH.lit(1), 1)
		expectTypeOf(CH.toString(value)).toEqualTypeOf<CH.Expr<string | null, CH.ClickHouseOnly>>()
		expectTypeOf(CH.hex(value)).toEqualTypeOf<CH.Expr<string | null, CH.ClickHouseOnly>>()
		expect(decode(CH.toString(value), null)).toBeNull()
		expect(decode(CH.hex(value), null)).toBeNull()
		expect(decode(CH.toString(CH.lit(1)), "1")).toBe("1")
	})

	it("decodes numeric overflow and nonfinite string parsing as NaN", () => {
		const big = CH.lit(1e308)
		for (const expr of [CH.sum(big), CH.sumIf(big, CH.lit(1).eq(1)), CH.toFloat64OrZero(CH.lit("Inf")), big.add(big), big.mul(10)]) {
			expect(decode(expr, null)).toBeNaN()
			expect(decode(expr, 1)).toBe(1)
		}
		expect(decode(CH.sum(CH.nullIf(CH.lit(1), 1)), null)).toBeNull()
	})

	it("normalizes timezone offsets before flooring timestamp literals", () => {
		const encode = Schema.encodeSync(CHDateTimeSecondsLiteral)
		expect(encode("2026-01-02T00:00:00.500+02:00")).toBe("2026-01-01 22:00:00")
		expect(encode("2026-01-02T00:00:00-03:00")).toBe("2026-01-02 03:00:00")
		expect(encode("2026-01-02 00:00:00.999999")).toBe("2026-01-02 00:00:00")
	})

	it("keeps DateTime64 precision when union members share DateTime.Utc", () => {
		for (const [seconds, precise, input] of [
			[CH.dateTime.schema, CH.dateTime64.schema, instant],
			[CH.nullable(CH.dateTime).schema, CH.nullable(CH.dateTime64).schema, instant],
			[CH.array(CH.dateTime).schema, CH.array(CH.dateTime64).schema, [instant]],
		] as const) {
			const codec = mergeResultSchemas<any>([seconds, precise])!
			const encoded = Schema.encodeSync(codec)(input)
			expect(encoded).toEqual(Array.isArray(input) ? ["2026-01-02 00:00:00.789"] : "2026-01-02 00:00:00.789")
		}
		const one = CH.table("system.one", {})
		const q = CH.compileUnsafe(CH.from(one).select(() => ({ values: CH.arrayOf(
			CH.rawExpr("now()", CH.dateTime), CH.rawExpr("now64()", CH.dateTime64),
		) })), {})
		expect(Effect.runSync(q.encodeRows([{ values: [instant, instant] }]))).toEqual([
			{ values: ["2026-01-02 00:00:00.789", "2026-01-02 00:00:00.789"] },
		])
	})
})
