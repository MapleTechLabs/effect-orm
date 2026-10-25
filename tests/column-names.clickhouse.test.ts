// Renamed and cased columns on a live ClickHouse: the table is created from its
// own DDL, and every statement runs, so a test passes only if each place that
// writes an identifier wrote the database name and every row decodes under its
// key. Creates its tables in a throwaway database.

import { ClickhouseClient } from "@effect/sql-clickhouse"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as Db from "@maple-dev/effect-orm/database"
import * as S from "@maple-dev/effect-orm/schema"
import { endpoint } from "./clickhouse-support"

const user = process.env.EFFECT_ORM_CLICKHOUSE_USER ?? "default"
const password = process.env.EFFECT_ORM_CLICKHOUSE_PASSWORD ?? ""

const withDatabase = <A, E>(body: (db: Db.DatabaseApi, database: string) => Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const database = `eo_names_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
		const admin = yield* ClickhouseClient.ClickhouseClient
		yield* admin.asCommand(admin.unsafe(`CREATE DATABASE ${database}`))
		return yield* Effect.gen(function* () {
			const client = yield* ClickhouseClient.ClickhouseClient
			return yield* body(Db.fromSqlClient(client, { dialect: CH.clickhouseDialect, command: client.asCommand }), database)
		}).pipe(
			Effect.provide(ClickhouseClient.layer({ url: endpoint!, username: user, password, database })),
			Effect.ensuring(Effect.orDie(admin.asCommand(admin.unsafe(`DROP DATABASE IF EXISTS ${database} SYNC`)))),
		)
	}).pipe(Effect.provide(ClickhouseClient.layer({ url: endpoint!, username: user, password, database: "default" })))

const SystemColumns = CH.table("system.columns", {
	external: true,
	columns: { database: CH.string, table: CH.string, name: CH.string, position: CH.uint64 },
})

const Requests = CH.table("requests", {
	casing: "snake_case",
	columns: {
		orgId: CH.string,
		requestId: CH.uint32,
		route: CH.column(CH.string, { name: "path" }),
		statusCode: CH.column(CH.uint16, { default: 200 }),
		createdAt: CH.column(CH.dateTime, { defaultExpr: "now()" }),
		createdDay: CH.column(CH.string, { materialized: ($) => CH.formatDateTime($.createdAt, "%F") }),
	},
	engine: CH.engine.mergeTree(),
	orderBy: ["orgId", "requestId"],
	tenantColumn: "orgId",
})

const RouteHits = CH.table("route_hits", {
	columns: { orgId: CH.string, route: CH.string, hits: CH.uint64 },
	engine: CH.engine.summingMergeTree(),
	orderBy: ["orgId", "route"],
})

const RouteHitsMv = CH.materializedView("route_hits_mv", {
	to: RouteHits,
	as: CH.from(Requests)
		.select(($) => ({ orgId: $.orgId, route: $.route, hits: CH.count() }))
		.groupBy("orgId", "route"),
})

describe("column names", () => {
	describe.skipIf(!endpoint)("live ClickHouse", () => {
		it("creates, writes, reads, updates and deletes under the keys", async () => {
			const result = await Effect.runPromise(
				withDatabase((db, database) =>
					Effect.gen(function* () {
						for (const statement of S.renderSchema(yield* S.entitiesOf([Requests, RouteHits, RouteHitsMv]))) {
							yield* db.execute({ sql: statement })
						}
						yield* db.run(
							CH.insertInto(Requests).values([
								{ orgId: "o1", requestId: 1, route: "/a", createdAt: new Date("2026-01-02T03:04:05Z") },
								{ orgId: "o1", requestId: 2, route: "/a", statusCode: 503 },
								{ orgId: "o2", requestId: 3, route: "/b" },
							]),
						)
						yield* db.run(
							CH.update(Requests)
								.set({ statusCode: 500 })
								.where(($) => [$.orgId.eq(CH.param.string("org")), $.requestId.eq(1)])
								.settings({ mutations_sync: 2 }),
							{ org: "o1" },
						)
						yield* db.run(
							CH.deleteFrom(Requests).where(($) => [$.orgId.eq("o2")]).settings({ lightweight_deletes_sync: 2 }),
						)
						const query = CH.from(Requests)
							.select("requestId", "route", "statusCode", "createdAt", "createdDay")
							.where(($) => [$.orgId.eq(CH.param.string("org"))])
							.orderBy(["requestId", "asc"])
						const rows = yield* db.run(query, { org: "o1" })
						const hits = yield* db.run(
							CH.from(RouteHits)
								.select(($) => ({ orgId: $.orgId, route: $.route, hits: CH.sum($.hits) }))
								.groupBy("orgId", "route")
								.orderBy(["orgId", "asc"]),
						)
						const columns = yield* db.run(
							CH.from(SystemColumns)
								.select("name")
								.where(($) => [$.database.eq(database), $.table.eq("requests")])
								.orderBy(($) => [[$.position, "asc"]]),
						)
						return { rows, hits, columns, scope: CH.compileUnsafe(query, { org: "o1" }).tenantScope }
					}),
				),
			)
			expect(result.columns.map((column) => column.name)).toEqual([
				"org_id",
				"request_id",
				"path",
				"status_code",
				"created_at",
				"created_day",
			])
			expect(result.rows.map(({ requestId, route, statusCode }) => ({ requestId, route, statusCode }))).toEqual([
				{ requestId: 1, route: "/a", statusCode: 500 },
				{ requestId: 2, route: "/a", statusCode: 503 },
			])
			expect(DateTime.formatIso(result.rows[0]!.createdAt)).toBe("2026-01-02T03:04:05.000Z")
			expect(result.rows[0]!.createdDay).toBe("2026-01-02")
			expect(result.hits).toEqual([
				{ orgId: "o1", route: "/a", hits: 2 },
				{ orgId: "o2", route: "/b", hits: 1 },
			])
			expect(result.scope).toBe("single-tenant")
		})
	})
})
