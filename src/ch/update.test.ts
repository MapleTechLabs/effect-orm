import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import * as CH from "./index"
import * as PG from "../postgres"
import { QueryBuilderDefect, QueryBuilderError } from "./errors"

const Counters = CH.table(
	"counters",
	{ org: PG.text, key: PG.text, count: PG.int8, meta: PG.jsonb(), search: PG.text },
	{ tenantColumn: "org", computed: ["search"] },
)
const Spans = CH.table("spans", { OrgId: CH.string, Name: CH.string, Ms: CH.uint64 }, { tenantColumn: "OrgId" })

const failure = (exit: Exit.Exit<unknown, unknown>) =>
	Exit.isFailure(exit) ? exit.cause.reasons.map((r) => ("error" in r ? r.error : "defect" in r ? r.defect : r))[0] : undefined

describe("update", () => {
	it("writes UPDATE ... SET ... WHERE ... RETURNING on Postgres, values bound", () => {
		const compiled = PG.compileUnsafe(
			CH.update(Counters)
				.set(($) => ({ count: $.count.add(1), meta: { a: 1 } }))
				.where(($) => [$.org.eq(CH.param.string("org")), $.key.eq("k")])
				.returning("count"),
			{ org: "o" },
		)
		expect(compiled.sql).toBe(
			'UPDATE "counters" SET "count" = "count" + 1, "meta" = $1\nWHERE "org" = $2\n  AND "key" = $3\nRETURNING "count" AS "count"',
		)
		expect(compiled.parameters).toEqual(['{"a":1}', "o", "k"])
		expect(compiled.kind).toBe("update")
		expect(compiled.returning).toEqual(["count"])
		expect(compiled.tenantScope).toBe("single-tenant")
	})

	it("writes an ALTER TABLE ... UPDATE mutation on ClickHouse, with settings last", () => {
		const compiled = CH.compileUnsafe(
			CH.update(Spans)
				.set({ Name: "x" })
				.where(($) => [$.OrgId.eq("o")])
				.settings({ mutations_sync: 2 }),
		)
		expect(compiled.sql).toBe("ALTER TABLE spans UPDATE Name = 'x'\nWHERE OrgId = 'o' SETTINGS mutations_sync = 2")
		expect(CH.compileUnsafe(CH.update(Spans).set({ Ms: 0 }).allRows()).sql).toBe("ALTER TABLE spans UPDATE Ms = 0\nWHERE 1")
	})

	it("allRows() writes no WHERE on Postgres and makes the write cross-tenant", () => {
		const compiled = PG.compileUnsafe(CH.update(Counters).set({ count: 0 }).allRows())
		expect(compiled.sql).toBe('UPDATE "counters" SET "count" = $1')
		expect(compiled.tenantScope).toBe("cross-tenant")
	})

	it("an update that moves rows to another tenant is cross-tenant", () => {
		const scope = (org: string) =>
			PG.compileUnsafe(CH.update(Counters).set({ org }).where(($) => [$.org.eq("o")])).tenantScope
		expect(scope("o")).toBe("single-tenant")
		expect(scope("p")).toBe("cross-tenant")
	})

	it.effect("refuses writes over every row unless asked, and bad SETs", () =>
		Effect.gen(function* () {
			const noWhere = yield* Effect.exit(PG.compile(CH.update(Counters).set({ count: 0 }) as unknown as CH.CHUpdate))
			expect(failure(noWhere)).toBeInstanceOf(QueryBuilderDefect)
			// Optional predicates that all came out undefined are data, so a failure.
			const allUndefined = yield* Effect.flip(
				PG.compile(CH.update(Counters).set({ count: 0 }).where(($) => [CH.when(undefined, (v: string) => $.key.eq(v))])),
			)
			expect(allUndefined).toBeInstanceOf(QueryBuilderError)
			expect(allUndefined.message).toContain("would write every row")
			const computed = yield* Effect.flip(
				PG.compile(CH.update(Counters).set({ search: "x" } as any).where(($) => [$.key.eq("k")])),
			)
			expect(computed.message).toContain('sets "search"')
			// @ts-expect-error -- an empty SET is a type error too
			const empty = yield* Effect.flip(PG.compile(CH.update(Counters).set({}).where(($) => [$.key.eq("k")])))
			expect(empty.message).toContain("sets no columns")
			const returning = yield* Effect.exit(CH.compile(CH.update(Spans).set({ Ms: 0 }).allRows().returning()))
			expect(failure(returning)).toBeInstanceOf(QueryBuilderDefect)
			const settings = yield* Effect.exit(PG.compile(CH.update(Counters).set({ count: 0 }).allRows().settings({ a: 1 })))
			expect(failure(settings)).toBeInstanceOf(QueryBuilderDefect)
		}),
	)
})

describe("subqueries in a write count toward its tenant scope", () => {
	const Other = CH.table("other", { org: PG.text, key: PG.text }, { tenantColumn: "org" })
	const Plain = CH.table("plain", { id: PG.text })

	it("a WHERE subquery over every tenant makes a pinned update cross-tenant", () => {
		const update = (inner: CH.CHQuery<any, any, any, any>) =>
			PG.compileUnsafe(
				CH.update(Counters)
					.set({ count: 1 })
					.where(($) => [$.org.eq(CH.param.string("org")), CH.inSubquery($.key, inner)]),
				{ org: "o", other: "p" },
			).tenantScope
		expect(update(CH.from(Other).select(($) => ({ k: $.key })))).toBe("cross-tenant")
		expect(update(CH.from(Other).select(($) => ({ k: $.key })).where(($) => [$.org.eq(CH.param.string("org"))]))).toBe(
			"single-tenant",
		)
		expect(update(CH.from(Other).select(($) => ({ k: $.key })).where(($) => [$.org.eq(CH.param.string("other"))]))).toBe(
			"cross-tenant",
		)
	})

	it("an untenanted target takes the scope of what its subqueries read", () => {
		const scope = (inner: CH.CHQuery<any, any, any, any>) =>
			PG.compileUnsafe(CH.deleteFrom(Plain).where(($) => [CH.inSubquery($.id, inner)]), { org: "o" }).tenantScope
		expect(scope(CH.from(Other).select(($) => ({ k: $.key })))).toBe("cross-tenant")
		expect(scope(CH.from(Other).select(($) => ({ k: $.key })).where(($) => [$.org.eq(CH.param.string("org"))]))).toBe(
			"single-tenant",
		)
		expect(PG.compileUnsafe(CH.deleteFrom(Plain).where(($) => [$.id.eq("x")])).tenantScope).toBe("untenanted")
	})

	it("a subquery in an insert's VALUES or ON CONFLICT SET counts too", () => {
		const anyKey = CH.subqueryExpr(CH.from(Other).select(($) => ({ k: $.key })).limit(1), PG.text)
		const pinned = { org: "o", key: "k", count: 1, meta: {} }
		expect(PG.compileUnsafe(CH.insertInto(Counters).values({ ...pinned, key: anyKey })).tenantScope).toBe("cross-tenant")
		expect(
			PG.compileUnsafe(CH.insertInto(Counters).values(pinned).onConflictDoUpdate({ target: ["key"], set: { key: anyKey } }))
				.tenantScope,
		).toBe("cross-tenant")
		expect(PG.compileUnsafe(CH.insertInto(Counters).values(pinned)).tenantScope).toBe("single-tenant")
	})
})

describe("deleteFrom", () => {
	it("writes DELETE ... WHERE ... RETURNING on Postgres and a lightweight DELETE on ClickHouse", () => {
		const pg = PG.compileUnsafe(
			CH.deleteFrom(Counters).where(($) => [$.org.eq(CH.param.string("org"))]).returning(),
			{ org: "o" },
		)
		expect(pg.sql).toBe(
			'DELETE FROM "counters"\nWHERE "org" = $1\nRETURNING "org" AS "org", "key" AS "key", "count" AS "count", "meta" AS "meta", "search" AS "search"',
		)
		expect(pg.kind).toBe("delete")
		expect(pg.tenantScope).toBe("single-tenant")
		const ch = CH.compileUnsafe(CH.deleteFrom(Spans).where(($) => [$.OrgId.eq("o")]).settings({ lightweight_deletes_sync: 2 }))
		expect(ch.sql).toBe("DELETE FROM spans\nWHERE OrgId = 'o' SETTINGS lightweight_deletes_sync = 2")
		expect(CH.compileUnsafe(CH.deleteFrom(Spans).allRows()).sql).toBe("DELETE FROM spans\nWHERE 1")
		expect(CH.compileUnsafe(CH.deleteFrom(Spans).allRows()).tenantScope).toBe("cross-tenant")
	})

	it.effect("refuses a delete with no where(), or whose conditions filter nothing", () =>
		Effect.gen(function* () {
			// @ts-expect-error -- a delete without where() or allRows() is a type error too
			expect(failure(yield* Effect.exit(CH.compile(CH.deleteFrom(Spans))))).toBeInstanceOf(QueryBuilderDefect)
			for (const conditions of [[], [CH.rawCond("")], [undefined, CH.rawCond("  ")]]) {
				const error = yield* Effect.flip(PG.compile(CH.deleteFrom(Counters).where(() => conditions)))
				expect(error.message).toContain("would write every row")
			}
			expect(PG.compileUnsafe(CH.deleteFrom(Counters).where(($) => [CH.rawCond(""), $.key.eq("k")])).sql).toBe(
				'DELETE FROM "counters"\nWHERE "key" = $1',
			)
		}),
	)
})
