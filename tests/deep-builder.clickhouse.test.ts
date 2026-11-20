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

		// Every name used to be written bare: these were syntax errors, wrong
		// results (`ORDER BY null`), or SQL of the caller's making.
		it.effect("reads rows back under any select key, source alias and column name", () => Effect.gen(function* () {
			const source = CH.table("(SELECT arrayJoin([3, 1, 2, 2]) AS `user id`)", { external: true, columns: { "user id": CH.uint8 } })
			const names = [
				"a b", "p-95", "x FROM system.users --", "a`b", "back\\slash", "q'uote", "semi;colon", "new\nline", "__PARAM_string_org__",
				"null", "NULL", "true", "select", "distinct", "rollup", "inf", "from", "order", "ünï-cödé 🙂", "1st", "a.b-c", '"dq"',
			]
			for (const name of names) {
				for (const alias of [undefined, "my source"]) {
					const compiled = CH.compileUnsafe(
						CH.from(source, alias)
							.select(($) => ({ [name]: $["user id"], hits: CH.count() }))
							.groupBy(name)
							.orderBy([name, "desc"]),
						{},
					)
					expect((yield* execute(compiled)).rows, compiled.sql).toEqual([
						{ [name]: 3, hits: 1 },
						{ [name]: 2, hits: 2 },
						{ [name]: 1, hits: 1 },
					])
				}
			}
		}))

		// ClickHouse 26.2 turns a LEFT JOIN filtered by `LIKE '%%'` on the joined table into an inner
		// one and loses the unmatched row; an empty `contains` is written with one wildcard instead.
		it.effect("an empty contains on a LEFT JOIN's table keeps the unmatched rows", () => Effect.gen(function* () {
			const Orders = CH.table("orders", { external: true, columns: { id: CH.uint8, customer: CH.string } })
			const Customers = CH.table("customers", { external: true, columns: { name: CH.string } })
			const compiled = CH.compileUnsafe(
				CH.from(Orders)
					.leftJoin(Customers, "c", (o, c) => o.customer.eq(c.name))
					.select(($) => ({ id: $.id }))
					.where(($) => [$.c.name.contains("")])
					.orderBy(["id", "asc"])
					.withCTE("orders", "SELECT * FROM values('id UInt8, customer String', (1, 'acme'), (2, 'initech'))")
					.withCTE("customers", "SELECT * FROM values('name String', ('acme'))"),
				{},
			)
			expect((yield* execute(compiled)).rows, compiled.sql).toEqual([{ id: 1 }, { id: 2 }])
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
