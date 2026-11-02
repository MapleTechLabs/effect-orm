// Type-level tests: the pipeable, data-last query API types its callbacks and
// its result as the fluent builder does.

import { expectTypeOf } from "expect-type"
import { pipe } from "effect"
import * as CH from "./index"
import type { InferQueryOutput } from "./query"

const Tours = CH.table("tours", { OrgId: CH.string, Id: CH.string, StartsAt: CH.dateTime64, Notes: CH.nullable(CH.string) })
const Units = CH.table("units", { Id: CH.string, TourId: CH.string, Name: CH.string })

const { Query } = CH

// The issue's example: `$` is typed from the query `pipe` carries.
const piped = Query.from(Tours).pipe(
	Query.select(($) => ({ id: $.Id, at: $.StartsAt })),
	Query.where(($) => [$.OrgId.eq(CH.param.string("orgId"))]),
	Query.orderBy(["at", "asc"]),
	Query.limit(10),
)
const fluent = CH.from(Tours)
	.select(($) => ({ id: $.Id, at: $.StartsAt }))
	.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
	.orderBy(["at", "asc"])
	.limit(10)
expectTypeOf(piped).toEqualTypeOf(fluent)
expectTypeOf<InferQueryOutput<typeof piped>>().toEqualTypeOf<{ readonly id: string; readonly at: InferQueryOutput<typeof fluent>["at"] }>()

// The param a data-last `where` adds is a param of the query.
// @ts-expect-error -- `orgId` is missing
CH.compileUnsafe(piped, {})
CH.compileUnsafe(piped, { orgId: "org_1" })

// Data-first gives the same type.
expectTypeOf(Query.where(CH.from(Tours).select("Id"), ($) => [$.OrgId.eq("o")])).toEqualTypeOf(
	CH.from(Tours)
		.select("Id")
		.where(($) => [$.OrgId.eq("o")]),
)

// A reusable part is a plain function. Its `$` is typed from the table it names,
// and the query keeps every column, so a later step can read any of them.
const byOrg = (orgId: string) => Query.where(($: CH.ColumnAccessor<typeof Tours.columns>) => [$.OrgId.eq(orgId)])
const reused = Query.from(Tours).pipe(byOrg("org_1"), Query.select("Id", "StartsAt"))
const reusedFluent = CH.from(Tours)
	.where(($) => [$.OrgId.eq("org_1")])
	.select("Id", "StartsAt")
export const reusedIsFluent: typeof reusedFluent = reused
export const fluentIsReused: typeof reused = reusedFluent

// `pipe` from effect works too.
expectTypeOf(pipe(CH.from(Tours), Query.select("Id", "Notes"))).toEqualTypeOf(CH.from(Tours).select("Id", "Notes"))
expectTypeOf(pipe(CH.from(Tours), Query.select())).toEqualTypeOf(CH.from(Tours).select())

// An unknown column in a data-last callback is a type error.
CH.from(Tours).pipe(
	// @ts-expect-error -- `Nope` is not a column of `tours`
	Query.where(($) => [$.Nope.eq("x")]),
)
// @ts-expect-error -- `Nope` is not a column of `tours`
CH.from(Tours).pipe(Query.select("Nope"))

// orderBy by a key the query does not select is a type error.
CH.from(Tours).pipe(
	Query.select("Id"),
	// @ts-expect-error -- `at` is not selected
	Query.orderBy(["at", "asc"]),
)
// @ts-expect-error -- `asc` or `desc` only
CH.from(Tours).select("Id").pipe(Query.orderBy(["Id", "up"]))
// @ts-expect-error -- a negative limit
CH.from(Tours).select("Id").pipe(Query.limit(-1))

// Joins: `$.<alias>` reads the joined table; leftJoin makes it nullable.
const joined = CH.from(Tours).pipe(
	Query.innerJoin(Units, "u", (t, u) => t.Id.eq(u.TourId)),
	Query.select(($) => ({ id: $.Id, unit: $.u.Name })),
)
expectTypeOf(joined).toEqualTypeOf(
	CH.from(Tours)
		.innerJoin(Units, "u", (t, u) => t.Id.eq(u.TourId))
		.select(($) => ({ id: $.Id, unit: $.u.Name })),
)
const left = CH.from(Tours).pipe(
	Query.leftJoin(Units, "u", (t, u) => t.Id.eq(u.TourId)),
	Query.select(($) => ({ unit: $.u.Name })),
)
expectTypeOf<InferQueryOutput<typeof left>>().toEqualTypeOf<{ readonly unit: string | null }>()
const crossed = CH.from(Tours).pipe(Query.crossJoin(Units, "u"), Query.select(($) => ({ unit: $.u.Name })))
expectTypeOf<InferQueryOutput<typeof crossed>>().toEqualTypeOf<{ readonly unit: string }>()

CH.from(Tours).pipe(
	Query.innerJoin(Units, "u", (t, u) => t.Id.eq(u.TourId)),
	// @ts-expect-error -- the alias `u` is in use
	Query.innerJoin(Units, "u", (t, u) => t.Id.eq(u.TourId)),
)

// The rest of the builder: each data-last form gives the fluent type.
const ids = CH.from(Tours).select(($) => ({ id: $.Id, at: $.StartsAt }))
expectTypeOf(ids.pipe(Query.groupBy("id"), Query.having(($) => [$.OrgId.eq(CH.param.string("orgId"))]))).toEqualTypeOf(
	ids.groupBy("id").having(($) => [$.OrgId.eq(CH.param.string("orgId"))]),
)
expectTypeOf(ids.pipe(Query.offset(5), Query.distinct(), Query.format("JSON"))).toEqualTypeOf(ids.offset(5).distinct().format("JSON"))
expectTypeOf(ids.pipe(Query.distinctOn("id"), Query.crossTenant())).toEqualTypeOf(ids.distinctOn("id").crossTenant())
expectTypeOf(ids.pipe(Query.forUpdate(), Query.forShare({ skipLocked: true }))).toEqualTypeOf(ids.forUpdate().forShare({ skipLocked: true }))
expectTypeOf(Query.forKeyShare(ids)).toEqualTypeOf(ids.forKeyShare())
expectTypeOf(ids.pipe(Query.route("replica"))).toEqualTypeOf(ids.route("replica"))
// @ts-expect-error -- `nope` is not selected
ids.pipe(Query.groupBy("nope"))
// @ts-expect-error -- `nope` is not selected
ids.pipe(Query.distinctOn("nope"))
// @ts-expect-error -- a negative offset
ids.pipe(Query.offset(-1))

// Subquery joins and CTEs carry the inner query's params.
const units = CH.from(Units)
	.select(($) => ({ tour: $.TourId, name: $.Name }))
	.where(($) => [$.Name.eq(CH.param.string("unit"))])
const viaUnits = CH.from(Tours).pipe(
	Query.leftJoinQuery(units, "u", (t, u) => t.Id.eq(u.tour)),
	Query.select(($) => ({ id: $.Id, unit: $.u.name })),
)
expectTypeOf<InferQueryOutput<typeof viaUnits>>().toEqualTypeOf<{ readonly id: string; readonly unit: string | null }>()
// @ts-expect-error -- `unit` is missing
CH.compileUnsafe(viaUnits, {})
expectTypeOf(CH.from(Tours).pipe(Query.innerJoinQuery(units, "u", (t, u) => t.Id.eq(u.tour)))).toEqualTypeOf(
	CH.from(Tours).innerJoinQuery(units, "u", (t, u) => t.Id.eq(u.tour)),
)
expectTypeOf(CH.from(Tours).pipe(Query.crossJoinQuery(units, "u"))).toEqualTypeOf(CH.from(Tours).crossJoinQuery(units, "u"))
expectTypeOf(ids.pipe(Query.withCTE("u", units))).toEqualTypeOf(ids.withCTE("u", units))
expectTypeOf(ids.pipe(Query.withCTE("one", "SELECT 1"))).toEqualTypeOf(ids.withCTE("one", "SELECT 1"))
CH.from(Tours).pipe(
	// @ts-expect-error -- the subquery selects no `nope`
	Query.innerJoinQuery(units, "u", (t, u) => t.Id.eq(u.nope)),
)
