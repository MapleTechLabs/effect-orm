import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as CH from "./index"
import * as T from "./types"

const Events = CH.table("events", {
	OrgId: T.string, Id: T.uint8, Timestamp: T.dateTime, Attributes: T.map(T.string, T.string),
}, { tenantColumn: "OrgId" })

describe("source column identity", () => {
	it("qualifies source references even when a SELECT alias shadows a tenant column", () => {
		const query = CH.from(Events).select(() => ({ OrgId: CH.lit("a"), total: CH.count() }))
			.where(($) => [$.OrgId.eq("a")])
		const compiled = CH.compileUnsafe(query, {})
		expect(compiled.sql).toContain("WHERE events.OrgId = 'a'")
		expect(compiled.tenantScope).toBe("single-tenant")
		const aliased = CH.compileUnsafe(CH.from(Events, "e").select("OrgId").where(($) => [$.OrgId.eq("a")]), {})
		expect(aliased.sql).toContain("WHERE e.OrgId = 'a'")
	})

	it("retains direct projection literal codecs through nested sources", () => {
		const inner = CH.from(Events).select("Timestamp", "Attributes")
		const query = CH.fromQuery(CH.fromQuery(inner, "a").select("Timestamp", "Attributes"), "b")
			.select("Timestamp")
			.where(($) => [$.Timestamp.gte(new Date("2026-01-01T00:00:00Z")), $.Attributes.eq({ a: "b" })])
		const compiled = CH.compileUnsafe(query, {})
		expect(compiled.sql).toContain("b.Timestamp >= '2026-01-01 00:00:00'")
		expect(compiled.sql).toContain("b.Attributes = CAST(map('a', 'b') AS Map(String, String))")
	})

	it("keeps built-in timestamp comparison codecs after computed projections", () => {
		const inner = CH.from(Events).select(($) => ({ ts: CH.min($.Timestamp) }))
		const compiled = CH.compileUnsafe(CH.fromQuery(inner, "q").select("ts")
			.where(($) => [$.ts.gte(new Date("2026-01-01T00:00:00Z"))]), {})
		expect(compiled.sql).toContain("q.ts >= '2026-01-01 00:00:00'")
	})

	it("supplies codecs to both sides of derived-source joins", () => {
		const inner = CH.from(Events).select("Attributes", "Timestamp")
		for (const compiled of [
			CH.compileUnsafe(CH.from(Events).innerJoinQuery(inner, "j", (main, j) => main.Attributes.eq({ a: "b" }).and(j.Attributes.eq({ a: "b" }))).select("Id"), {}),
			CH.compileUnsafe(CH.fromQuery(inner, "q").innerJoin(Events, "e", (main, e) => main.Attributes.eq({ a: "b" }).and(e.Attributes.eq({ a: "b" }))).select(() => ({ Id: CH.lit(1) })), {}),
		]) {
			expect(compiled.sql).not.toContain("[object Object]")
			expect(compiled.sql.match(/= CAST\(map\('a', 'b'\) AS Map\(String, String\)\)/g)).toHaveLength(2)
		}
	})

	it.effect("reports invalid join values through the compile error channel", () => Effect.gen(function* () {
		const query = CH.from(Events).innerJoin(Events, "e", (main) => main.Timestamp.gte("invalid timestamp")).select("Id")
		const result = yield* CH.compile(query, {}).pipe(Effect.result)
		expect(result._tag).toBe("Failure")
		if (result._tag === "Failure") expect(result.failure.code).toBe("InvalidLiteral")
	}))
})
