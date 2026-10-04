import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as CH from "./index"
import * as T from "./types"

const Events = CH.table("events", { OrgId: T.string, Id: T.uint8 }, { tenantColumn: "OrgId" })
const One = CH.table("system.one", {})
const count = CH.from(Events).select(() => ({ total: CH.count() }))
const scopedCount = count.where(($) => [$.OrgId.eq(CH.param.string("inner"))])
const outer = CH.from(Events).where(($) => [$.OrgId.eq(CH.param.string("outer"))])

describe("subquery source scope", () => {
	it("includes an unscoped scalar source even through prebuilt composition", () => {
		const total = CH.sum(CH.subqueryExpr(count, T.uint64).add(1))
		const compiled = CH.compileUnsafe(outer.select(() => ({ total })), { outer: "a" })
		expect(compiled.tenantScope).toBe("cross-tenant")
		expect(compiled.sql).toContain("sum((SELECT")
	})

	it("compares resolved inner and outer bindings on every compilation", () => {
		const total = CH.subqueryExpr(scopedCount, T.uint64)
		const query = outer.select(() => ({ total }))
		for (const [inner, expected] of [["a", "single-tenant"], ["b", "cross-tenant"], ["a", "single-tenant"]]) {
			expect(CH.compileUnsafe(query, { outer: "a", inner }).tenantScope).toBe(expected)
		}
	})

	it("does not let a scoped scalar source bind outer rows", () => {
		const query = CH.from(Events).select(() => ({ total: CH.subqueryExpr(scopedCount, T.uint64) }))
		expect(CH.compileUnsafe(query, { inner: "a" }).tenantScope).toBe("cross-tenant")
	})

	it("includes predicate subqueries through boolean composition", () => {
		const predicates = [
			CH.exists(count),
			CH.inSubquery(CH.lit(1), count),
			CH.notInSubquery(CH.lit(1), count),
			CH.subqueryCond(count, (sql) => `EXISTS (${sql})`),
			CH.subqueryExpr(count, T.uint64).gt(0),
		]
		for (const predicate of predicates) {
			const query = CH.from(Events).select("Id")
				.where(($) => [$.OrgId.eq("a"), CH.not(predicate.or(CH.lit(1).eq(2)))])
			expect(CH.compileUnsafe(query, {}).tenantScope).toBe("cross-tenant")
		}
	})

	it("includes HAVING, JOIN ON, untyped and window subqueries", () => {
		const predicate = CH.exists(count)
		const having = outer.select(() => ({ n: CH.count() })).having(() => [predicate])
		const joined = outer.innerJoin(One, "one", () => predicate).select("Id")
		const untyped = outer.select(() => ({ total: CH.untypedSubqueryExpr(count) }))
		const spec = CH.windowSpec({ partitionBy: [CH.subqueryExpr(count, T.uint64)] })
		const window = outer.select(() => ({ total: CH.over(CH.count(), spec) }))
		for (const compiled of [CH.compileUnsafe(having, { outer: "a" }), CH.compileUnsafe(joined, { outer: "a" }), CH.compileUnsafe(untyped, { outer: "a" }), CH.compileUnsafe(window, { outer: "a" })]) {
			expect(compiled.tenantScope).toBe("cross-tenant")
		}
	})

	it("inherits nested scopes without borrowing the enclosing tenant binding", () => {
		const middle = CH.from(One).select(() => ({ total: CH.subqueryExpr(count, T.uint64) }))
		const query = outer.select(() => ({ total: CH.subqueryExpr(middle, T.uint64) }))
		expect(CH.compileUnsafe(query, { outer: "a" }).tenantScope).toBe("cross-tenant")
	})

	it("keeps shared sources safe and handwritten subqueries unknown", () => {
		const shared = CH.from(One).select(() => ({ total: CH.lit(1) }))
		expect(CH.compileUnsafe(outer.select(() => ({ total: CH.subqueryExpr(shared, T.uint8) })), { outer: "a" }).tenantScope).toBe("single-tenant")
		expect(CH.compileUnsafe(outer.select(() => ({ total: CH.subqueryExpr("SELECT 1", T.uint8) })), { outer: "a" }).tenantScope).toBe("cross-tenant")
		expect(CH.compileUnsafe(CH.from(One).select(() => ({ total: CH.subqueryExpr(shared, T.uint8) })), {}).tenantScope).toBe("untenanted")
	})

	it("resolves enclosing CTE scope inside scalar subqueries", () => {
		const cte = CH.table("scoped", { total: T.uint64 })
		const inner = CH.from(cte).select("total")
		const query = outer.withCTE("scoped", scopedCount)
			.select(() => ({ total: CH.subqueryExpr(inner, T.uint64) }))
		expect(CH.compileUnsafe(query, { outer: "a", inner: "a" }).tenantScope).toBe("single-tenant")
		expect(CH.compileUnsafe(query, { outer: "a", inner: "b" }).tenantScope).toBe("cross-tenant")
	})

	it.effect("keeps deferred failures typed and restores compilation context", () => Effect.gen(function* () {
		const predicate = CH.subqueryExpr(scopedCount, T.uint64).gt(0)
		const query = outer.select("Id").having(() => [predicate])
		// @ts-expect-error -- a missing param is a type error too
		const result = yield* CH.compile(query, { outer: "a" }).pipe(Effect.result)
		expect(result._tag).toBe("Failure")
		if (result._tag === "Failure") expect(result.failure.code).toBe("UnresolvedParam")
		expect(CH.compileUnsafe(query, { outer: "a", inner: "a" }).tenantScope).toBe("single-tenant")
		expect(CH.compileUnsafe(CH.from(One).select(() => ({ n: CH.lit(1) })), {}).tenantScope).toBe("untenanted")
	}))
})

describe("array element schemas", () => {
	it.effect("decodes and encodes nullable elements in either argument order", () => Effect.gen(function* () {
		for (const reverse of [false, true]) {
			const elements = [CH.lit(1), CH.nullIf(CH.lit(2), 2)]
			if (reverse) elements.reverse()
			const compiled = CH.compileUnsafe(CH.from(One).select(() => ({ values: CH.arrayOf(...elements) })), {})
			const rows = [{ values: reverse ? [null, 1] : [1, null] }]
			expect(yield* compiled.decodeRows(rows)).toEqual(rows)
			expect(yield* compiled.encodeRows(rows)).toEqual(rows)
		}
	}))

	it("does not derive a schema if any array element is untyped", () => {
		const compiled = CH.compileUnsafe(CH.from(One).select(() => ({ values: CH.arrayOf(CH.lit(1), CH.untypedExpr<number>("2")) })), {})
		expect(compiled.rowSchemaSource).toBe("none")
		expect(compiled.untypedColumns).toEqual(["values"])
	})
})
