// Copied into an isolated directory by check-package.ts and compiled with
// `declaration: true`. A library that defines its tables and queries in one
// package and runs them from another exports them, and tsc must then be able to
// name every type they carry through the public entry points. Each export below
// once failed with TS4023 or TS2742, pointing into a hashed internal chunk.
import type { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as PG from "@maple-dev/effect-orm/postgres"

export const Events = CH.table("events", { external: true, columns: { appId: CH.uint32, name: CH.string } })

// A query with a param: its type carries `ParamEntry`.
export const eventsByApp = CH.from(Events)
	.select(($) => ({ name: $.name }))
	.where(($) => [$.appId.eq(CH.param.int("appId"))])

// A custom function: its type carries `ParamsIn`.
export const toStartOfDay = CH.defineFn<[CH.Expr<DateTime.Utc>], DateTime.Utc>("toStartOfDay", CH.dateTime)

export const Accounts = PG.table("accounts", { columns: { id: PG.int4, org: PG.text }, primaryKey: ["id"] })
export const accountsByOrg = PG.from(Accounts)
	.select(($) => ({ id: $.id }))
	.where(($) => [$.org.eq(PG.param.string("org"))])

// An optional filter (`when`, `whenTrue`) and a param named by a union carry
// `OptionalParamEntry` / `OptionalParams`.
export const eventsMaybeByName = (name: string | undefined) =>
	CH.from(Events)
		.select(($) => ({ appId: $.appId }))
		.where(($) => [CH.when(name, () => $.name.eq(CH.param.string("name")))])
export const eventsByAppOptional = CH.from(Events)
	.select(($) => ({ name: $.name }))
	.where(($) => [CH.whenTrue(true, () => $.appId.eq(CH.param.int("appId")))])

export const byUnionNamedParam = (byApp: boolean) =>
	CH.from(Events)
		.select(($) => ({ name: $.name }))
		.where(($) => [$.appId.eq(CH.param.int(byApp ? "appId" : "fallbackAppId"))])

// Joins, CTEs, subqueries and unions over parameterized queries.
export const Sessions = CH.table("sessions", { external: true, columns: { appId: CH.uint32, id: CH.string } })
export const joined = CH.from(Events)
	.innerJoin(Sessions, "s", (e, s) => e.appId.eq(s.appId))
	.select(($) => ({ name: $.name }))
	.where(($) => [$.appId.eq(CH.param.int("appId"))])
export const Recent = CH.table("recent", { external: true, columns: { name: CH.string } })
export const withRecent = CH.from(Recent).withCTE("recent", eventsByApp).select(($) => ({ name: $.name }))
export const fromSub = CH.fromQuery(eventsByApp, "sub").select(($) => ({ name: $.name }))
export const both = CH.unionAll(eventsByApp, CH.from(Events).select(($) => ({ name: $.name })))
