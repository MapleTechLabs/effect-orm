// An enum column reads, writes and compares as its labels, through
// `PG.column`, `nullable` and `array`, and a `unique` column stays required.

import { expectTypeOf } from "expect-type"
import * as PG from "../postgres"
import * as S from "../schema"
import type { RowOf } from "../database"

const ChannelType = PG.enumType("channel_type", ["public", "private", "direct"])
type ChannelType = "public" | "private" | "direct"

expectTypeOf(ChannelType.values).toEqualTypeOf<ReadonlyArray<ChannelType>>()
expectTypeOf(ChannelType.name).toEqualTypeOf<"channel_type">()
expectTypeOf(ChannelType).toExtend<PG.PgType<"PgEnum", ChannelType, string>>()
expectTypeOf(ChannelType).toExtend<S.SchemaObject>()

const Channels = PG.table("channels", {
	columns: {
		id: PG.text,
		slug: PG.column(PG.text, { unique: true }),
		type: PG.column(ChannelType, { default: "public" }),
		previous: PG.nullable(ChannelType),
		allowed: PG.array(ChannelType),
	},
	primaryKey: ["id"],
	uniqueConstraints: [PG.unique("channels_id_slug_unique", ["id", "slug"])],
})

// Rows hold the labels.
expectTypeOf<PG.SelectRowOf<typeof Channels>>().toEqualTypeOf<{
	readonly id: string
	readonly slug: string
	readonly type: ChannelType
	readonly previous: ChannelType | null
	readonly allowed: ReadonlyArray<ChannelType>
}>()
const selected = PG.from(Channels).select("type", "allowed")
expectTypeOf<RowOf<typeof selected>>().toEqualTypeOf<{ readonly type: ChannelType; readonly allowed: ReadonlyArray<ChannelType> }>()

// Inserts: a default makes the column optional, `unique` does not; only labels are accepted.
expectTypeOf<PG.InsertRowOf<typeof Channels>>().toEqualTypeOf<{
	readonly id: PG.InsertValue<typeof PG.text>
	readonly slug: PG.InsertValue<typeof PG.text>
	readonly allowed: PG.InsertValue<PG.PgArray<typeof ChannelType>>
	readonly type?: PG.InsertValue<typeof ChannelType> | undefined
	readonly previous?: PG.InsertValue<PG.PgNullable<typeof ChannelType>> | undefined
}>()
expectTypeOf<"public">().toExtend<PG.InsertValue<typeof ChannelType>>()
expectTypeOf<"secret">().not.toExtend<PG.InsertValue<typeof ChannelType>>()
PG.insertInto(Channels).values({ id: "c", slug: "s", previous: null, allowed: ["public"] })
// @ts-expect-error not a label
PG.insertInto(Channels).values({ id: "c", slug: "s", type: "secret", previous: null, allowed: [] })
// @ts-expect-error nor in an array
PG.insertInto(Channels).values({ id: "c", slug: "s", previous: null, allowed: ["secret"] })
// @ts-expect-error `unique` does not make a column optional
PG.insertInto(Channels).values({ id: "c", previous: null, allowed: [] })
// @ts-expect-error a default must be a label
PG.column(ChannelType, { default: "secret" })

// Comparisons take labels, a column of the enum, or a param.
PG.from(Channels).select("id").where(($) => [$.type.eq("public"), $.type.in_("private", "direct"), $.previous.eq($.type), $.type.eq(PG.param.of(ChannelType, "t"))])
// @ts-expect-error not a label
PG.from(Channels).select("id").where(($) => [$.type.eq("secret")])
// @ts-expect-error nor in a list
PG.from(Channels).select("id").where(($) => [$.type.in_("public", "secret")])

// The conflict target is the constraint's columns, or its name.
PG.insertInto(Channels).values({ id: "c", slug: "s", previous: null, allowed: [] }).onConflictDoNothing({ target: ["slug"] })
PG.insertInto(Channels).values({ id: "c", slug: "s", previous: null, allowed: [] }).onConflictDoNothing({ target: { constraint: "channels_slug_unique" } })
// @ts-expect-error not a column
PG.insertInto(Channels).values({ id: "c", slug: "s", previous: null, allowed: [] }).onConflictDoNothing({ target: ["nope"] })
