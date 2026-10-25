import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import * as CH from "./index"
import * as PG from "../postgres"

const Units = CH.table("units", { Id: CH.string, Name: CH.string })
const Locks = CH.table("locks", { Id: CH.string, UnitId: CH.string, Battery: CH.uint8, Serial: CH.nullable(CH.string) })
const joined = CH.from(Units).leftJoin(Locks, "l", (u, l) => u.Id.eq(l.UnitId))

const decodes = (compiled: { decodeRows: (rows: ReadonlyArray<Record<string, unknown>>) => Effect.Effect<unknown, unknown> }, row: Record<string, unknown>) =>
	Exit.isSuccess(Effect.runSyncExit(compiled.decodeRows([row])))

describe("predicate facts narrow the row schema", () => {
	it("decodes a LEFT JOIN column as nullable without a fact", () => {
		const compiled = CH.compileUnsafe(joined.select(($) => ({ lockId: $.l.Id })), {})
		expect(decodes(compiled, { lockId: null })).toBe(true)
	})

	it("refuses NULL for a column isNotNull() proves present", () => {
		const compiled = CH.compileUnsafe(
			joined.where(($) => [$.l.Id.isNotNull()]).select(($) => ({ lockId: $.l.Id, battery: $.l.Battery })),
			{},
		)
		expect(decodes(compiled, { lockId: "k1", battery: null })).toBe(true)
		expect(decodes(compiled, { lockId: null, battery: null })).toBe(false)
		expect(compiled.sql).toContain("l.Id IS NOT NULL")
	})

	it("narrows on eq() and on AND chains", () => {
		const compiled = CH.compileUnsafe(
			joined
				.where(($) => [CH.and($.l.Battery.eq(CH.param.int("b")), $.l.Id.isNotNull().and($.l.UnitId.eq($.Id)))])
				.select(($) => ({ lockId: $.l.Id, battery: $.l.Battery, unitId: $.l.UnitId })),
			{ b: 3 },
		)
		expect(decodes(compiled, { lockId: "k1", battery: 3, unitId: "u1" })).toBe(true)
		for (const key of ["lockId", "battery", "unitId"]) {
			expect(decodes(compiled, { lockId: "k1", battery: 3, unitId: "u1", [key]: null })).toBe(false)
		}
	})

	it("strips the column's own NULL as well as the join's", () => {
		const compiled = CH.compileUnsafe(joined.where(($) => [$.l.Serial.isNotNull()]).select(($) => ({ serial: $.l.Serial })), {})
		expect(decodes(compiled, { serial: "s" })).toBe(true)
		expect(decodes(compiled, { serial: null })).toBe(false)
	})

	it("keeps NULL where the type keeps it: OR, NOT, and a select before the where", () => {
		const or = CH.compileUnsafe(
			joined.where(($) => [CH.or($.l.Id.isNotNull(), $.Name.eq("a"))]).select(($) => ({ lockId: $.l.Id })),
			{},
		)
		const orMethod = CH.compileUnsafe(
			joined.where(($) => [$.l.Id.isNotNull().or($.Name.eq("a"))]).select(($) => ({ lockId: $.l.Id })),
			{},
		)
		const not = CH.compileUnsafe(joined.where(($) => [CH.not($.l.Id.isNull())]).select(($) => ({ lockId: $.l.Id })), {})
		const selectFirst = CH.compileUnsafe(
			joined.select(($) => ({ lockId: $.l.Id })).where(($) => [$.l.Id.isNotNull()]),
			{},
		)
		for (const compiled of [or, orMethod, not, selectFirst]) expect(decodes(compiled, { lockId: null })).toBe(true)
		expect(selectFirst.sql).toContain("l.Id IS NOT NULL")
	})

	it("narrows a leftJoinQuery column, and a FROM subquery over the narrowed query", () => {
		const perUnit = CH.from(Locks).select(($) => ({ unitId: $.UnitId, serial: $.Serial }))
		const narrowed = CH.from(Units)
			.leftJoinQuery(perUnit, "p", (u, p) => u.Id.eq(p.unitId))
			.where(($) => [$.p.serial.isNotNull()])
			.select(($) => ({ unitId: $.p.unitId, serial: $.p.serial }))
		expect(decodes(CH.compileUnsafe(narrowed, {}), { unitId: null, serial: "s" })).toBe(true)
		expect(decodes(CH.compileUnsafe(narrowed, {}), { unitId: null, serial: null })).toBe(false)

		const outer = CH.fromQuery(narrowed, "n").select(($) => ({ serial: $.serial }))
		expect(decodes(CH.compileUnsafe(outer, {}), { serial: null })).toBe(false)
	})

	it("narrows the same way on Postgres", () => {
		const Members = CH.table("members", { id: PG.int4, orgId: PG.text, leftAt: PG.nullable(PG.timestamptz) })
		const compiled = PG.compileUnsafe(
			CH.from(Units)
				.leftJoin(Members, "m", (u, m) => u.Id.eq(m.orgId))
				.where(($) => [$.m.leftAt.isNotNull()])
				.select(($) => ({ leftAt: $.m.leftAt, id: $.m.id })),
			{},
		)
		expect(decodes(compiled, { leftAt: "2026-01-01T00:00:00Z", id: null })).toBe(true)
		expect(decodes(compiled, { leftAt: null, id: 1 })).toBe(false)
	})
})
