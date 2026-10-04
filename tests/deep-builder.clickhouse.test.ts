import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, it } from "@effect/vitest"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import { endpoint, execute } from "./clickhouse-support"

it.layer(FetchHttpClient.layer)("builder identity regressions", (it) => {
	describe.skipIf(!endpoint)("live", () => {
		it.effect("SELECT aliases cannot replace the source tenant filter", () => Effect.gen(function* () {
			const events = CH.table("(SELECT arrayJoin(['a', 'b']) AS OrgId)", { external: true, columns: { OrgId: CH.string }, tenantColumn: "OrgId" })
			for (const alias of [undefined, "e"]) {
				const compiled = CH.compileUnsafe(CH.from(events, alias)
					.select(() => ({ OrgId: CH.lit("a"), total: CH.count() }))
					.where(($) => [$.OrgId.eq("a")]), {})
				expect(compiled.tenantScope).toBe("single-tenant")
				expect((yield* execute(compiled)).rows).toEqual([{ OrgId: "a", total: 1 }])
			}
		}))

		it.effect("preserves DateTime and map literals through FROM and JOIN sources", () => Effect.gen(function* () {
			const events = CH.table("(SELECT toDateTime('2026-01-02 00:00:00', 'UTC') AS ts, map('a', 'b') AS attrs)", {
				external: true,
				columns: {
				ts: CH.dateTime, attrs: CH.map(CH.string, CH.string),
			},
			})
			const inner = CH.from(events).select("ts", "attrs")
			const compiled = CH.compileUnsafe(CH.fromQuery(inner, "q")
				.innerJoinQuery(inner, "j", (q, j) => q.attrs.eq({ a: "b" }).and(j.attrs.eq({ a: "b" })))
				.select(() => ({ rows: CH.count() }))
				.where(($) => [$.ts.gte(new Date("2026-01-01T00:00:00Z"))]), {})
			expect((yield* execute(compiled)).rows).toEqual([{ rows: 1 }])
		}))

		it.effect("decodes arithmetic overflow as NaN", () => Effect.gen(function* () {
			const one = CH.table("system.one", { external: true, columns: {} })
			const compiled = CH.compileUnsafe(CH.from(one).select(() => ({
				added: CH.lit(1e308).add(1e308),
				subtracted: CH.lit(-1e308).sub(1e308),
				multiplied: CH.lit(1e308).mul(2),
			})), {})
			expect((yield* execute(compiled)).rows).toEqual([{ added: Number.NaN, subtracted: Number.NaN, multiplied: Number.NaN }])
		}))
	})
})
