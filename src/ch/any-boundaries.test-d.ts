import { Schema, type DateTime } from "effect"
import { expectTypeOf } from "expect-type"
import * as CH from "./index"

const values = CH.arrayFilter("x -> x > 0", CH.arrayOf(CH.lit(1)))
expectTypeOf(values).toEqualTypeOf<CH.Expr<ReadonlyArray<number>>>()
const nullable = CH.arrayFilter("x -> isNotNull(x)", CH.arrayOf(CH.nullIf(CH.lit(1), 1)))
// A handwritten predicate cannot prove that NULL has been removed.
expectTypeOf(nullable).toEqualTypeOf<CH.Expr<ReadonlyArray<number | null>>>()
expectTypeOf(CH.arrayJoin(values)).toEqualTypeOf<CH.Expr<number>>()
// @ts-expect-error arrayFilter requires an array
CH.arrayFilter("x -> x > 0", CH.lit(1))
// @ts-expect-error filtered numeric elements cannot become strings
CH.arrayJoin(values).like("text")

const query = CH.from(CH.table("system.one", {})).select(() => ({ values }))
expectTypeOf<CH.InferQueryOutput<typeof query>>().toEqualTypeOf<{
	readonly values: ReadonlyArray<number>
}>()

// Public overloads already protect toDateTime's implementation signature.
expectTypeOf(CH.toDateTime(CH.lit(1))).toEqualTypeOf<CH.Expr<DateTime.Utc>>()
expectTypeOf(CH.toDateTime(CH.lit("2026-01-01"))).toEqualTypeOf<CH.Expr<string>>()
// @ts-expect-error arrays cannot be converted to DateTime
CH.toDateTime(values)

const predicate = CH.lit(1).eq(1)
CH.windowFunnel(10)(CH.lit(1), predicate)
CH.sequenceMatch("(?1)")(CH.rawExpr("now()", CH.dateTime), predicate)
CH.windowFunnel(10)(CH.rawExpr("now()", CH.dateTimeString), predicate)
// @ts-expect-error timestamp arguments cannot be arrays
CH.windowFunnel(10)(values, predicate)
// @ts-expect-error timestamp arguments cannot be booleans
CH.sequenceMatch("(?1)")(CH.rawExpr("true", CH.bool), predicate)

// Erased wire representations must require narrowing, not become `any`.
expectTypeOf(Schema.encodeSync(values.schema!)([1])).toBeUnknown()
expectTypeOf(Schema.encodeSync(CH.schemaOf<number>(CH.lit(1))!)(1)).toBeUnknown()
const compiled = CH.compileUnsafe(query, {})
expectTypeOf(Schema.encodeSync(compiled.rowSchema!)({ values: [1] })).toBeUnknown()
expectTypeOf(Schema.encodeUnknownSync(CH.dateTime.literalSchema)("2026-01-01")).toBeUnknown()
expectTypeOf(Schema.decodeUnknownSync(CH.array(CH.string).element!.schema)("a")).toBeUnknown()
// Concrete type descriptors still preserve their known wire representation.
expectTypeOf(Schema.encodeSync(CH.string.schema)("a")).toEqualTypeOf<string>()
