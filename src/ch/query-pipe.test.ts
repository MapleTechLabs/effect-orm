import { describe, expect, it } from "vitest"
import * as CH from "./index"
import { compileCHUnsafe } from "./compile"
import * as PG from "../postgres"
import * as SQLite from "../sqlite"

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

// What each entry writes for a query, or the message it refuses it with: a
// form one dialect lacks (row locks, FORMAT, DISTINCT ON) must be refused the
// same way piped as fluent.
const dialects = {
	clickhouse: (query: any, params: any) => CH.compileUnsafe(query, params),
	postgres: (query: any, params: any) => PG.compileUnsafe(query, params),
	sqlite: (query: any, params: any) => SQLite.compileUnsafe(query, params),
	d1: (query: any, params: any) => SQLite.compileUnsafe(query, params, { dialect: SQLite.d1Dialect }),
}
const outcome = (compileWith: (query: any, params: any) => CH.CompiledQuery<any, any>, query: unknown) => {
	try {
		const compiled = compileWith(query, { orgId: "org_1" })
		return { sql: compiled.sql, parameters: compiled.parameters, tenantScope: compiled.tenantScope }
	} catch (error) {
		return { refused: String((error as Error).message) }
	}
}
const expectSameEverywhere = (fluent: unknown, ...others: ReadonlyArray<unknown>) => {
	for (const [name, compileWith] of Object.entries(dialects)) {
		const expected = outcome(compileWith, fluent)
		for (const other of others) expect(outcome(compileWith, other), name).toEqual(expected)
	}
}

describe("every builder method", () => {
	it("has a Query function", () => {
		const methods = Object.keys(CH.from(Users)).filter((key) => key !== "_state" && key !== "pipe")
		expect(methods.length).toBeGreaterThan(20)
		expect(methods.filter((method) => typeof (CH.Query as Record<string, unknown>)[method] !== "function")).toEqual([])
	})
})

describe("the remaining methods, on every dialect", () => {
	// No aggregate: each dialect has its own `count`, and these must compile on all four.
	const grouped = CH.from(Users).select(($) => ({ org: $.OrgId }))
	const selected = CH.from(Users).select(($) => ({ id: $.Id, age: $.Age }))
	const scoped = ($: any) => [$.OrgId.eq(CH.param.string("orgId"))]

	it("groupBy and having", () => {
		const notOrg = ($: any) => [$.OrgId.neq(CH.param.string("orgId"))]
		expectSameEverywhere(
			grouped.groupBy("org").having(notOrg),
			grouped.pipe(CH.Query.groupBy("org"), CH.Query.having(($) => [$.OrgId.neq(CH.param.string("orgId"))])),
			CH.Query.having(CH.Query.groupBy(grouped, "org"), notOrg),
		)
	})

	it("offset, distinct, distinctOn, format", () => {
		expectSameEverywhere(selected.limit(5).offset(10), selected.pipe(CH.Query.limit(5), CH.Query.offset(10)), CH.Query.offset(selected.limit(5), 10))
		expectSameEverywhere(selected.distinct(), selected.pipe(CH.Query.distinct()), CH.Query.distinct(selected))
		expectSameEverywhere(selected.distinctOn("id"), selected.pipe(CH.Query.distinctOn("id")), CH.Query.distinctOn(selected, "id"))
		expectSameEverywhere(selected.format("JSON"), selected.pipe(CH.Query.format("JSON")), CH.Query.format(selected, "JSON"))
	})

	it("row locks, with and without options", () => {
		const base = selected.where(scoped)
		expectSameEverywhere(base.forUpdate(), base.pipe(CH.Query.forUpdate()), CH.Query.forUpdate(base))
		expectSameEverywhere(
			base.forUpdate({ skipLocked: true }),
			base.pipe(CH.Query.forUpdate({ skipLocked: true })),
			CH.Query.forUpdate(base, { skipLocked: true }),
		)
		expectSameEverywhere(base.forNoKeyUpdate(), base.pipe(CH.Query.forNoKeyUpdate()), CH.Query.forNoKeyUpdate(base))
		expectSameEverywhere(base.forShare({ noWait: true }), base.pipe(CH.Query.forShare({ noWait: true })), CH.Query.forShare(base, { noWait: true }))
		expectSameEverywhere(base.forKeyShare(), base.pipe(CH.Query.forKeyShare()), CH.Query.forKeyShare(base))
	})

	it("route and crossTenant", () => {
		expectSameEverywhere(selected.crossTenant(), selected.pipe(CH.Query.crossTenant()), CH.Query.crossTenant(selected))
		expect(selected.pipe(CH.Query.route("replica"))._state).toEqual(selected.route("replica")._state)
		expect(CH.Query.route(selected, "replica")._state).toEqual(selected.route("replica")._state)
	})

	it("subquery joins: the first data-last argument is a query, and still data-last", () => {
		const totals = CH.from(Orders).select(($) => ({ user: $.UserId, amount: $.Amount }))
		const on = (u: any, t: any) => u.Id.eq(t.user)
		const pick = ($: any) => ({ id: $.Id, amount: $.t.amount })
		const base = CH.from(Users).where(scoped)
		expectSameEverywhere(
			base.innerJoinQuery(totals, "t", on).select(pick),
			base.pipe(CH.Query.innerJoinQuery(totals, "t", (u, t) => u.Id.eq(t.user)), CH.Query.select(pick)),
			CH.Query.innerJoinQuery(base, totals, "t", on).select(pick),
		)
		expectSameEverywhere(
			base.leftJoinQuery(totals, "t", on).select(pick),
			base.pipe(CH.Query.leftJoinQuery(totals, "t", (u, t) => u.Id.eq(t.user)), CH.Query.select(pick)),
			CH.Query.leftJoinQuery(base, totals, "t", on).select(pick),
		)
		expectSameEverywhere(
			base.crossJoinQuery(totals, "t").select(pick),
			base.pipe(CH.Query.crossJoinQuery(totals, "t"), CH.Query.select(pick)),
			CH.Query.crossJoinQuery(base, totals, "t").select(pick),
		)
	})

	it("withCTE, from a query and from SQL", () => {
		const recent = CH.from(Orders).select(($) => ({ user: $.UserId })).where(scoped)
		const base = selected.where(scoped)
		expectSameEverywhere(base.withCTE("recent", recent), base.pipe(CH.Query.withCTE("recent", recent)), CH.Query.withCTE(base, "recent", recent))
		const sql = "SELECT 1 AS one"
		expectSameEverywhere(
			base.withCTE("one", sql, { tenantScope: "cross-tenant" }),
			base.pipe(CH.Query.withCTE("one", sql, { tenantScope: "cross-tenant" })),
			CH.Query.withCTE(base, "one", sql, { tenantScope: "cross-tenant" }),
		)
	})
})
