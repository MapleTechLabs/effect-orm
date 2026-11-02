// A SQLite table's `casing`: every column without a `name` is stored under the
// name the casing gives its key. The DDL is rendered and run on node:sqlite, so
// a test passes only if each place that writes an identifier wrote the
// database name and every row decodes under its key.

import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Db from "../database"
import * as S from "../schema"
import * as SQLite from "../sqlite"

const Accounts = SQLite.table("accounts", {
	casing: "snake_case",
	columns: {
		orgId: SQLite.text,
		accountId: SQLite.integer,
		displayName: SQLite.column(SQLite.text, { name: "label" }),
		HTTPStatus: SQLite.column(SQLite.integer, { default: 200 }),
		lastSeenAt: SQLite.nullable(SQLite.timestamp),
	},
	primaryKey: ["orgId", "accountId"],
	indexes: [SQLite.uniqueIndex("accounts_label_unq", ["orgId", "displayName"]), SQLite.index("accounts_seen", ($) => [$.lastSeenAt])],
	tenantColumn: "orgId",
})

const ddlOf = (tables: Parameters<typeof S.sqliteEntitiesOf>[0]) => Effect.map(S.sqliteEntitiesOf(tables), S.renderSqliteSchema)

describe("casing", () => {
	it.effect("names every column without a name from its key in the DDL", () =>
		Effect.gen(function* () {
			const ddl = (yield* ddlOf([Accounts])).join("\n")
			expect(ddl).toContain(`"org_id" text NOT NULL`)
			expect(ddl).toContain(`"label" text NOT NULL`)
			expect(ddl).toContain(`"http_status" integer NOT NULL DEFAULT 200`)
			expect(ddl).toContain(`"last_seen_at" text`)
			expect(ddl).toContain(`PRIMARY KEY ("org_id", "account_id")`)
			expect(ddl).toContain(`ON "accounts" ("org_id", "label")`)
			expect(ddl).toContain(`ON "accounts" ("last_seen_at")`)
			expect(ddl).not.toMatch(/"(orgId|accountId|displayName|HTTPStatus|lastSeenAt)"/)
		}),
	)

	it("applies to an external table", () => {
		const View = SQLite.table("account_view", { external: true, casing: "snake_case", columns: { orgId: SQLite.text } })
		expect(SQLite.compileUnsafe(SQLite.from(View).select("orgId")).sql).toContain(`"account_view"."org_id" AS "orgId"`)
	})

	it("records a problem when two keys get one name (SQLite compares names without case)", async () => {
		const Clash = SQLite.table("clash", { casing: "snake_case", columns: { orgId: SQLite.text, OrgId: SQLite.text } })
		const exit = await Effect.runPromiseExit(S.sqliteEntitiesOf([Clash]))
		expect(Exit.isFailure(exit)).toBe(true)
		expect(Clash.problems.map((p) => p.message)).toEqual([expect.stringMatching(/org_id has the same SQL name as orgId/)])
	})

	it.effect("reads, writes, upserts, updates and deletes under the keys on node:sqlite", () =>
		Effect.gen(function* () {
			const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: SQLite.sqliteDialect })
			for (const sql of yield* ddlOf([Accounts])) yield* db.execute({ sql })
			yield* db.run(SQLite.insertInto(Accounts).values([
				{ orgId: "o1", accountId: 1, displayName: "Core", lastSeenAt: null },
				{ orgId: "o1", accountId: 2, displayName: "Edge", lastSeenAt: null },
			]))
			const upserted = yield* db.run(
				SQLite.insertInto(Accounts)
					.values({ orgId: "o1", accountId: 3, displayName: "Core", HTTPStatus: 404, lastSeenAt: null })
					.onConflictDoUpdate({ target: ["orgId", "displayName"], set: ($, excluded) => ({ HTTPStatus: excluded.HTTPStatus }) })
					.returning("accountId", "HTTPStatus"),
			)
			expect(upserted).toEqual([{ accountId: 1, HTTPStatus: 404 }])
			yield* db.run(SQLite.update(Accounts).set({ lastSeenAt: new Date("2026-01-01T00:00:00Z") }).where(($) => [$.orgId.eq("o1"), $.accountId.eq(2)]))
			yield* db.run(SQLite.deleteFrom(Accounts).where(($) => [$.orgId.eq("o1"), $.lastSeenAt.isNull()]))
			const query = SQLite.from(Accounts).select().where(($) => [$.orgId.eq(SQLite.param.string("org"))])
			expect(SQLite.compileUnsafe(query, { org: "o1" }).tenantScope).toBe("single-tenant")
			const rows = yield* db.run(query, { org: "o1" })
			expect(rows.map((row) => [row.accountId, row.displayName, row.HTTPStatus])).toEqual([[2, "Edge", 200]])
			const stored = yield* db.query({ sql: `SELECT name FROM pragma_table_info('accounts') ORDER BY cid` })
			expect(stored.map((row) => (row as { name: string }).name)).toEqual(["org_id", "account_id", "label", "http_status", "last_seen_at"])
		}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
	)
})
