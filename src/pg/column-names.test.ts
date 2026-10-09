// Columns declared under a key other than their database name:
// `orgId: PG.column(PG.text, { name: "org_id" })`. Every statement here runs on
// PGlite, so a test passes only if each place that writes an identifier wrote
// the database name and every row decodes under the key.

import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it, layer } from "@effect/vitest"
import { DateTime, Effect, Exit, Layer, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Db from "../database"
import * as PG from "../postgres"
import * as S from "../schema"

const Teams = PG.table("teams", {
	columns: {
		orgId: PG.column(PG.text, { name: "org_id" }),
		teamId: PG.column(PG.text, { name: "team_id" }),
		displayName: PG.column(PG.text, { name: "display_name" }),
	},
	primaryKey: ["orgId", "teamId"],
	tenantColumn: "orgId",
})

const Members = PG.table("members", {
	columns: {
		id: PG.column(PG.int4, { name: "member_id", identity: "always" }),
		orgId: PG.column(PG.text, { name: "org_id" }),
		teamId: PG.column(PG.text, { name: "team_id" }),
		email: PG.text,
		visitCount: PG.column(PG.int4, { name: "visit_count", default: 0 }),
		joinedAt: PG.column(PG.timestamptz, { name: "joined_at", defaultExpr: "now()" }),
		leftAt: PG.column(PG.nullable(PG.timestamptz), { name: "left_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("members_email_unq", ["orgId", "email"]),
		PG.index("members_active_idx", ($) => [$.orgId, PG.lower($.email)], { where: ($) => $.leftAt.isNull() }),
	],
	foreignKeys: [PG.foreignKey({ columns: ["orgId", "teamId"], references: Teams, foreignColumns: ["orgId", "teamId"] })],
	tenantColumn: "orgId",
})

const Live = Layer.effect(
	Db.Database,
	Effect.gen(function* () {
		return Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: PG.postgresDialect })
	}),
).pipe(Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })))

describe("column names", () => {
	it.effect("writes the database names into the DDL and keeps keys out of it", () =>
		Effect.gen(function* () {
			const ddl = S.renderPgSchema(yield* S.pgEntitiesOf([Teams, Members])).join("\n")
			expect(ddl).toContain(`"org_id" text NOT NULL`)
			expect(ddl).toContain(`"visit_count" integer NOT NULL DEFAULT 0`)
			expect(ddl).toContain(`PRIMARY KEY ("org_id", "team_id")`)
			expect(ddl).toContain(`ON "members" USING btree ("org_id", "email")`)
			expect(ddl).toContain(`USING btree ("org_id", lower("email")) WHERE "left_at" IS NULL`)
			expect(ddl).toContain(`FOREIGN KEY ("org_id", "team_id") REFERENCES "teams" ("org_id", "team_id")`)
			expect(ddl).toContain(`members_org_id_team_id_teams_org_id_team_id_fk`)
			expect(ddl).not.toMatch(/"(orgId|teamId|visitCount|joinedAt|leftAt|displayName)"/)
		}),
	)

	it("leaves a renamed column without a default required on insert", () => {
		// @ts-expect-error displayName has a name but no default, so it is required
		PG.insertInto(Teams).values({ orgId: "o", teamId: "t" })
		PG.insertInto(Members).values({ orgId: "o", teamId: "t", email: "a@x" })
	})

	layer(Live)((it) => {
		it.effect("reads, writes, upserts and deletes under the keys", () =>
			Effect.gen(function* () {
				for (const statement of S.renderPgSchema(yield* S.pgEntitiesOf([Teams, Members]))) {
					yield* Db.execute({ sql: statement })
				}
				yield* Db.run(PG.insertInto(Teams).values({ orgId: "o1", teamId: "t1", displayName: "Core" }))

				const inserted = yield* Db.run(
					PG.insertInto(Members)
						.values([
							{ orgId: "o1", teamId: "t1", email: "a@x" },
							{ orgId: "o1", teamId: "t1", email: "b@x", visitCount: 3 },
						])
						.returning(),
				)
				expect(inserted.map((row) => [row.email, row.visitCount, row.leftAt])).toEqual([
					["a@x", 0, null],
					["b@x", 3, null],
				])
				expect(DateTime.isDateTime(inserted[0]!.joinedAt)).toBe(true)

				const upserted = yield* Db.run(
					PG.insertInto(Members)
						.values({ orgId: "o1", teamId: "t1", email: "a@x", visitCount: 5 })
						.onConflictDoUpdate({
							target: ["orgId", "email"],
							set: ($, excluded) => ({ visitCount: $.visitCount.add(excluded.visitCount) }),
						})
						.returning("email", "visitCount"),
				)
				expect(upserted).toEqual([{ email: "a@x", visitCount: 5 }])

				const updated = yield* Db.run(
					PG.update(Members)
						.set({ leftAt: new Date("2026-01-01T00:00:00Z") })
						.where(($) => [$.orgId.eq(PG.param.string("orgId")), $.email.eq("b@x")])
						.returning(($) => ({ email: $.email, left: $.leftAt })),
					{ orgId: "o1" },
				)
				expect(updated.map((row) => row.left === null ? null : DateTime.formatIso(row.left))).toEqual([
					"2026-01-01T00:00:00.000Z",
				])

				const joined = yield* Db.run(
					PG.from(Members)
						.innerJoin(Teams, "t", (m, t) => PG.and(m.orgId.eq(t.orgId), m.teamId.eq(t.teamId)))
						.select(($) => ({ email: $.email, team: $.t.displayName, visits: $.visitCount }))
						.where(($) => [$.orgId.eq("o1"), $.leftAt.isNull()])
						.orderBy(["email", "asc"]),
				)
				expect(joined).toEqual([{ email: "a@x", team: "Core", visits: 5 }])

				// A subquery's output is read under its alias, not the column's database name.
				const inner = PG.from(Members)
					.select(($) => ({ orgId: $.orgId, visitCount: $.visitCount }))
					.where(($) => [$.orgId.eq("o1")])
				const total = yield* Db.run(
					PG.fromQuery(inner, "m").select(($) => ({ total: PG.sum($.visitCount) })),
				)
				expect(total).toEqual([{ total: 8 }])

				const all = yield* Db.run(PG.from(Members).select().where(($) => [$.orgId.eq("o1")]).orderBy(["email", "asc"]))
				expect(Object.keys(all[0]!).sort()).toEqual(
					["email", "id", "joinedAt", "leftAt", "orgId", "teamId", "visitCount"].sort(),
				)

				const deleted = yield* Db.run(
					PG.deleteFrom(Members).where(($) => [$.orgId.eq("o1"), $.leftAt.isNotNull()]).returning("email"),
				)
				expect(deleted).toEqual([{ email: "b@x" }])
			}),
		)

		it.effect("scopes a query by a renamed tenant column", () =>
			Effect.sync(() => {
				const compiled = PG.compileUnsafe(
					PG.from(Members).select("email").where(($) => [$.orgId.eq(PG.param.string("orgId"))]),
					{ orgId: "o1" },
				)
				expect(compiled.tenantScope).toBe("single-tenant")
				expect(compiled.sql).toContain(`"org_id" = $1`)
			}),
		)
	})
})

describe("spreading the accessor", () => {
	it("reads every column under its key, beside computed ones", () => {
		const compiled = PG.compileUnsafe(
			PG.update(Members)
				.set({ visitCount: 1 })
				.where(($) => [$.orgId.eq("o1")])
				.returning(($) => ({ ...$, txid: PG.sql(PG.text)`pg_current_xact_id()::xid::text` })),
		)
		expect(compiled.returning).toEqual(["id", "orgId", "teamId", "email", "visitCount", "joinedAt", "leftAt", "txid"])
		expect(compiled.sql).toContain(`"member_id" AS "id"`)
		const selected = PG.compileUnsafe(PG.from(Members).select(($) => ({ ...$, lowered: PG.lower($.email) })))
		expect(selected.sql).toContain(`"members"."left_at" AS "leftAt"`)
	})
})

describe("undecoded", () => {
	it("reads a column as the driver sends it, typed as its wire form", async () => {
		const Docs = PG.table("docs_undecoded", {
			columns: {
				id: PG.text,
				body: PG.column(PG.nullable(PG.jsonb(Schema.Struct({ v: Schema.Number }))), { name: "body_json" }),
			},
			primaryKey: ["id"],
		})
		const query = PG.from(Docs).select(($) => ({ id: $.id, body: PG.undecoded($.body) }))
		const compiled = PG.compileUnsafe(query)
		expect(compiled.sql).toContain(`"docs_undecoded"."body_json" AS "body"`)
		const rows = await Effect.runPromise(compiled.decodeRows([{ id: "a", body: { old: "shape" } }]))
		expect(rows).toEqual([{ id: "a", body: { old: "shape" } }])
		// The typed read refuses the same row.
		const strict = PG.compileUnsafe(PG.from(Docs).select("id", "body"))
		expect(Exit.isFailure(await Effect.runPromiseExit(strict.decodeRows([{ id: "a", body: { old: "shape" } }])))).toBe(true)
	})
})
