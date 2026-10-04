// Invalid queries are refused before any SQL is sent.
//
// The type-level half is in soundness.test-d.ts. These cover what a type cannot
// see (values from data, casts, untyped callers) and pin the SQL written for
// the edge cases that do have a meaning.

import { describe, expect, it } from "@effect/vitest"
import * as CH from "./index"
import { compileCHUnsafe, compileUnionUnsafe } from "./compile"

const Users = CH.table("users", { Id: CH.string, Name: CH.string, Nick: CH.nullable(CH.string), Age: CH.uint64 })
const Orders = CH.table("orders", { Id: CH.string, UserId: CH.string, Amount: CH.uint64 })
const Tags = CH.table("tags", { Id: CH.string, UserId: CH.string, Label: CH.string })

const whereSql = (query: { readonly sql: string }) => query.sql.split("WHERE ")[1]?.replace(/\s+/g, " ").trim()

describe("comparisons", () => {
	it("writes an empty IN list as the constant it means", () => {
		const ids: Array<string> = []
		expect(whereSql(compileCHUnsafe(CH.from(Users).select("Id").where(($) => [$.Id.in_(...ids)])))).toBe("1 = 0")
		expect(whereSql(compileCHUnsafe(CH.from(Users).select("Id").where(($) => [$.Id.notIn(...ids)])))).toBe("1 = 1")
		expect(whereSql(compileCHUnsafe(CH.from(Users).select("Id").where(($) => [CH.inList($.Id, [])])))).toBe("1 = 0")
	})

	it("refuses a null that slipped past the types", () => {
		const nick = null as unknown as string
		expect(() => compileCHUnsafe(CH.from(Users).select("Id").where(($) => [$.Nick.eq(nick)]))).toThrow(/isNull/)
		expect(() => compileCHUnsafe(CH.from(Users).select("Id").where(($) => [$.Age.between(1, nick as never)]))).toThrow(
			/isNull/,
		)
	})
})

describe("where and having", () => {
	it("AND a second where with the first, keeping the tenant filter", () => {
		const Scoped = CH.table("scoped", { OrgId: CH.string, Ms: CH.uint64 }, { tenantColumn: "OrgId" })
		const compiled = compileCHUnsafe(
			CH.from(Scoped)
				.select("Ms")
				.where(($) => [$.OrgId.eq("org")])
				.where(($) => [$.Ms.gt(1)]),
		)
		expect(whereSql(compiled)).toBe("scoped.OrgId = 'org' AND scoped.Ms > 1")
		expect(compiled.tenantScope).toBe("single-tenant")
	})

	it("AND a second where on an UPDATE or DELETE", () => {
		const sql = compileCHUnsafe(
			CH.deleteFrom(Orders)
				.where(($) => [$.UserId.eq("u")])
				.where(($) => [$.Amount.gt(1)]),
		).sql
		expect(sql.replace(/\s+/g, " ")).toContain("UserId = 'u' AND Amount > 1")
	})
})

describe("limit and offset", () => {
	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses %s", (n) => {
		expect(() => compileCHUnsafe(CH.from(Users).select("Id").limit(n))).toThrow(/non-negative integer/)
		expect(() => compileCHUnsafe(CH.from(Users).select("Id").offset(n))).toThrow(/non-negative integer/)
		expect(() => compileUnionUnsafe(CH.unionAll(CH.from(Users).select("Id")).limit(n), {})).toThrow(
			/non-negative integer/,
		)
	})

	it("writes a valid count as it is", () => {
		expect(compileCHUnsafe(CH.from(Users).select("Id").limit(0).offset(20)).sql).toMatch(/LIMIT 0\s+OFFSET 20/)
	})
})

describe("source names", () => {
	it("refuses a join alias that is the FROM alias", () => {
		expect(() =>
			compileCHUnsafe(
				CH.from(Users, "u")
					.innerJoin(Orders, "u", (u, o) => u.Id.eq(o.UserId))
					.select("Id"),
			),
		).toThrow(/already the name of another source/)
	})

	it("refuses two joins under one alias, and a join alias that hides a column", () => {
		const any = CH.from(Users) as any
		expect(() =>
			compileCHUnsafe(
				any
					.innerJoin(Orders, "o", (u: any, o: any) => u.Id.eq(o.UserId))
					.innerJoin(Tags, "o", (u: any, t: any) => u.Id.eq(t.UserId))
					.select("Id"),
			),
		).toThrow(/already the name of another source/)
		expect(() =>
			compileCHUnsafe(any.innerJoin(Orders, "Name", (u: any, o: any) => u.Id.eq(o.UserId)).select("Id")),
		).toThrow(/also a column of the FROM source/)
	})

	it("refuses a CTE defined twice", () => {
		expect(() =>
			compileCHUnsafe(
				CH.from(Users)
					.withCTE("x", CH.from(Orders).select("Id"))
					.withCTE("x", CH.from(Tags).select("Id"))
					.select("Id"),
			),
		).toThrow(/defined twice/)
	})
})
