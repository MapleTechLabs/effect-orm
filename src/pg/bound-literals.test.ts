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
