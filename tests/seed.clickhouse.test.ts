// `Seed.insert` on a live ClickHouse: every built-in column type gets values
// the server stores, and the rows read back as they were seeded. Creates one
// table in a throwaway database.

import { ClickhouseClient } from "@effect/sql-clickhouse"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as Db from "@maple-dev/effect-orm/database"
import * as Seed from "@maple-dev/effect-orm/seed"
import { endpoint } from "./clickhouse-support"
import { normalize } from "./fuzz/values"

const user = process.env.EFFECT_ORM_CLICKHOUSE_USER ?? "default"
const password = process.env.EFFECT_ORM_CLICKHOUSE_PASSWORD ?? ""

const Events = CH.table("events", {
	external: true,
	tenantColumn: "OrgId",
	columns: {
		OrgId: CH.string,
		Id: CH.uint64,
		Name: CH.lowCardinality(CH.string),
		Small: CH.uint8,
		Medium: CH.uint16,
		Count: CH.uint32,
		Delta: CH.int32,
		Total: CH.int64,
		Ratio: CH.float64,
		Ok: CH.bool,
		At: CH.dateTime,
		At64: CH.dateTime64,
		AtText: CH.dateTimeString,
		Note: CH.nullable(CH.string),
		Tags: CH.array(CH.string),
		Attrs: CH.map(CH.string, CH.int64),
		Version: CH.column(CH.uint32, { default: 1 }),
	},
})

describe("seed", () => {
	describe.skipIf(!endpoint)("live ClickHouse", () => {
		it("inserts seeded rows of every built-in type, which read back as seeded", async () => {
			const database = `eo_seed_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
			const { seeded, read, sent } = await Effect.runPromise(
				Effect.gen(function* () {
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
						yield* db.execute(
							Db.sql`CREATE TABLE events (
								OrgId String, Id UInt64, Name LowCardinality(String), Small UInt8, Medium UInt16, Count UInt32,
								Delta Int32, Total Int64, Ratio Float64, Ok Bool, At DateTime, At64 DateTime64(3), AtText DateTime,
								Note Nullable(String), Tags Array(String), Attrs Map(String, Int64), Version UInt32 DEFAULT 1
							) ENGINE = MergeTree ORDER BY (OrgId, Id)`,
						)
						const seeded = yield* Seed.insert(Events, { count: 60, seed: 1, tenant: "org_1", unique: ["Id"], batchSize: 25 }).pipe(
							Effect.provideService(Db.Database, db),
						)
						const read = yield* db.run(
							CH.from(Events)
								.select("Id", "Name", "Small", "Medium", "Count", "Delta", "Total", "Ratio", "Ok", "At", "At64", "AtText", "Note", "Tags", "Attrs", "Version")
								.where(($) => [$.OrgId.eq("org_1")])
								.orderBy(["Id", "asc"]),
						)
						return { seeded, read, sent }
					}).pipe(
						Effect.provide(ClickhouseClient.layer({ url: endpoint!, username: user, password, database })),
						Effect.ensuring(Effect.orDie(admin.asCommand(admin.unsafe(`DROP DATABASE IF EXISTS ${database} SYNC`)))),
					)
				}).pipe(Effect.provide(ClickhouseClient.layer({ url: endpoint!, username: user, password, database: "default" }))),
			)
			expect(sent.filter((sql) => sql.startsWith("INSERT"))).toHaveLength(3)
			const expected = [...seeded]
				.sort((a, b) => a.Id - b.Id)
				.map(({ OrgId: _, ...row }) => ({ ...row, Version: 1 }))
			expect(read.map(normalize)).toEqual(expected.map(normalize))
		})
	})
})
