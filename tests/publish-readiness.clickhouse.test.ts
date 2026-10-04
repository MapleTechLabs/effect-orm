import { DateTime, Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, it } from "@effect/vitest"
import * as CH from "@maple-dev/effect-orm/clickhouse"

import { endpoint, execute } from "./clickhouse-support"

const One = CH.table("system.one", { external: true, columns: {} })

it.layer(FetchHttpClient.layer)("publishing regressions against ClickHouse", (it) => {
	describe.skipIf(!endpoint)("live", () => {
		it.effect("classifies scalar counts across tenants and preserves same-tenant counts", () =>
			Effect.gen(function* () {
				const events = CH.table("(SELECT arrayJoin(['a', 'b']) AS OrgId)", { external: true, columns: { OrgId: CH.string }, tenantColumn: "OrgId" })
				const all = CH.from(events).select(() => ({ total: CH.count() }))
				const own = all.where(($) => [$.OrgId.eq("a")])
				for (const [inner, expectedScope, total] of [
					[all, "cross-tenant", 2],
					[own, "single-tenant", 1],
				] as const) {
					const compiled = CH.compileUnsafe(
						CH.from(events).select(($) => ({
							org: $.OrgId,
							total: CH.subqueryExpr(inner, CH.uint64),
						})).where(($) => [$.OrgId.eq("a")]),
						{},
					)
					expect(compiled.tenantScope).toBe(expectedScope)
					expect((yield* execute(compiled)).rows).toEqual([{ org: "a", total }])
				}
			}),
		)

		it.effect("decodes arrays with nullable elements in either order", () =>
			Effect.gen(function* () {
				const compiled = CH.compileUnsafe(CH.from(One).select(() => ({
					lastNull: CH.arrayOf(CH.lit(1), CH.nullIf(CH.lit(2), 2)),
					firstNull: CH.arrayOf(CH.nullIf(CH.lit(2), 2), CH.lit(1)),
				})), {})
				const { rows } = yield* execute(compiled)
				expect(rows).toEqual([{ lastNull: [1, null], firstNull: [null, 1] }])
				expect(yield* compiled.encodeRows(rows)).toEqual(rows)
			}),
		)

		it.effect("labels a join that exposes another tenant as cross-tenant", () =>
			Effect.gen(function* () {
				const a = CH.table("a", { external: true, columns: { OrgId: CH.string, Id: CH.uint8 }, tenantColumn: "OrgId" })
				const b = CH.table("b", { external: true, columns: { ...a.columns, Secret: CH.string }, tenantColumn: "OrgId" })
				const compiled = CH.compileUnsafe(
					CH.from(a, "a")
						.innerJoin(b, "b", (a, b) => a.Id.eq(b.Id))
						.select(($) => ({ secret: $.b.Secret }))
						.where(($) => [$.OrgId.eq("org_a")])
						.withCTE("a", "SELECT 'org_a' AS OrgId, toUInt8(1) AS Id")
						.withCTE("b", "SELECT 'org_b' AS OrgId, toUInt8(1) AS Id, 'other tenant' AS Secret"),
					{},
				)
				expect(compiled.tenantScope).toBe("cross-tenant")
				expect((yield* execute(compiled)).rows).toEqual([{ secret: "other tenant" }])
			}),
		)

		it.effect("keeps union values under the matching alias", () =>
			Effect.gen(function* () {
				const a = CH.from(One).select(() => ({ first: CH.lit("a"), last: CH.lit("b") }))
				const b = CH.from(One).select(() => ({ last: CH.lit("d"), first: CH.lit("c") }))
				const compiled = CH.compileUnionUnsafe(CH.unionAll(a, b).orderBy(["first", "asc"]), {})
				expect((yield* execute(compiled)).rows).toEqual([
					{ first: "a", last: "b" },
					{ first: "c", last: "d" },
				])
			}),
		)

		it.effect("decodes nullable union branches through fromUnion", () =>
			Effect.gen(function* () {
				const union = CH.unionAll(
					CH.from(One).select(() => ({ value: CH.lit("ok") })),
					CH.from(One).select(() => ({
						value: CH.rawExpr("CAST(NULL AS Nullable(String))", CH.nullable(CH.string)),
					})),
				)
				const compiled = CH.compileUnsafe(CH.fromUnion(union, "u").select("value"), {})
				expect((yield* execute(compiled)).rows).toEqual(
					expect.arrayContaining([{ value: "ok" }, { value: null }]),
				)
			}),
		)

		for (const join_use_nulls of ["0", "1"]) {
			it.effect(`decodes unmatched LEFT JOINs with join_use_nulls=${join_use_nulls}`, () =>
				Effect.gen(function* () {
					const a = CH.from(One).select(() => ({ id: CH.lit(1) }))
					const b = CH.from(One).select(() => ({ id: CH.lit(2), name: CH.lit("found") }))
					const derived = CH.fromQuery(a, "a")
						.leftJoinQuery(b, "b", (a, b) => a.id.eq(b.id))
						.select(($) => ({ name: $.b.name }))
					const A = CH.table("a", { external: true, columns: { id: CH.uint8 } })
					const B = CH.table("b", { external: true, columns: { id: CH.uint8, name: CH.string } })
					const direct = CH.from(A)
						.leftJoin(B, "b", (a, b) => a.id.eq(b.id))
						.select(($) => ({ name: $.b.name }))
						.withCTE("a", "SELECT toUInt8(1) AS id")
						.withCTE("b", "SELECT toUInt8(2) AS id, 'found' AS name")
					for (const compiled of [CH.compileUnsafe(derived, {}), CH.compileUnsafe(direct, {})]) {
						expect((yield* execute(compiled, { join_use_nulls })).rows).toEqual([
							{ name: join_use_nulls === "1" ? null : "" },
						])
					}
				}),
			)
		}

		it.effect("decodes empty aggregates and guards both NaN and NULL", () =>
			Effect.gen(function* () {
				const empty = CH.from(One)
					.select(() => ({
						avg: CH.avg(CH.lit(1)),
						avgIf: CH.avgIf(CH.lit(1), CH.lit(1).eq(0)),
						quantile: CH.quantile(0.95)(CH.lit(1)),
					}))
					.where(() => [CH.lit(1).eq(0)])
				expect((yield* execute(CH.compileUnsafe(empty, {}))).rows).toEqual([
					{ avg: null, avgIf: null, quantile: null },
				])
				const query = CH.from(One).select(() => ({
					division: CH.lit(1).div(0),
					literalDivisor: CH.lit(3).div(1000000),
					nullIf: CH.nullIf(CH.lit(""), ""),
					arithmetic: CH.nullIf(CH.lit(1), 1).add(2).mul(3),
					conditional: CH.if_(CH.lit(1).eq(0), CH.lit(1), CH.nullIf(CH.lit(1), 1)),
					guarded: CH.ifNull(CH.ifNotFinite(CH.lit(1).div(0), 0), CH.lit(0)),
					guardedNull: CH.ifNull(CH.ifNotFinite(CH.nullIf(CH.lit(1), 1), 0), CH.lit(0)),
				}))
				expect((yield* execute(CH.compileUnsafe(query, {}))).rows).toEqual([
					{
						division: null,
						literalDivisor: 0.000003,
						nullIf: null,
						arithmetic: null,
						conditional: null,
						guarded: 0,
						guardedNull: 0,
					},
				])
			}),
		)

		it.effect("decodes toDateTime by its result flavour, including parameters", () =>
			Effect.gen(function* () {
				const compiled = CH.compileUnsafe(
					CH.from(One).select(() => ({
						epoch: CH.toDateTime(CH.lit(1700000000)),
						text: CH.toDateTime(CH.param.dateTimeString("time")),
					})),
					{ time: "2023-11-14 22:13:20" },
				)
				const { rows } = yield* execute(compiled, { session_timezone: "UTC" })
				expect(DateTime.toEpochMillis(rows[0]!.epoch)).toBe(1700000000000)
				expect(rows[0]!.text).toBe("2023-11-14 22:13:20")
			}),
		)

		it.effect("preserves DateTime64 bounds and round trips milliseconds", () =>
			Effect.gen(function* () {
				const ticks = CH.table("ticks", { external: true, columns: { ts: CH.dateTime64 } })
				const instant = DateTime.makeUnsafe("2026-09-07T00:00:00.789Z")
				const base = CH.from(ticks).withCTE(
					"ticks",
					"SELECT toDateTime64('2026-09-07 00:00:00.500', 3, 'UTC') AS ts",
				)
				for (const bound of [
					instant,
					new Date("2026-09-07T00:00:00.789Z"),
					CH.param.dateTime("start"),
					CH.param.of(CH.dateTime64, "start"),
				]) {
					const compiled = CH.compileUnsafe(
						base.select(() => ({ count: CH.count() })).where(($) => [$.ts.gte(bound)]),
						{ start: instant },
					)
					expect((yield* execute(compiled)).rows).toEqual([{ count: 0 }])
				}
				const compiled = CH.compileUnsafe(base.select("ts"), {})
				const { wire, rows } = yield* execute(compiled)
				expect(yield* compiled.encodeRows(rows)).toEqual(wire)
			}),
		)
	})
})
