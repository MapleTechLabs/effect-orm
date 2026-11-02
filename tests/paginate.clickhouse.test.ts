// `paginate` on a live ClickHouse: a DateTime64 + UInt64 key, in one direction
// (a tuple comparison) and in mixed directions (the expanded OR form). Creates
// one table in a throwaway database.

import { ClickhouseClient } from "@effect/sql-clickhouse"
import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as Db from "@maple-dev/effect-orm/database"
import { endpoint } from "./clickhouse-support"

const user = process.env.EFFECT_ORM_CLICKHOUSE_USER ?? "default"
const password = process.env.EFFECT_ORM_CLICKHOUSE_PASSWORD ?? ""

const Events = CH.table("events", {
	external: true,
	tenantColumn: "OrgId",
	columns: { OrgId: CH.string, At: CH.dateTime64, Id: CH.uint64 },
})
const byOrg = CH.from(Events)
	.select("Id", "At")
	.where(($) => [$.OrgId.eq(CH.param.string("org"))])

const withEvents = <A, E>(body: (db: Db.DatabaseApi, sent: Array<string>) => Effect.Effect<A, E, Db.Database>) =>
	Effect.gen(function* () {
		const database = `eo_paginate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
		const admin = yield* ClickhouseClient.ClickhouseClient
		yield* admin.asCommand(admin.unsafe(`CREATE DATABASE ${database}`))
		return yield* Effect.gen(function* () {
			const client = yield* ClickhouseClient.ClickhouseClient
			const sent: Array<string> = []
			const db = Db.fromSqlClient(client, {
				dialect: CH.clickhouseDialect,
				command: client.asCommand,
				observe: (statement) => Effect.sync(() => void sent.push(statement.sql)),
			})
			yield* db.execute(Db.sql`CREATE TABLE events (OrgId String, At DateTime64(3), Id UInt64) ENGINE = MergeTree ORDER BY (OrgId, At, Id)`)
			// Ids 1..7; timestamps tie in pairs and carry milliseconds.
			yield* db.run(
				CH.insertInto(Events).values([
					...[1, 2, 3, 4, 5, 6, 7].map((id) => ({
						OrgId: "a",
						At: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.ceil(id / 2), 250)),
						Id: id,
					})),
					{ OrgId: "b", At: new Date(Date.UTC(2026, 0, 1)), Id: 8 },
				]),
			)
			return yield* body(db, sent).pipe(Effect.provideService(Db.Database, db))
		}).pipe(
			Effect.provide(ClickhouseClient.layer({ url: endpoint!, username: user, password, database })),
			Effect.ensuring(Effect.orDie(admin.asCommand(admin.unsafe(`DROP DATABASE IF EXISTS ${database} SYNC`)))),
		)
	}).pipe(Effect.provide(ClickhouseClient.layer({ url: endpoint!, username: user, password, database: "default" })))

const walk = (orderBy: Db.KeysetOrder<Db.RowOf<typeof byOrg>>, limit: number) =>
	Effect.gen(function* () {
		const pages: Array<ReadonlyArray<number>> = []
		let after: string | undefined
		for (;;) {
			const page = yield* Db.paginate(byOrg, { orderBy, limit, after }, { org: "a" })
			pages.push(page.rows.map((row) => row.Id))
			if (Option.isNone(page.nextCursor)) return pages
			after = page.nextCursor.value
		}
	})

describe("paginate", () => {
	describe.skipIf(!endpoint)("live ClickHouse", () => {
		it("walks a DateTime64 + UInt64 key newest first with a tuple comparison", async () => {
			const { pages, sent } = await Effect.runPromise(
				withEvents((_db, sent) => Effect.map(walk([["At", "desc"], ["Id", "desc"]], 3), (pages) => ({ pages, sent }))),
			)
			expect(pages).toEqual([[7, 6, 5], [4, 3, 2], [1]])
			expect(sent.at(-1)).toMatch(/\(events\.At, events\.Id\) < \('2026-01-01 00:00:01\.250', 2\)/)
			expect(sent.at(-1)).toMatch(/ORDER BY events\.At DESC, events\.Id DESC\s+LIMIT 4/)
		})

		it("walks mixed directions with the expanded OR form", async () => {
			const pages = await Effect.runPromise(withEvents(() => walk([["At", "asc"], ["Id", "desc"]], 2)))
			expect(pages).toEqual([[2, 1], [4, 3], [6, 5], [7]])
		})
	})
})
