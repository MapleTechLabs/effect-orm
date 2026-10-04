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
