import { describe, expect, it } from "vitest"
import * as CH from "./index"
import { compileCHUnsafe } from "./compile"
import * as PG from "../postgres"

const Users = CH.table(
	"users",
	{ OrgId: CH.string, Id: CH.string, Name: CH.string, Age: CH.uint64 },
	{ tenantColumn: "OrgId" },
)

// Typed loosely: the point is the SQL text, and the type tests are in query-pipe.test-d.ts.
const sqlOf = (query: { readonly _state: unknown }): string => compileCHUnsafe(query as any, {} as any).sql

describe("pipeable queries", () => {
	it("a query has pipe", () => {
		const query = CH.from(Users).select("Id")
		expect(query.pipe()).toBe(query)
		expect(query.pipe((q) => q.limit(1))._state.limitValue).toBe(1)
	})
})

describe("Query.where", () => {
	it("data-last and data-first write the fluent SQL", () => {
		const base = CH.from(Users).select("Id")
		const fluent = base.where(($) => [$.OrgId.eq("org_1")])
		const piped = base.pipe(CH.Query.where(($) => [$.OrgId.eq("org_1")]))
		const dataFirst = CH.Query.where(base, ($) => [$.OrgId.eq("org_1")])
		expect(sqlOf(piped)).toBe(sqlOf(fluent))
		expect(sqlOf(dataFirst)).toBe(sqlOf(fluent))
	})
})

describe("Query.select", () => {
	it("every form writes the fluent SQL, data-last and data-first", () => {
		const base = CH.from(Users)
		const callback = ($: any) => ({ id: $.Id, name: $.Name })
		expect(sqlOf(base.pipe(CH.Query.select()))).toBe(sqlOf(base.select()))
		expect(sqlOf(CH.Query.select(base))).toBe(sqlOf(base.select()))
		expect(sqlOf(base.pipe(CH.Query.select("Id", "Name")))).toBe(sqlOf(base.select("Id", "Name")))
		expect(sqlOf(CH.Query.select(base, "Id", "Name"))).toBe(sqlOf(base.select("Id", "Name")))
		expect(sqlOf(base.pipe(CH.Query.select(($) => ({ id: $.Id }))))).toBe(sqlOf(base.select(($) => ({ id: $.Id }))))
		expect(sqlOf(CH.Query.select(base, callback))).toBe(sqlOf(base.select(callback)))
	})
})

describe("Query.orderBy and Query.limit", () => {
	it("write the fluent SQL, data-last and data-first", () => {
		const base = CH.from(Users).select(($) => ({ id: $.Id, age: $.Age }))
		const byKey = base.orderBy(["age", "desc"], ["id", "asc"])
		expect(sqlOf(base.pipe(CH.Query.orderBy(["age", "desc"], ["id", "asc"])))).toBe(sqlOf(byKey))
		expect(sqlOf(CH.Query.orderBy(base, ["age", "desc"], ["id", "asc"]))).toBe(sqlOf(byKey))
		const byExpr = base.orderBy(($) => [[$.Name, "asc"]])
		expect(sqlOf(base.pipe(CH.Query.orderBy(($) => [[$.Name, "asc"]])))).toBe(sqlOf(byExpr))
		expect(sqlOf(CH.Query.orderBy(base, ($) => [[$.Name, "asc"]]))).toBe(sqlOf(byExpr))
		expect(sqlOf(base.pipe(CH.Query.limit(10)))).toBe(sqlOf(base.limit(10)))
		expect(sqlOf(CH.Query.limit(base, 10))).toBe(sqlOf(base.limit(10)))
	})
})

const Orders = CH.table("orders", { OrgId: CH.string, UserId: CH.string, Amount: CH.uint64 }, { tenantColumn: "OrgId" })

describe("Query joins", () => {
	it("innerJoin, leftJoin and crossJoin write the fluent SQL, data-last and data-first", () => {
		const base = CH.from(Users)
		const pick = ($: any) => ({ id: $.Id, amount: $.o.Amount })
		const on = (u: any, o: any) => u.Id.eq(o.UserId)
		expect(sqlOf(base.pipe(CH.Query.innerJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId)), CH.Query.select(pick)))).toBe(
			sqlOf(base.innerJoin(Orders, "o", on).select(pick)),
		)
		expect(sqlOf(CH.Query.innerJoin(base, Orders, "o", on).select(pick))).toBe(sqlOf(base.innerJoin(Orders, "o", on).select(pick)))
		expect(sqlOf(base.pipe(CH.Query.leftJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId)), CH.Query.select(pick)))).toBe(
			sqlOf(base.leftJoin(Orders, "o", on).select(pick)),
		)
		expect(sqlOf(CH.Query.leftJoin(base, Orders, "o", on).select(pick))).toBe(sqlOf(base.leftJoin(Orders, "o", on).select(pick)))
		expect(sqlOf(base.pipe(CH.Query.crossJoin(Orders, "o"), CH.Query.select(pick)))).toBe(sqlOf(base.crossJoin(Orders, "o").select(pick)))
		expect(sqlOf(CH.Query.crossJoin(base, Orders, "o").select(pick))).toBe(sqlOf(base.crossJoin(Orders, "o").select(pick)))
	})
})

describe("a piped chain", () => {
	it("compiles to the fluent SQL and params on ClickHouse and Postgres", () => {
		const piped = CH.Query.from(Users).pipe(
			CH.Query.innerJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId)),
			CH.Query.select(($) => ({ id: $.Id, amount: $.o.Amount })),
			CH.Query.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Age.gt(18)]),
			CH.Query.orderBy(["amount", "desc"]),
			CH.Query.limit(20),
		)
		const fluent = CH.from(Users)
			.innerJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId))
			.select(($) => ({ id: $.Id, amount: $.o.Amount }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Age.gt(18)])
			.orderBy(["amount", "desc"])
			.limit(20)
		const params = { orgId: "org_1" }
		const ch = CH.compileUnsafe(piped, params)
		const chFluent = CH.compileUnsafe(fluent, params)
		expect(ch.sql).toBe(chFluent.sql)
		expect(ch.parameters).toEqual(chFluent.parameters)
		expect(ch.tenantScope).toBe(chFluent.tenantScope)
		expect(PG.compileUnsafe(piped, params).sql).toBe(PG.compileUnsafe(fluent, params).sql)
	})
})
