import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as CH from "./index"

describe("typed arrayFilter", () => {
	it.effect("preserves element decoding and encoding in selected rows", () => Effect.gen(function* () {
		const values = CH.arrayFilter("x -> x > 0", CH.arrayOf(CH.lit(1)))
		const compiled = CH.compileUnsafe(
			CH.from(CH.table("system.one", {})).select(() => ({ values })), {},
		)
		expect(compiled.sql).toContain("arrayFilter(x -> x > 0, [1])")
		expect(yield* compiled.decodeRows([{ values: ["1", "2"] }])).toEqual([{ values: [1, 2] }])
		expect(yield* compiled.encodeRows([{ values: [1, 2] }])).toEqual([{ values: [1, 2] }])
		const invalid = yield* compiled.decodeRows([{ values: ["not a number"] }]).pipe(Effect.result)
		expect(invalid._tag).toBe("Failure")
	}))

	it("does not invent a codec for an untyped array", () => {
		const values = CH.arrayFilter("x -> x > 0", CH.untypedExpr<ReadonlyArray<number>>("[1]"))
		expect(values.schema).toBeUndefined()
	})
})
