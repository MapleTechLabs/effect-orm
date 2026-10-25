// A value given as `Redacted` is marked in `CompiledQuery.sensitiveParameters`,
// so a tracer or a log can leave it out. The driver still gets the plain value.
import { describe, expect, it } from "@effect/vitest"
import { Redacted, Schema } from "effect"
import * as PG from "../postgres"

const doorCode = PG.brand(PG.text, Schema.RedactedFromValue(Schema.String))
const Codes = PG.table("door_codes", { columns: { id: PG.int4, code: doorCode }, primaryKey: ["id"] })

describe("sensitiveParameters", () => {
	it("marks a Redacted value compared with a column", () => {
		const compiled = PG.compileUnsafe(
			PG.from(Codes)
				.select(($) => ({ id: $.id }))
				.where(($) => [$.id.eq(5), $.code.eq(Redacted.make("1234"))]),
		)
		expect(compiled.parameters).toEqual([5, "1234"])
		expect(compiled.sensitiveParameters).toEqual([1])
	})

	it("marks a Redacted param value", () => {
		const compiled = PG.compileUnsafe(
			PG.from(Codes)
				.select(($) => ({ id: $.id }))
				.where(($) => [$.code.eq(PG.param.of(doorCode, "code"))]),
			{ code: Redacted.make("9") },
		)
		expect(compiled.parameters).toEqual(["9"])
		expect(compiled.sensitiveParameters).toEqual([0])
	})

	it("marks a Redacted value an insert or update writes", () => {
		const insert = PG.compileUnsafe(PG.insertInto(Codes).values({ id: 2, code: Redacted.make("777") }))
		expect(insert.parameters).toEqual([2, "777"])
		expect(insert.sensitiveParameters).toEqual([1])
		const update = PG.compileUnsafe(PG.update(Codes).set({ code: Redacted.make("888") }).where(($) => [$.id.eq(1)]))
		expect(update.parameters).toEqual(["888", 1])
		expect(update.sensitiveParameters).toEqual([0])
	})

	it("marks a Redacted value inside a union branch", () => {
		const branch = (code: string) =>
			PG.from(Codes)
				.select(($) => ({ id: $.id }))
				.where(($) => [$.code.eq(Redacted.make(code))])
		const compiled = PG.compileUnionUnsafe(PG.unionAll(branch("a"), branch("b")))
		expect(compiled.sensitiveParameters).toEqual([0, 1])
	})

	it("is absent when no value is Redacted", () => {
		const compiled = PG.compileUnsafe(PG.from(Codes).select(($) => ({ id: $.id })).where(($) => [$.id.eq(5)]))
		expect(compiled.sensitiveParameters).toBeUndefined()
	})
})
