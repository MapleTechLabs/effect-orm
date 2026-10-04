// Type-level tests: a `param.*` used inside a function call is a param of the
// query that uses the call.

import type { DateTime } from "effect"
import { expectTypeOf } from "expect-type"
import * as CH from "./index"
import * as PG from "../postgres"
import type { InferQueryOutput } from "./query"
import type { Condition, Expr } from "./expr"

const Users = CH.table("users", {
	Id: CH.string,
	Name: CH.string,
	Age: CH.uint64,
	Score: CH.float64,
	Nick: CH.nullable(CH.string),
	Attrs: CH.map(CH.string, CH.string),
	Tags: CH.array(CH.string),
	Nums: CH.array(CH.uint64),
	CreatedAt: CH.dateTime64,
})

const PgUsers = CH.table("users", { id: PG.text, age: PG.int4, at: PG.timestamptz })

// aggregate.ts
const agg = CH.from(Users).select(($) => ({ n: CH.sumIf($.Age, $.Name.eq(CH.param.string("name"))) }))
// @ts-expect-error -- `name` is missing
CH.compileUnsafe(agg, {})
CH.compileUnsafe(agg, { name: "a" })

// array.ts
const arr = CH.from(Users)
	.select("Id")
	.where(($) => [CH.has($.Tags, CH.param.string("tag"))])
// @ts-expect-error -- `tag` is missing
CH.compileUnsafe(arr, {})
CH.compileUnsafe(arr, { tag: "a" })
const arrOf = CH.from(Users).select(($) => ({ xs: CH.arrayOf($.Name, CH.param.string("extra")) }))
expectTypeOf<InferQueryOutput<typeof arrOf>>().toEqualTypeOf<{ readonly xs: ReadonlyArray<string> }>()
// @ts-expect-error -- `extra` is missing
CH.compileUnsafe(arrOf, {})
CH.compileUnsafe(arrOf, { extra: "a" })
const elem = CH.from(Users).select(($) => ({ x: CH.arrayElement($.Nums, CH.param.int("i")) }))
expectTypeOf<InferQueryOutput<typeof elem>>().toEqualTypeOf<{ readonly x: number }>()
// @ts-expect-error -- `i` is missing
CH.compileUnsafe(elem, {})
CH.compileUnsafe(elem, { i: 1 })

// conditional.ts
const cond = CH.from(Users).select(($) => ({
	label: CH.if_($.Age.gt(CH.param.int("adult")), $.Name, CH.param.string("fallback")),
}))
expectTypeOf<InferQueryOutput<typeof cond>>().toEqualTypeOf<{ readonly label: string }>()
// @ts-expect-error -- `fallback` is missing
CH.compileUnsafe(cond, { adult: 18 })
CH.compileUnsafe(cond, { adult: 18, fallback: "x" })
const multi = CH.from(Users).select(($) => ({
	band: CH.multiIf(
		[
			[$.Age.lt(CH.param.int("young")), CH.lit("young")],
			[$.Age.lt(60), CH.lit("adult")],
		],
		CH.lit("old"),
	),
}))
expectTypeOf<InferQueryOutput<typeof multi>>().toEqualTypeOf<{ readonly band: string }>()
// @ts-expect-error -- `young` is missing
CH.compileUnsafe(multi, {})
CH.compileUnsafe(multi, { young: 18 })
const coalesced = CH.from(Users).select(($) => ({ nick: CH.coalesce($.Nick, CH.param.string("anon")) }))
expectTypeOf<InferQueryOutput<typeof coalesced>>().toEqualTypeOf<{ readonly nick: string }>()
// @ts-expect-error -- `anon` is missing
CH.compileUnsafe(coalesced, {})
CH.compileUnsafe(coalesced, { anon: "a" })
expectTypeOf(CH.coalesce(CH.nullIf(CH.lit(1), 1), CH.lit(2))).toMatchTypeOf<Expr<number>>()

// date-time.ts
const bucketed = CH.from(Users).select(($) => ({ bucket: CH.toStartOfInterval($.CreatedAt, CH.param.int("step")) }))
expectTypeOf<InferQueryOutput<typeof bucketed>>().toEqualTypeOf<{ readonly bucket: DateTime.Utc }>()
// @ts-expect-error -- `step` is missing
CH.compileUnsafe(bucketed, {})
CH.compileUnsafe(bucketed, { step: 60 })
expectTypeOf(CH.toStartOfInterval(CH.param.dateTime("ts"), 60)).toMatchTypeOf<Expr<DateTime.Utc>>()

// map.ts
const mapped = CH.from(Users)
	.select("Id")
	.where(($) => [CH.mapGet($.Attrs, "k").eq(CH.param.string("v")), CH.mapContains($.Attrs, "k")])
// @ts-expect-error -- `v` is missing
CH.compileUnsafe(mapped, {})
CH.compileUnsafe(mapped, { v: "a" })
const mapLit = CH.from(Users).select(() => ({ m: CH.mapLiteral(["k", CH.param.string("mv")]) }))
// @ts-expect-error -- `mv` is missing
CH.compileUnsafe(mapLit, {})
CH.compileUnsafe(mapLit, { mv: "a" })

// numeric.ts
const numeric = CH.from(Users).select(($) => ({ d: CH.intDiv($.Age, CH.param.int("by")) }))
// @ts-expect-error -- `by` is missing
CH.compileUnsafe(numeric, {})
CH.compileUnsafe(numeric, { by: 2 })

// string.ts
const str = CH.from(Users).select(($) => ({ s: CH.concat($.Name, CH.param.string("suffix")) }))
expectTypeOf<InferQueryOutput<typeof str>>().toEqualTypeOf<{ readonly s: string }>()
// @ts-expect-error -- `suffix` is missing
CH.compileUnsafe(str, {})
CH.compileUnsafe(str, { suffix: "!" })

// window.ts
const windowed = CH.from(Users).select(($) => ({
	prev: CH.over(
		CH.lagInFrame($.Score, 1, CH.param.float("dflt")),
		CH.windowSpec({ partitionBy: [$.Name], orderBy: [[$.CreatedAt, "asc"]] }),
	),
}))
expectTypeOf<InferQueryOutput<typeof windowed>>().toEqualTypeOf<{ readonly prev: number }>()
// @ts-expect-error -- `dflt` is missing
CH.compileUnsafe(windowed, {})
CH.compileUnsafe(windowed, { dflt: 0 })
const framed = CH.from(Users).select(($) => ({
	total: CH.over(
		CH.sum($.Age),
		CH.windowSpec({
			orderBy: [[$.CreatedAt, "asc"]],
			frame: CH.rowsBetween(CH.preceding(CH.param.int("back")), CH.currentRow),
		}),
	),
}))
// @ts-expect-error -- `back` is missing
CH.compileUnsafe(framed, {})
CH.compileUnsafe(framed, { back: 3 })
const partitioned = CH.from(Users).select(($) => ({
	n: CH.over(CH.count(), CH.windowSpec({ partitionBy: [CH.concat($.Name, CH.param.string("p"))] })),
}))
// @ts-expect-error -- `p` is missing
CH.compileUnsafe(partitioned, {})
CH.compileUnsafe(partitioned, { p: "x" })

// subquery.ts
const inner = CH.from(Users)
	.select("Id")
	.where(($) => [$.Age.gt(CH.param.int("minAge"))])
const viaIn = CH.from(Users)
	.select("Id")
	.where(($) => [CH.inSubquery($.Id, inner)])
// @ts-expect-error -- the subquery's `minAge` is missing
CH.compileUnsafe(viaIn, {})
CH.compileUnsafe(viaIn, { minAge: 1 })
const viaExists = CH.from(Users)
	.select("Id")
	.where(() => [CH.exists(inner)])
// @ts-expect-error -- the subquery's `minAge` is missing
CH.compileUnsafe(viaExists, {})
CH.compileUnsafe(viaExists, { minAge: 1 })
const viaExpr = CH.from(Users).select(() => ({ n: CH.subqueryExpr(inner, CH.uint64, (sql) => `(SELECT count() FROM (${sql}))`) }))
expectTypeOf<InferQueryOutput<typeof viaExpr>>().toEqualTypeOf<{ readonly n: number }>()
// @ts-expect-error -- the subquery's `minAge` is missing
CH.compileUnsafe(viaExpr, {})
CH.compileUnsafe(viaExpr, { minAge: 1 })
// The SQL-string arm carries none.
CH.compileUnsafe(CH.from(Users).select("Id").where(() => [CH.subqueryCond("SELECT 1", (sql) => `1 IN (${sql})`)]), {})

// sql-template.ts
const typed = CH.sql(CH.float64)`1`
expectTypeOf(typed).toEqualTypeOf<Expr<number, never>>()
const templated = CH.from(Users).select(($) => ({ x: CH.sql(CH.float64)`${$.Score} * ${CH.param.float("factor")}` }))
expectTypeOf<InferQueryOutput<typeof templated>>().toEqualTypeOf<{ readonly x: number }>()
// @ts-expect-error -- `factor` is missing
CH.compileUnsafe(templated, {})
CH.compileUnsafe(templated, { factor: 2 })
const tcond = CH.from(Users)
	.select("Id")
	.where(($) => [CH.sql.cond`${$.Name} = ${CH.param.string("who")}`])
// @ts-expect-error -- `who` is missing
CH.compileUnsafe(tcond, {})
CH.compileUnsafe(tcond, { who: "a" })
expectTypeOf(CH.sql.cond`1 = 1`).toEqualTypeOf<Condition<never>>()
const joined = CH.from(Users)
	.select("Id")
	.where(($) => [CH.sql.cond`${$.Age} IN (${CH.sql.join([1, CH.param.int("other")])})`])
// @ts-expect-error -- `other` is missing
CH.compileUnsafe(joined, {})
CH.compileUnsafe(joined, { other: 2 })
const tsub = CH.from(Users)
	.select("Id")
	.where(($) => [CH.sql.cond`${$.Id} IN ${inner}`])
// @ts-expect-error -- the subquery's `minAge` is missing
CH.compileUnsafe(tsub, {})
CH.compileUnsafe(tsub, { minAge: 1 })

// pg/functions.ts
const pg = CH.from(PgUsers).select(($) => ({ n: PG.sumIf($.age, $.id.eq(CH.param.string("pgId"))) }))
// @ts-expect-error -- `pgId` is missing
PG.compileUnsafe(pg, {})
PG.compileUnsafe(pg, { pgId: "a" })
const pgBin = CH.from(PgUsers).select(($) => ({ day: PG.dateTrunc("day", PG.coalesce($.at, CH.param.dateTime("dflt"))) }))
expectTypeOf<InferQueryOutput<typeof pgBin>>().toEqualTypeOf<{ readonly day: DateTime.Utc }>()
// @ts-expect-error -- `dflt` is missing
PG.compileUnsafe(pgBin, {})
PG.compileUnsafe(pgBin, { dflt: new Date() })

// An array literal keeps every element's params.
const joinedStr = CH.from(Users).select(($) => ({
	s: CH.arrayStringConcat([$.Name, CH.param.string("sepPart"), $.Id], ","),
}))
expectTypeOf<InferQueryOutput<typeof joinedStr>>().toEqualTypeOf<{ readonly s: string }>()
// @ts-expect-error -- `sepPart` is missing
CH.compileUnsafe(joinedStr, {})
CH.compileUnsafe(joinedStr, { sepPart: "-" })
CH.compileUnsafe(CH.from(Users).select(($) => ({ s: CH.arrayStringConcat($.Tags, ",") })), {})
