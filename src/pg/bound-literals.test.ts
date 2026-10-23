// On Postgres a value compared with a column is bound, not written into the
// statement: the text carries no values (logs, traces, query shapes), and the
// same value is one param. ClickHouse and DDL keep writing literals.

import { PGlite } from "@electric-sql/pglite"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as CH from "../ch/index"
import * as PG from "../postgres"
import * as S from "../schema"

const Users = PG.table("users", {
	columns: {
		orgId: PG.column(PG.text, { name: "org_id" }),
		email: PG.text,
		active: PG.column(PG.bool, { default: true }),
	},
	primaryKey: ["orgId", "email"],
	indexes: [PG.uniqueIndex("users_active_email_unq", ["email"], { where: ($) => $.active.eq(true) })],
	tenantColumn: "orgId",
})

const db = new PGlite()
afterAll(() => db.close())

describe("bound literals", () => {
	it("binds compared values, once per distinct value, and keeps the tenant scope", () => {
		const compiled = PG.compileUnsafe(
			PG.from(Users)
				.select("email")
				.where(($) => [$.orgId.eq("org_1"), $.email.in_("a@x", "org_1"), $.email.ilike(PG.param.string("q"))]),
			{ q: "%a%" },
		)
		expect(compiled.sql).not.toContain("org_1")
		expect(compiled.sql).not.toContain("a@x")
		expect(compiled.sql).toContain(`"org_id" = $1`)
		expect(compiled.sql).toContain(`"email" IN ($2, $1)`)
		expect(compiled.sql).toContain(`"email" ILIKE $3`)
		expect(compiled.parameters).toEqual(["org_1", "a@x", "%a%"])
		expect(compiled.tenantScope).toBe("single-tenant")
	})

	it("binds a plain LIKE pattern", () => {
		const compiled = PG.compileUnsafe(PG.from(Users).select("email").where(($) => [$.email.like("secret%")]))
		expect(compiled.sql).toContain(`LIKE $1`)
		expect(compiled.parameters).toEqual(["secret%"])
	})

	it("writes ON CONFLICT's index predicate inline, so Postgres can match the partial index", async () => {
		for (const statement of S.renderPgSchema(Effect.runSync(S.pgEntitiesOf([Users])))) await db.exec(statement)
		const upsert = PG.insertInto(Users)
			.values({ orgId: "o", email: "a@x" })
			.onConflictDoNothing({ target: ["email"], targetWhere: ($) => $.active.eq(true) })
		const compiled = PG.compileUnsafe(upsert)
		expect(compiled.sql).toContain(`ON CONFLICT ("email") WHERE "active" = TRUE DO NOTHING`)
		await db.query(compiled.sql, [...compiled.parameters])
		await db.query(compiled.sql, [...compiled.parameters])
		expect((await db.query(`SELECT count(*)::int AS n FROM users`)).rows).toEqual([{ n: 1 }])
	})

	it("leaves ClickHouse and DDL writing literals", () => {
		const Events = CH.table("events", { OrgId: CH.string, Name: CH.string }, { tenantColumn: "OrgId" })
		const compiled = CH.compileUnsafe(CH.from(Events).select("Name").where(($) => [$.OrgId.eq("o"), $.Name.like("a%")]))
		expect(compiled.sql).toContain(`OrgId = 'o'`)
		expect(compiled.sql).toContain(`LIKE 'a%'`)
		const ddl = S.renderPgSchema(Effect.runSync(S.pgEntitiesOf([Users]))).join("\n")
		expect(ddl).toContain(`"active" boolean NOT NULL DEFAULT true`)
		expect(ddl).toContain(`WHERE "active" = TRUE`)
	})
})

describe("orderBy and inList", () => {
	it("sorts by an expression that is not selected, and binds an inList", () => {
		const compiled = PG.compileUnsafe(
			PG.from(Users)
				.select("email")
				.where(($) => [PG.inList($.orgId, ["o1", "o2"])])
				.orderBy(($) => [
					[$.active, "desc"],
					[PG.lower($.email), "asc"],
				]),
		)
		expect(compiled.sql).toContain(`"org_id" IN ($1, $2)`)
		expect(compiled.sql).toContain(`ORDER BY "users"."active" DESC, lower("users"."email") ASC`)
		expect(compiled.parameters).toEqual(["o1", "o2"])
	})
})

describe("orderBy params", () => {
	it("accepts columns of any table and requires the params its expressions use", () => {
		const byKeys = (keys: ReadonlyArray<"email" | "orgId">) =>
			PG.from(Users).select("email").orderBy(($) => keys.map((key) => [$[key], "asc"] as const))
		expect(PG.compileUnsafe(byKeys(["orgId", "email"])).sql).toContain(`ORDER BY "users"."org_id" ASC, "users"."email" ASC`)
		const byParam = PG.from(Users)
			.select("email")
			.orderBy(($) => [[PG.coalesce($.email, PG.param.string("fallback")), "asc"]])
		// @ts-expect-error the fallback param is required
		expect(() => PG.compileUnsafe(byParam, {})).toThrow("fallback")
		expect(PG.compileUnsafe(byParam, { fallback: "z" }).parameters).toEqual(["z"])
	})
})

describe("typed placeholders", () => {
	const Scores = PG.table("scores", { columns: { id: PG.int8, ok: PG.bool, tags: PG.array(PG.text) }, primaryKey: ["id"] })
	const run = (compiled: PG.CompiledQuery<any>) =>
		Effect.promise(() => db.query<Record<string, unknown>>(compiled.sql, [...compiled.parameters])).pipe(
			Effect.flatMap((result) => compiled.decodeRows(result.rows)),
		)

	it.effect("a param.of in a select list binds as its own type, not text", () =>
		Effect.gen(function* () {
			yield* Effect.promise(() => db.exec(`CREATE TABLE IF NOT EXISTS scores (id int8 PRIMARY KEY, ok boolean, tags text[]); INSERT INTO scores VALUES (1, true, '{a}') ON CONFLICT DO NOTHING`))
			const compiled = PG.compileUnsafe(
				PG.from(Scores).select(() => ({ flag: CH.param.of(PG.bool, "flag"), list: CH.param.of(PG.array(PG.text), "list") })),
				{ flag: false, list: [] },
			)
			expect(compiled.sql).toContain(`CAST($1 AS boolean) AS "flag"`)
			expect(compiled.sql).toContain(`CAST($2 AS text[]) AS "list"`)
			expect(yield* run(compiled)).toEqual([{ flag: false, list: [] }])
			// A ClickHouse type has no Postgres name to cast to; it is left as it was.
			expect(PG.compileUnsafe(PG.from(Scores).select(() => ({ s: CH.param.of(CH.string, "s") })), { s: "a" }).sql).toContain(`$1 AS "s"`)
		}),
	)

	it.effect("a fraction compared with an integer column binds as numeric; a whole number stays uncast", () =>
		Effect.gen(function* () {
			const compiled = PG.compileUnsafe(PG.from(Scores).select("id").where(($) => [$.id.gt(0.5), $.id.lt(2)]), {})
			expect(compiled.sql).toContain(`"id" > $1::numeric`)
			expect(compiled.sql).toMatch(/"id" < \$2(?!:)/)
			expect(yield* run(compiled)).toEqual([{ id: 1 }])
		}),
	)

	it.effect("a param compared with a column stays untyped, and a float4 fraction still matches", () =>
		Effect.gen(function* () {
			const Reals = PG.table("reals", { columns: { id: PG.int8, r: PG.float4 }, primaryKey: ["id"] })
			yield* Effect.promise(() => db.exec(`CREATE TABLE IF NOT EXISTS reals (id int8 PRIMARY KEY, r real); INSERT INTO reals VALUES (1, 0.1) ON CONFLICT DO NOTHING`))
			const byParam = PG.compileUnsafe(PG.from(Scores).select("id").where(($) => [$.id.eq(CH.param.of(PG.int8, "v"))]), { v: 1 })
			expect(byParam.sql).toMatch(/"id" = \$1(?!:)/)
			const real = PG.compileUnsafe(PG.from(Reals).select("id").where(($) => [$.r.eq(0.1)]), {})
			expect(real.sql).toMatch(/"r" = \$1(?!:)/)
			expect(yield* run(real)).toEqual([{ id: 1 }])
		}),
	)

	it("inserting a fraction into an integer column is not cast, so it is not rounded", () => {
		const compiled = PG.compileUnsafe(PG.insertInto(Scores).values([{ id: 9.75, ok: true, tags: [] }]))
		expect(compiled.sql).not.toContain("::numeric")
	})
})
