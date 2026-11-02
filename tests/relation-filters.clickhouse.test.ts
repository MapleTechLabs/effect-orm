// Relation filters and counts on a live ClickHouse. `some` / `none` / `every`
// and `count()` are correlated subqueries, which ClickHouse runs since 25.x
// (`allow_experimental_correlated_subqueries`, on by default in 26.8).
// `_count` in `findMany` is a grouped `IN` query, which needs no correlation.

import { ClickhouseClient } from "@effect/sql-clickhouse"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as Db from "@maple-dev/effect-orm/database"
import { endpoint } from "./clickhouse-support"

const user = process.env.EFFECT_ORM_CLICKHOUSE_USER ?? "default"
const password = process.env.EFFECT_ORM_CLICKHOUSE_PASSWORD ?? ""

const Services = CH.table("services", {
	external: true,
	tenantColumn: "OrgId",
	columns: { OrgId: CH.string, Id: CH.uint32, Name: CH.string },
})
const Events = CH.table("events", {
	external: true,
	tenantColumn: "OrgId",
	columns: { OrgId: CH.string, Id: CH.uint32, ServiceId: CH.uint32, Level: CH.string },
})
const Notes = CH.table("notes", {
	external: true,
	tenantColumn: "OrgId",
	columns: { OrgId: CH.string, EventId: CH.uint32 },
})
const schema = Db.defineRelations({ services: Services, events: Events, notes: Notes }, (r) => ({
	services: { events: r.many("events", { from: "Id", to: "ServiceId" }) },
	events: { notes: r.many("notes", { from: "Id", to: "EventId" }) },
}))

const withDatabase = <A, E>(body: (db: Db.Database["Service"]) => Effect.Effect<A, E, Db.Database>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const database = `eo_relation_filters_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
			const admin = yield* ClickhouseClient.ClickhouseClient
			yield* admin.asCommand(admin.unsafe(`CREATE DATABASE ${database}`))
			return yield* Effect.gen(function* () {
				const client = yield* ClickhouseClient.ClickhouseClient
				const db = Db.fromSqlClient(client, {
					dialect: CH.clickhouseDialect,
					command: client.asCommand,
					requireTenantScope: true,
				})
				yield* db.execute(Db.sql`CREATE TABLE services (OrgId String, Id UInt32, Name String) ENGINE = MergeTree ORDER BY Id`)
				yield* db.execute(
					Db.sql`CREATE TABLE events (OrgId String, Id UInt32, ServiceId UInt32, Level String) ENGINE = MergeTree ORDER BY Id`,
				)
				yield* db.execute(Db.sql`CREATE TABLE notes (OrgId String, EventId UInt32) ENGINE = MergeTree ORDER BY EventId`)
				// api: an error and an info event; web: one info event; db: none.
				// Event 3 points at api but belongs to org b: the tenant equality must skip it.
				yield* db.execute(Db.sql`INSERT INTO services VALUES ('a', 1, 'api'), ('a', 2, 'web'), ('a', 3, 'db'), ('b', 4, 'other')`)
				yield* db.execute(
					Db.sql`INSERT INTO events VALUES ('a', 1, 1, 'error'), ('a', 2, 1, 'info'), ('a', 4, 2, 'info'), ('b', 3, 1, 'error')`,
				)
				yield* db.execute(Db.sql`INSERT INTO notes VALUES ('a', 1)`)
				return yield* body(db).pipe(Effect.provideService(Db.Database, db))
			}).pipe(
				Effect.provide(ClickhouseClient.layer({ url: endpoint!, username: user, password, database })),
				Effect.ensuring(Effect.orDie(admin.asCommand(admin.unsafe(`DROP DATABASE IF EXISTS ${database} SYNC`)))),
			)
		}).pipe(Effect.provide(ClickhouseClient.layer({ url: endpoint!, username: user, password, database: "default" }))),
	)

const names = (rows: ReadonlyArray<{ readonly Name: string }>) => rows.map((row) => row.Name)

describe.skipIf(!endpoint)("relation filters on live ClickHouse", () => {
	it("some, none and every run as correlated subqueries, scoped to the tenant", async () => {
		const result = await withDatabase(() =>
			Effect.gen(function* () {
				const find = (where: Db.RelationWhere<typeof schema.services.tables, typeof schema.services.relations, "services">) =>
					Db.findMany(schema.services, {
						where: ($, r) => [$.OrgId.eq("a"), ...where($, r)],
						orderBy: ($) => [[$.Id, "asc"]],
					}).pipe(Effect.map(names))
				return {
					some: yield* find((_, r) => [r.events.some()]),
					errors: yield* find((_, r) => [r.events.some(($) => [$.Level.eq("error")])]),
					none: yield* find((_, r) => [r.events.none()]),
					every: yield* find((_, r) => [r.events.every(($) => [$.Level.eq("info")])]),
					nested: yield* find((_, r) => [r.events.some((_, r) => [r.notes.some()])]),
				}
			}),
		)
		expect(result).toEqual({
			some: ["api", "web"],
			errors: ["api"],
			none: ["db"],
			every: ["web", "db"],
			nested: ["api"],
		})
	})

	// ClickHouse 26.8 runs a correlated subquery in SELECT next to a WHERE only
	// when the outer columns it correlates on are selected too ("can't find
	// correlated column … in current header", NOT_IMPLEMENTED). So this selects
	// the key (`Id`) and the tenant column (`OrgId`) beside the counts.
	it("count() in a select and a where, 0 when nothing matches", async () => {
		const rows = await withDatabase(() =>
			Db.run(
				CH.from(Services)
					.select(($) => ({
						org: $.OrgId,
						id: $.Id,
						name: $.Name,
						events: Db.related(schema.services, $).events.count(),
						errors: Db.related(schema.services, $).events.count(($) => [$.Level.eq("error")]),
					}))
					.where(($) => [$.OrgId.eq("a"), Db.related(schema.services, $).events.count().lt(2)])
					.orderBy(["name", "asc"]),
			),
		)
		expect(rows).toEqual([
			{ org: "a", id: 3, name: "db", events: 0, errors: 0 },
			{ org: "a", id: 2, name: "web", events: 1, errors: 0 },
		])
	})

	it("count() in a where needs no selected key", async () => {
		const rows = await withDatabase(() =>
			Db.run(
				CH.from(Services)
					.select(($) => ({ name: $.Name }))
					.where(($) => [$.OrgId.eq("a"), Db.related(schema.services, $).events.count().gte(2)]),
			),
		)
		expect(rows).toEqual([{ name: "api" }])
	})

	it("_count in findMany is one grouped statement per level", async () => {
		const rows = await withDatabase(() =>
			Db.findMany(schema.services, {
				where: ($) => [$.OrgId.eq("a")],
				orderBy: ($) => [[$.Id, "asc"]],
				_count: { events: true },
				with: { events: { orderBy: ($) => [[$.Id, "asc"]], _count: { notes: true } } },
			}),
		)
		expect(rows.map((row) => [row.Name, row._count.events, row.events.map((event) => event._count.notes)])).toEqual([
			["api", 2, [1, 0]],
			["web", 1, [0]],
			["db", 0, []],
		])
	})
})
