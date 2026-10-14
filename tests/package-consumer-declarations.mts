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
