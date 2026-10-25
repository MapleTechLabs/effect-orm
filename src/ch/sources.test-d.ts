// Type-level tests: a column of a source that is not in the query's FROM or
// JOIN is a type error where the query is compiled or run.

import { expectTypeOf } from "expect-type"
import * as CH from "./index"
import * as Db from "../database"
import type { SourceEntry, SourcesSatisfied } from "./expr"

const Events = CH.table("events", { Id: CH.string, Name: CH.string, OrgId: CH.string })
const Services = CH.table("services", { Id: CH.string, Name: CH.string, Team: CH.string })

// A column ref names its source; a query discharges its own sources.
CH.from(Events).select(($) => {
	expectTypeOf($.Name.eq("a")).toEqualTypeOf<CH.Condition<SourceEntry<"events">>>()
	return { name: $.Name }
})
CH.from(Events, "e").select(($) => {
	expectTypeOf($.Name.eq("a")).toEqualTypeOf<CH.Condition<SourceEntry<"e">>>()
	return { name: $.Name }
})
const own = CH.from(Events, "e")
	.innerJoin(Services, "s", (e, s) => e.Name.eq(s.Name))
	.select(($) => ({ name: $.Name, team: $.s.Team }))
	.where(($) => [$.OrgId.eq("o"), $.s.Id.eq("x")])
	.orderBy(($) => [[$.s.Team, "asc"]])
expectTypeOf(own).toExtend<CH.CHQuery<any, any, any, any, never>>()
CH.compileUnsafe(own)

// A column captured from another query's accessor is not in this one.
let servicesRef!: CH.JoinedColumnAccessor<(typeof Services)["columns"], {}, "s">
CH.from(Services, "s").select(($) => {
	servicesRef = $
	return { id: $.Id }
})
const leaked = CH.from(Events).select("Id").where(() => [servicesRef.Team.eq("core")])
// @ts-expect-error -- `s` is not in FROM or JOIN
CH.compileUnsafe(leaked)
// @ts-expect-error -- `s` is not in FROM or JOIN
void CH.compile(leaked)
// @ts-expect-error -- `s` is not in FROM or JOIN
void Db.run(leaked)
const inSelect = CH.from(Events).select(() => ({ team: servicesRef.Team }))
// @ts-expect-error -- `s` is not in FROM or JOIN
CH.compileUnsafe(inSelect)

// The message names the source.
expectTypeOf<SourcesSatisfied<SourceEntry<"s">>>().toEqualTypeOf<{
	readonly sourceNotInQuery: "a column of `s` is used, but no FROM or JOIN of the query is named `s`"
}>()
expectTypeOf<SourcesSatisfied<never>>().toEqualTypeOf<unknown>()
// A source whose name is not known in the type is not checked.
expectTypeOf<SourcesSatisfied<SourceEntry<string>>>().toEqualTypeOf<unknown>()

// A later JOIN of that name provides it.
const joinedLater = CH.from(Events)
	.select("Id")
	.where(() => [servicesRef.Team.eq("core")])
	.innerJoin(Services, "s", (e, s) => e.Name.eq(s.Name))
CH.compileUnsafe(joinedLater)

// A correlated subquery: the inner query may read the outer source, and the
// outer query provides it.
let outer!: CH.JoinedColumnAccessor<(typeof Services)["columns"], {}, "s">
const inner = CH.from(Events)
	.select(($) => ({ n: $.Name }))
	.where(($) => [$.OrgId.eq("o"), $.Name.eq(outer.Name)])
// @ts-expect-error -- alone, the inner query reads `s` it does not have
CH.compileUnsafe(inner)
const correlated = CH.from(Services, "s")
	.select(($) => ({ team: $.Team }))
	.where(() => [CH.exists(inner)])
CH.compileUnsafe(correlated)
// The same inner query under an outer query of another name is refused.
const wrongOuter = CH.from(Services, "svc")
	.select(($) => ({ team: $.Team }))
	.where(() => [CH.exists(inner)])
// @ts-expect-error -- `s` is not in FROM or JOIN
CH.compileUnsafe(wrongOuter)

// Through every way a query nests: FROM, JOIN, CTE and UNION.
// @ts-expect-error -- `s` is not in FROM or JOIN
CH.compileUnsafe(CH.fromQuery(leaked, "sub").select(($) => ({ id: $.Id })))
// @ts-expect-error -- `s` is not in FROM or JOIN
CH.compileUnsafe(CH.from(Events).innerJoinQuery(leaked, "l", (e, l) => e.Id.eq(l.Id)).select("Id"))
// @ts-expect-error -- `s` is not in FROM or JOIN
CH.compileUnsafe(CH.from(Events).withCTE("x", leaked).select("Id"))
// @ts-expect-error -- `s` is not in FROM or JOIN
CH.compileUnionUnsafe(CH.unionAll(leaked, CH.from(Events).select("Id")))

// A subquery's own sources stay its own: they do not leak to the outer query.
const scalar = CH.from(Services).select(($) => ({ n: $.Name })).where(($) => [$.Team.eq("core")])
CH.compileUnsafe(CH.from(Events).select("Id").where(($) => [CH.inSubquery($.Name, scalar)]))
CH.compileUnsafe(CH.fromQuery(scalar, "sub").select(($) => ({ n: $.n })))
CH.compileUnionUnsafe(CH.unionAll(scalar, CH.from(Events).select(($) => ({ n: $.Name }))))
