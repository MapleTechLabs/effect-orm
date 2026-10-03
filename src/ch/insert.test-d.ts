// Type-level tests: the insert row type

import { Schema, type DateTime } from "effect"
import { expectTypeOf } from "expect-type"
import * as CH from "./index"
import * as PG from "../postgres"
import * as S from "../schema"
import type { RowOf } from "../database"

const Events = CH.table(
	"events",
	{ OrgId: CH.string, Id: CH.uint64, At: CH.dateTime, Note: CH.nullable(CH.string) },
	{ defaults: ["Id"] },
)

// Required: columns without a default that are not nullable. Optional: the
// declared defaults and the nullable columns.
expectTypeOf<keyof CH.InsertRowOf<typeof Events>>().toEqualTypeOf<"OrgId" | "Id" | "At" | "Note">()
CH.insertInto(Events).values({ OrgId: "o", At: new Date() })
CH.insertInto(Events).values({ OrgId: "o", At: "2026-01-01 00:00:00", Id: 1, Note: null })
CH.insertInto(Events).values([{ OrgId: CH.param.string("org"), At: CH.param.dateTime("at") }])

// @ts-expect-error At is required
CH.insertInto(Events).values({ OrgId: "o" })
// @ts-expect-error null only on a nullable column
CH.insertInto(Events).values({ OrgId: null, At: new Date() })
// @ts-expect-error a value of another type
CH.insertInto(Events).values({ OrgId: "o", At: new Date(), Id: "1" })
// @ts-expect-error not a column
CH.insertInto(Events).values({ OrgId: "o", At: new Date(), Nope: 1 })
// @ts-expect-error a param of another type
CH.insertInto(Events).values({ OrgId: CH.param.int("org"), At: new Date() })

// A nullable column takes a param of its non-null type.
CH.insertInto(Events).values({ OrgId: "o", At: new Date(), Note: CH.param.string("note") })

// A table without `defaults` makes every non-nullable column required.
const Plain = CH.table("plain", { A: CH.string, B: CH.uint32 })
// @ts-expect-error B is required
CH.insertInto(Plain).values({ A: "a" })

// A branded column takes its branded value and a plain-string param.
const OrgId = Schema.String.pipe(Schema.brand("OrgId"))
const Branded = CH.table("branded", { OrgId: CH.custom("String", OrgId) })
CH.insertInto(Branded).values({ OrgId: OrgId.make("o") })
CH.insertInto(Branded).values({ OrgId: CH.param.string("org") })

// defineTable: defaults are optional, computed columns are not in the row.
const Spans = S.defineTable("spans", {
	columns: {
		OrgId: CH.string,
		Duration: S.column(CH.uint64, { default: 0 }),
		Started: S.column(CH.dateTime, { defaultExpr: ($) => CH.rawExpr("now()", CH.dateTime) }),
		Day: S.column(CH.string, { materialized: "toString(toDate(Started))" }),
		Label: S.column(CH.string, { comment: "shown" }),
	},
	engine: S.engine.mergeTree(),
	orderBy: ["OrgId"],
})
expectTypeOf<CH.InsertRowOf<typeof Spans>>().toEqualTypeOf<{
	readonly OrgId: CH.InsertValue<CH.CHString>
	readonly Label: CH.InsertValue<CH.CHString>
	readonly Duration?: CH.InsertValue<CH.CHUInt64> | undefined
	readonly Started?: CH.InsertValue<CH.CHDateTime> | undefined
}>()
// @ts-expect-error Day is MATERIALIZED
CH.insertInto(Spans).values({ OrgId: "o", Label: "l", Day: "x" })
// A table with defaults still goes everywhere a table does.
CH.from(Spans).select("OrgId", "Day")
expectTypeOf(S.column(CH.string)).toEqualTypeOf<S.ColumnSpec<CH.CHString, never>>()

// A table typed without insert metadata reads as "no defaults, nothing computed".
declare const Loose: CH.Table<"loose", { A: CH.CHString; B: CH.CHNullable<CH.CHString> }>
expectTypeOf<CH.InsertRowOf<typeof Loose>>().toEqualTypeOf<{
	readonly A: CH.InsertValue<CH.CHString>
	readonly B?: CH.InsertValue<CH.CHNullable<CH.CHString>> | undefined
}>()

// Postgres columns.
const Keys = CH.table("api_keys", { id: PG.uuid, created_at: PG.timestamptz }, { defaults: ["created_at"] })
CH.insertInto(Keys).values({ id: "k" })
CH.insertInto(Keys).values({ id: "k", created_at: new Date() as unknown as DateTime.Utc })

// RETURNING: column names or a callback, as in select.
const returningNames = CH.insertInto(Keys).values({ id: "k" }).returning("id", "created_at")
expectTypeOf<RowOf<typeof returningNames>>().toEqualTypeOf<{ readonly id: string; readonly created_at: DateTime.Utc }>()
const returningExprs = CH.insertInto(Keys)
	.values({ id: "k" })
	.returning(($) => ({ key: $.id, n: CH.rawExpr("1", PG.int4) }))
expectTypeOf<RowOf<typeof returningExprs>>().toEqualTypeOf<{ readonly key: string; readonly n: number }>()
expectTypeOf(PG.compileUnsafe(returningExprs)).toEqualTypeOf<
	CH.CompiledQuery<{ readonly key: string; readonly n: number }, undefined>
>()
// @ts-expect-error not a column
CH.insertInto(Keys).values({ id: "k" }).returning("nope")

// An insert without RETURNING runs to no rows; compile gives a CompiledQuery.
const insert = CH.insertInto(Plain).values({ A: "a", B: 1 })
expectTypeOf<RowOf<typeof insert>>().toEqualTypeOf<never>()
expectTypeOf(CH.compileUnsafe(insert)).toEqualTypeOf<CH.CompiledQuery<never, undefined>>()
expectTypeOf(PG.compileUnsafe(insert, {})).toEqualTypeOf<CH.CompiledQuery<never, undefined>>()
// Queries still resolve to the query overload.
expectTypeOf(CH.compileUnsafe(CH.from(Plain).select("A"), {})).toEqualTypeOf<
	CH.CompiledQuery<{ readonly A: string }, undefined>
>()
