// Type-level tests: invalid queries that must not type-check.
//
// Each `@ts-expect-error` is a query that is not SQL, or is SQL that cannot
// mean what it says. The compile-time half of each rule is in soundness.test.ts.

import * as CH from "./index"
import { run } from "../database/database"

const Users = CH.table("users", {
	Id: CH.string,
	Name: CH.string,
	Nick: CH.nullable(CH.string),
	Age: CH.uint64,
})
const Orders = CH.table("orders", { Id: CH.string, UserId: CH.string, Amount: CH.uint64 })
const Tags = CH.table("tags", { Id: CH.string, UserId: CH.string, Label: CH.string })

// Comparisons against null: `x = NULL` is never true
// @ts-expect-error -- use isNull()
CH.from(Users).where(($) => [$.Nick.eq(null)])
// @ts-expect-error -- use isNotNull()
CH.from(Users).where(($) => [$.Nick.neq(null)])
// @ts-expect-error -- IN (NULL) matches nothing
CH.from(Users).where(($) => [$.Nick.in_(null)])
CH.from(Users).where(($) => [$.Nick.isNull(), $.Nick.eq("a"), $.Nick.eq($.Name)])

// LIKE takes a nullable string, and only a string
CH.from(Users).where(($) => [$.Nick.like("a%"), $.Name.ilike("a%")])
// @ts-expect-error -- LIKE on a number
CH.from(Users).where(($) => [$.Age.like("1%")])

// limit / offset literals
CH.from(Users).select("Id").limit(10).offset(0)
const pageSize: number = 20
CH.from(Users).select("Id").limit(pageSize)
// @ts-expect-error -- negative
CH.from(Users).select("Id").limit(-1)
// @ts-expect-error -- fractional
CH.from(Users).select("Id").offset(1.5)

// Join aliases
// @ts-expect-error -- shadows the FROM column `Name`
CH.from(Users).innerJoin(Orders, "Name", (u, o) => u.Id.eq(o.UserId))
CH.from(Users)
	.innerJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId))
	// @ts-expect-error -- `o` is already a join alias
	.innerJoin(Tags, "o", (u, t) => u.Id.eq(t.UserId))
// A join map held open (`Record<string, …>`, joins added conditionally) names no alias yet
declare let open: CH.CHQuery<(typeof Users)["columns"], {}, Record<string, CH.ColumnDefs>>
open = open.leftJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId))

// A query must select something before it is run or read from
// @ts-expect-error -- no SELECT list
CH.fromQuery(CH.from(Orders), "o")
// @ts-expect-error -- no SELECT list
CH.from(Users).leftJoinQuery(CH.from(Orders), "o", (u) => u.Id.eq("x"))
// @ts-expect-error -- no SELECT list
CH.from(Users).withCTE("o", CH.from(Orders))
// @ts-expect-error -- no SELECT list
CH.compileUnsafe(CH.from(Users))
// @ts-expect-error -- no SELECT list
run(CH.from(Users))
// @ts-expect-error -- no SELECT list
CH.exists(CH.from(Orders))
run(CH.from(Users).select("Id"))

// UNION ALL branches must agree on aliases and types
const ua = CH.from(Users).select("Id", "Name")
// @ts-expect-error -- extra column
CH.unionAll(ua, CH.from(Orders).select(($) => ({ Id: $.Id, Name: $.UserId, Extra: $.Amount })))
// @ts-expect-error -- missing column
CH.unionAll(ua, CH.from(Orders).select(($) => ({ Id: $.Id })))
// @ts-expect-error -- `Name` is a number in one branch
CH.unionAll(ua, CH.from(Orders).select(($) => ({ Id: $.Id, Name: $.Amount })))
// @ts-expect-error -- no branches
CH.unionAll()
// @ts-expect-error -- no SELECT list
CH.unionAll(CH.from(Users), CH.from(Users))
// Branch order of aliases may differ; a nullable branch widens the column
CH.unionAll(ua, CH.from(Users).select(($) => ({ Name: $.Nick, Id: $.Id })))

// IN (subquery) takes exactly one column of a comparable type
CH.from(Users).where(($) => [CH.inSubquery($.Id, CH.from(Orders).select("UserId"))])
// @ts-expect-error -- two columns
CH.from(Users).where(($) => [CH.inSubquery($.Id, CH.from(Orders).select("UserId", "Amount"))])
// @ts-expect-error -- a number column against a string
CH.from(Users).where(($) => [CH.notInSubquery($.Id, CH.from(Orders).select("Amount"))])

// Writes
// @ts-expect-error -- SET with no columns
CH.update(Orders).set({}).allRows()
// @ts-expect-error -- an UPDATE must say which rows
run(CH.update(Orders).set({ Amount: 1 }))
// @ts-expect-error -- a DELETE must say which rows
run(CH.deleteFrom(Orders))
// @ts-expect-error -- not compilable either
CH.compileUnsafe(CH.deleteFrom(Orders))
run(CH.update(Orders).set({ Amount: 1 }).where(($) => [$.Id.eq("a")]))
run(CH.deleteFrom(Orders).allRows())
// @ts-expect-error -- INSERT ... SELECT from a query with no SELECT list
CH.insertInto(CH.table("t", { a: CH.nullable(CH.string) })).select(CH.from(Users))

// Params: a query's `param.*` placeholders are in its type, and compile / run
// require them, with values of their types.
const byId = CH.from(Users)
	.select("Id")
	.where(($) => [$.Id.eq(CH.param.string("id"))])
	.where(($) => [$.Age.between(CH.param.int("minAge"), 99)])
CH.compileUnsafe(byId, { id: "a", minAge: 1 })
CH.compileUnsafe(byId, { id: "a", minAge: 1, unrelated: true })
// @ts-expect-error -- `minAge` is missing
CH.compileUnsafe(byId, { id: "a" })
// @ts-expect-error -- `id` is a string param
CH.compileUnsafe(byId, { id: 1, minAge: 1 })
// @ts-expect-error -- no params at all
CH.compileUnsafe(byId)
// @ts-expect-error -- run checks them too
run(byId, {})
run(byId, { id: "a", minAge: 1 })
CH.compileUnsafe(CH.from(Users).select("Id"))

// Through and/or/not, select, having, joins, subqueries in FROM, unions
const combined = CH.from(Users)
	.innerJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId).and(o.Amount.gt(CH.param.int("minAmount"))))
	.select(($) => ({ Id: $.Id, scaled: $.Age.mul(CH.param.float("scale")) }))
	.where(($) => [CH.or($.Name.eq(CH.param.string("name")), CH.not($.Nick.isNull()))])
// @ts-expect-error -- needs minAmount, scale and name
CH.compileUnsafe(combined, { minAmount: 1, scale: 2 })
CH.compileUnsafe(combined, { minAmount: 1, scale: 2, name: "n" })
const outer = CH.fromQuery(byId, "b").select("Id")
// @ts-expect-error -- the subquery's params are the outer query's
CH.compileUnsafe(outer, {})
const both = CH.unionAll(byId, CH.from(Users).select("Id").where(($) => [$.Name.eq(CH.param.string("name"))]))
// @ts-expect-error -- every branch's params
CH.compileUnionUnsafe(both, { id: "a", minAge: 1 })
CH.compileUnionUnsafe(both, { id: "a", minAge: 1, name: "n" })

// A DateTime param takes a Date or a string as well
const Events = CH.table("events", { At: CH.dateTime64 })
CH.compileUnsafe(CH.from(Events).select("At").where(($) => [$.At.gte(CH.param.dateTime("since"))]), {
	since: new Date(),
})

// Writes
const ins = CH.insertInto(Orders).values({ Id: CH.param.string("id"), UserId: "u", Amount: 1 })
// @ts-expect-error -- `id` is missing
CH.compileUnsafe(ins, {})
CH.compileUnsafe(ins, { id: "x" })
// @ts-expect-error -- not a column of the table
CH.insertInto(Orders).values({ Id: "a", UserId: "u", Amount: 1, Bogus: 1 })
const upd = CH.update(Orders)
	.set({ Amount: CH.param.int("amount") })
	.where(($) => [$.Id.eq(CH.param.string("id"))])
// @ts-expect-error -- `amount` is missing
run(upd, { id: "a" })
run(upd, { id: "a", amount: 1 })
// @ts-expect-error -- not a column of the table
CH.update(Orders).set({ Bogus: 1 }).allRows()
const del = CH.deleteFrom(Orders).where(($) => [$.Id.eq(CH.param.string("id"))])
// @ts-expect-error -- `id` is missing
run(del)
run(del, { id: "a" })

// A custom expression carries the params of the expressions it declares in `uses`
{
	const { raw } = { raw: (sql: string) => CH.untypedExpr(sql).toFragment() }
	const scaled = CH.from(Users).select(($) => {
		const factor = CH.param.float("factor")
		return { x: CH.makeExpr(raw("x"), CH.float64.schema, undefined, [$.Age, factor]) }
	})
	// @ts-expect-error -- `factor` comes from `uses`
	CH.compileUnsafe(scaled, {})
	CH.compileUnsafe(scaled, { factor: 2 })
}

// @ts-expect-error -- the value type comes from the schema; an explicit one would stop `uses` being read
CH.makeExpr<number>(CH.untypedExpr("1").toFragment(), CH.float64.schema)

// An explicit type argument on a subquery expression is an error, not a silent loss of params
const scoped = CH.from(Orders).select(() => ({ n: CH.count() })).where(($) => [$.UserId.eq(CH.param.string("u"))])
// @ts-expect-error -- the subquery is inferred; give the type as a column type
CH.subqueryExpr<number>(scoped, CH.uint64)
// @ts-expect-error -- untypedSubqueryExpr takes no value type
CH.untypedSubqueryExpr<number>(scoped)
const withScalar = CH.from(Users).select(() => ({ n: CH.subqueryExpr(scoped, CH.uint64) }))
// @ts-expect-error -- the subquery's `u` is required
CH.compileUnsafe(withScalar, {})
