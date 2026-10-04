import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import * as CH from "./index"
import * as PG from "../postgres"
import { QueryBuilderDefect } from "./errors"

const Events = CH.table(
	"events",
	{ OrgId: CH.string, Name: CH.string, Ms: CH.uint64, Note: CH.nullable(CH.string), At: CH.dateTime },
	{ tenantColumn: "OrgId" },
)
const Jobs = CH.table("jobs", { id: PG.int4, org: PG.text, state: PG.text, done_at: PG.nullable(PG.timestamptz) })

const failure = (exit: Exit.Exit<unknown, unknown>) =>
	Exit.isFailure(exit) ? exit.cause.reasons.map((r) => ("error" in r ? r.error : "defect" in r ? r.defect : r))[0] : undefined
const where = (sql: string) => sql.slice(sql.indexOf("WHERE"))

describe("null and range predicates", () => {
	it("isNull, isNotNull, between and notBetween, values encoded by the column", () => {
		const compiled = CH.compileUnsafe(
			CH.from(Events)
				.select("Name")
				.where(($) => [
					$.Note.isNull(),
					$.Name.isNotNull(),
					$.Ms.between(10, CH.param.int("hi")),
					$.At.notBetween(new Date(0), "2026-01-01 00:00:00"),
				]),
			{ hi: 20 },
		)
		expect(where(compiled.sql)).toBe(
			"WHERE events.Note IS NULL\n          AND events.Name IS NOT NULL\n          AND events.Ms BETWEEN 10 AND 20\n" +
				"          AND events.At NOT BETWEEN '1970-01-01 00:00:00' AND '2026-01-01 00:00:00'",
		)
	})

	it("binds between's ends on Postgres", () => {
		const compiled = PG.compileUnsafe(
			CH.from(Jobs).select("id").where(($) => [$.id.between(CH.param.int("lo"), 9), $.done_at.isNull()]),
			{ lo: 1 },
		)
		expect(where(compiled.sql)).toBe('WHERE "jobs"."id" BETWEEN $1 AND 9\n          AND "jobs"."done_at" IS NULL')
		expect(compiled.parameters).toEqual([1])
	})
})

describe("and / or", () => {
	it("skip undefined, render flat, and return undefined when nothing is left", () => {
		const q = (build: (e: CH.ColumnAccessor<typeof Events.columns>) => CH.Condition | undefined) =>
			where(CH.compileUnsafe(CH.from(Events).select("Name").where(($) => [build($)])).sql)
		expect(q(($) => CH.or($.Name.eq("a"), undefined, $.Name.eq("b"), $.Ms.gt(1)))).toBe(
			"WHERE (events.Name = 'a' OR events.Name = 'b' OR events.Ms > 1)",
		)
		expect(q(($) => CH.and($.Name.eq("a"), CH.or($.Ms.lt(1), $.Ms.gt(9))))).toBe(
			"WHERE (events.Name = 'a' AND (events.Ms < 1 OR events.Ms > 9))",
		)
		expect(q(($) => CH.and(undefined, $.Name.eq("a")))).toBe("WHERE events.Name = 'a'")
		expect(CH.and(undefined, undefined)).toBeUndefined()
		expect(CH.or()).toBeUndefined()
		expect(CH.compileUnsafe(CH.from(Events).select("Name").where(() => [CH.or(undefined)])).sql).not.toContain("WHERE")
	})

	it("and carries tenant evidence; or does not", () => {
		const scope = (build: (e: CH.ColumnAccessor<typeof Events.columns>) => CH.Condition | undefined) =>
			CH.compileUnsafe(CH.from(Events).select("Name").where(($) => [build($)])).tenantScope
		expect(scope(($) => CH.and($.OrgId.eq("o"), $.Ms.gt(1)))).toBe("single-tenant")
		expect(scope(($) => CH.or($.OrgId.eq("o"), $.OrgId.eq("p")))).toBe("cross-tenant")
	})
})

describe("distinct", () => {
	it("SELECT DISTINCT and DISTINCT ON on both dialects", () => {
		expect(CH.compileUnsafe(CH.from(Events).select("Name").distinct()).sql).toMatch(/^SELECT DISTINCT\n/)
		const on = CH.from(Jobs)
			.select(($) => ({ org: $.org, id: $.id }))
			.distinctOn("org")
			.orderBy(["org", "asc"], ["id", "desc"])
		expect(PG.compileUnsafe(on).sql).toMatch(/^SELECT DISTINCT ON \("org"\)\n/)
		expect(CH.compileUnsafe(on).sql).toMatch(/^SELECT DISTINCT ON \(org\)\n/)
		expect(CH.compileUnsafe(on.distinct()).sql).toMatch(/^SELECT DISTINCT\n/)
	})
})

describe("distinctOn without keys", () => {
	it.effect("is a defect rather than a whole-row DISTINCT", () =>
		Effect.gen(function* () {
			const keys: ReadonlyArray<"org"> = []
			const q = CH.from(Jobs).select("org").distinctOn(...(keys as unknown as ["org"]))
			expect(failure(yield* Effect.exit(PG.compile(q)))).toBeInstanceOf(QueryBuilderDefect)
		}),
	)
})

describe("row locking", () => {
	it("FOR UPDATE / NO KEY UPDATE / SHARE / KEY SHARE with OF, SKIP LOCKED and NOWAIT, after LIMIT", () => {
		const base = CH.from(Jobs).select("id").where(($) => [$.state.eq("queued")]).limit(1)
		const tail = (q: CH.CHQuery<any, any, any, any>) => PG.compileUnsafe(q, {}).sql.split("\n").at(-1)!.trim()
		expect(tail(base.forUpdate({ skipLocked: true }))).toBe("FOR UPDATE SKIP LOCKED")
		expect(PG.compileUnsafe(base.forUpdate({ skipLocked: true }), {}).sql).toMatch(/LIMIT 1\n\s+FOR UPDATE SKIP LOCKED$/)
		expect(tail(base.forNoKeyUpdate({ noWait: true }))).toBe("FOR NO KEY UPDATE NOWAIT")
		expect(tail(base.forShare({ of: ["jobs"] }))).toBe('FOR SHARE OF "jobs"')
		expect(tail(base.forKeyShare())).toBe("FOR KEY SHARE")
		expect(tail(base.forShare().forUpdate())).toBe("FOR UPDATE")
	})

	it.effect("is a defect on ClickHouse, with skipLocked and noWait together, and where Postgres refuses a lock", () =>
		Effect.gen(function* () {
			const base = CH.from(Jobs).select("id")
			const defect = function* (q: Effect.Effect<unknown, unknown>) {
				expect(failure(yield* Effect.exit(q))).toBeInstanceOf(QueryBuilderDefect)
			}
			yield* defect(CH.compile(base.forUpdate(), {}))
			yield* defect(PG.compile(base.forUpdate({ skipLocked: true, noWait: true }), {}))
			yield* defect(PG.compile(base.forUpdate({ of: ["public.jobs"] }), {}))
			yield* defect(PG.compile(base.distinct().forUpdate(), {}))
			yield* defect(PG.compile(CH.from(Jobs).select("org").groupBy("org").forShare(), {}))
			yield* defect(PG.compileUnion(CH.unionAll(base.forUpdate(), base), {}))
			expect(PG.compileUnsafe(base.forUpdate({ of: ["jobs"] })).sql).toMatch(/FOR UPDATE OF "jobs"$/)
		}),
	)
})
