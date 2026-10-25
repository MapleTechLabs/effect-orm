// Type-level tests: predicate facts narrow joined columns in the row type

import { expectTypeOf } from "expect-type"
import * as CH from "./index"
import type { InferQueryOutput } from "./query"

const Units = CH.table("units", { Id: CH.string, OrgId: CH.string, Name: CH.string })
const Locks = CH.table("locks", {
	Id: CH.string,
	UnitId: CH.string,
	Battery: CH.uint8,
	Serial: CH.nullable(CH.string),
})

const joined = CH.from(Units).leftJoin(Locks, "l", (u, l) => u.Id.eq(l.UnitId))

type Row<Q> = InferQueryOutput<Q>
type StillNullable = { readonly lockId: string | null }

// A LEFT JOIN makes the joined columns nullable

const plain = joined.select(($) => ({ lockId: $.l.Id, battery: $.l.Battery }))
expectTypeOf<Row<typeof plain>>().toEqualTypeOf<{
	readonly lockId: string | null
	readonly battery: number | null
}>()

// isNotNull() on a joined column narrows it for a later select

const notNull = joined
	.where(($) => [$.OrgId.eq("o1"), $.l.Id.isNotNull()])
	.select(($) => ({ lockId: $.l.Id, battery: $.l.Battery }))
expectTypeOf<Row<typeof notNull>>().toEqualTypeOf<{
	readonly lockId: string
	readonly battery: number | null
}>()

// eq() proves its column not NULL too: `NULL = x` is never true

const byEq = joined
	.where(($) => [$.l.Battery.eq(CH.param.int("battery"))])
	.select(($) => ({ lockId: $.l.Id, battery: $.l.Battery }))
expectTypeOf<Row<typeof byEq>>().toEqualTypeOf<{
	readonly lockId: string | null
	readonly battery: number
}>()

// A column declared Nullable loses both NULLs

const serial = joined.where(($) => [$.l.Serial.isNotNull()]).select(($) => ({ serial: $.l.Serial }))
expectTypeOf<Row<typeof serial>>().toEqualTypeOf<{ readonly serial: string }>()

// AND chains keep every fact: `.and`, `CH.and`, and a second `where`

const chained = joined
	.where(($) => [$.l.Id.isNotNull().and($.l.Battery.eq(1))])
	.select(($) => ({ lockId: $.l.Id, battery: $.l.Battery }))
expectTypeOf<Row<typeof chained>>().toEqualTypeOf<{ readonly lockId: string; readonly battery: number }>()

const andFn = joined
	.where(($) => [CH.and($.l.Id.isNotNull(), $.l.Battery.eq(1))])
	.select(($) => ({ lockId: $.l.Id, battery: $.l.Battery }))
expectTypeOf<Row<typeof andFn>>().toEqualTypeOf<{ readonly lockId: string; readonly battery: number }>()

const twoWheres = joined
	.where(($) => [$.l.Id.isNotNull()])
	.where(($) => [$.l.Battery.eq(1)])
	.select(($) => ({ lockId: $.l.Id, battery: $.l.Battery }))
expectTypeOf<Row<typeof twoWheres>>().toEqualTypeOf<{ readonly lockId: string; readonly battery: number }>()

// What proves nothing about every row keeps `| null`

const viaOr = joined
	.where(($) => [CH.or($.l.Id.isNotNull(), $.Name.eq("a"))])
	.select(($) => ({ lockId: $.l.Id }))
expectTypeOf<Row<typeof viaOr>>().toEqualTypeOf<StillNullable>()

const viaOrMethod = joined
	.where(($) => [$.l.Id.isNotNull().or($.Name.eq("a"))])
	.select(($) => ({ lockId: $.l.Id }))
expectTypeOf<Row<typeof viaOrMethod>>().toEqualTypeOf<StillNullable>()

const viaNot = joined.where(($) => [CH.not($.l.Id.isNull())]).select(($) => ({ lockId: $.l.Id }))
expectTypeOf<Row<typeof viaNot>>().toEqualTypeOf<StillNullable>()

declare const flag: boolean
const viaWhen = joined
	.where(($) => [CH.whenTrue(flag, () => $.l.Id.isNotNull())])
	.select(($) => ({ lockId: $.l.Id }))
expectTypeOf<Row<typeof viaWhen>>().toEqualTypeOf<StillNullable>()

const viaMaybe = joined
	.where(($) => [flag ? $.l.Id.isNotNull() : undefined])
	.select(($) => ({ lockId: $.l.Id }))
expectTypeOf<Row<typeof viaMaybe>>().toEqualTypeOf<StillNullable>()

declare const conditions: ReadonlyArray<CH.Condition>
const viaArray = joined.where(() => conditions).select(($) => ({ lockId: $.l.Id }))
expectTypeOf<Row<typeof viaArray>>().toEqualTypeOf<StillNullable>()

// The fact names its column: another column of the same join stays nullable

const otherColumn = joined.where(($) => [$.l.Battery.isNotNull()]).select(($) => ({ lockId: $.l.Id }))
expectTypeOf<Row<typeof otherColumn>>().toEqualTypeOf<StillNullable>()

// A select made before the where keeps `| null`: it cannot see the later fact

const selectFirst = joined.select(($) => ({ lockId: $.l.Id })).where(($) => [$.l.Id.isNotNull()])
expectTypeOf<Row<typeof selectFirst>>().toEqualTypeOf<StillNullable>()

// A FROM column proves nothing: the joined columns stay as they were

const fromOnly = joined.where(($) => [$.Id.isNotNull(), $.Name.eq("a")])
expectTypeOf(fromOnly).toEqualTypeOf<typeof joined>()

// leftJoinQuery: the subquery's columns narrow the same way

const perUnit = CH.from(Locks).select(($) => ({ unitId: $.UnitId, serial: $.Serial }))
const sub = CH.from(Units)
	.leftJoinQuery(perUnit, "p", (u, p) => u.Id.eq(p.unitId))
	.where(($) => [$.p.unitId.isNotNull(), $.p.serial.isNotNull()])
	.select(($) => ({ unitId: $.p.unitId, serial: $.p.serial }))
expectTypeOf<Row<typeof sub>>().toEqualTypeOf<{ readonly unitId: string; readonly serial: string }>()

// The compiled query carries the narrowed row

expectTypeOf(CH.compileUnsafe(notNull, {})).toEqualTypeOf<CH.CompiledQuery<Row<typeof notNull>, undefined>>()
