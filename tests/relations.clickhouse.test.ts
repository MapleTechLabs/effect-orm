// `findMany` on a live ClickHouse: relations need no foreign keys, so the same
// loader runs here. Creates two tables in a throwaway database.

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
	columns: { OrgId: CH.string, ServiceId: CH.uint32, At: CH.dateTime64 },
})
const schema = Db.defineRelations({ services: Services, events: Events }, (r) => ({
	services: { events: r.many("events", { from: "Id", to: "ServiceId" }) },
	events: { service: r.one("services", { from: "ServiceId", to: "Id" }) },
}))

describe.skipIf(!endpoint)("findMany on live ClickHouse", () => {
	it("loads nested relations, pinned to the tenant, one statement per level", async () => {
		const { rows, sent } = await Effect.runPromise(
			Effect.gen(function* () {
				const database = `eo_relations_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
				const admin = yield* ClickhouseClient.ClickhouseClient
				yield* admin.asCommand(admin.unsafe(`CREATE DATABASE ${database}`))
				return yield* Effect.gen(function* () {
					const client = yield* ClickhouseClient.ClickhouseClient
					const sent: Array<string> = []
					const db = Db.fromSqlClient(client, {
						dialect: CH.clickhouseDialect,
						command: client.asCommand,
						requireTenantScope: true,
						observe: (statement) => Effect.sync(() => void sent.push(statement.sql)),
					})
					yield* db.execute(Db.sql`CREATE TABLE services (OrgId String, Id UInt32, Name String) ENGINE = MergeTree ORDER BY Id`)
					yield* db.execute(
						Db.sql`CREATE TABLE events (OrgId String, ServiceId UInt32, At DateTime64(3)) ENGINE = MergeTree ORDER BY At`,
					)
					yield* db.execute(Db.sql`INSERT INTO services VALUES ('a', 1, 'api'), ('b', 2, 'web')`)
					yield* db.execute(
						Db.sql`INSERT INTO events VALUES ('a', 1, '2026-01-01 00:00:00.000'), ('b', 1, '2026-01-01 00:00:01.000')`,
					)
					sent.length = 0
					const rows = yield* Db.findMany(schema.services, {
						where: ($) => [$.OrgId.eq("a")],
						with: { events: { with: { service: true } } },
					}).pipe(Effect.provideService(Db.Database, db))
					return { rows, sent }
				}).pipe(
					Effect.provide(ClickhouseClient.layer({ url: endpoint!, username: user, password, database })),
					Effect.ensuring(Effect.orDie(admin.asCommand(admin.unsafe(`DROP DATABASE IF EXISTS ${database} SYNC`)))),
				)
			}).pipe(Effect.provide(ClickhouseClient.layer({ url: endpoint!, username: user, password, database: "default" }))),
		)
		expect(sent).toHaveLength(3)
		expect(rows).toHaveLength(1)
		const [api] = rows
		expect(api!.Name).toBe("api")
		expect(api!.events).toHaveLength(1)
		expect(api!.events[0]!.service?.Name).toBe("api")
	})
})
