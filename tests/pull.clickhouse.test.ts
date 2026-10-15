import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { ClickhouseClient } from "@effect/sql-clickhouse"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as Kit from "@maple-dev/effect-orm/kit"
import * as Migrate from "@maple-dev/effect-orm/migrate"
import { endpoint } from "./clickhouse-support"

const user = process.env.EFFECT_ORM_CLICKHOUSE_USER ?? "default"
const password = process.env.EFFECT_ORM_CLICKHOUSE_PASSWORD ?? ""

const client = (database: string) => ClickhouseClient.layer({ url: endpoint!, username: user, password, database })

/** A database built with plain DDL, as one that predates effect-orm would be. */
const DDL = [
	`CREATE TABLE events (
		OrgId LowCardinality(String),
		Ts DateTime64(3) CODEC(Delta, ZSTD(1)),
		Name String DEFAULT 'x' COMMENT 'the name',
		Duration Nullable(UInt64),
		Attributes Map(String, Array(Float64)),
		Level Enum8('debug' = 1, 'info' = 2),
		Amount Decimal(18, 4),
		Id UUID,
		Hour DateTime MATERIALIZED toStartOfHour(Ts),
		Day Date ALIAS toDate(Ts),
		INDEX idx_name Name TYPE bloom_filter(0.01) GRANULARITY 2
	) ENGINE = ReplacingMergeTree(Ts)
	PARTITION BY toDate(Ts) PRIMARY KEY OrgId ORDER BY (OrgId, toStartOfHour(Ts), Name)
	TTL toDate(Ts) + INTERVAL 30 DAY SETTINGS index_granularity = 4096 COMMENT 'events table'`,
	"CREATE TABLE totals (OrgId String, Name String, C UInt64) ENGINE = SummingMergeTree ORDER BY (OrgId, Name)",
	"CREATE TABLE states (K String, Sign Int8, Ver UInt32, U AggregateFunction(uniq, String)) ENGINE = VersionedCollapsingMergeTree(Sign, Ver) ORDER BY K",
	"CREATE TABLE scratch (A String) ENGINE = MergeTree ORDER BY tuple()",
	"CREATE TABLE sink (A String) ENGINE = Null",
	"CREATE MATERIALIZED VIEW totals_mv TO totals AS SELECT OrgId, Name, count() AS C FROM events GROUP BY OrgId, Name",
	"CREATE VIEW recent AS SELECT OrgId, Name FROM events",
]

describe.skipIf(!endpoint)("pull (live)", () => {
	it("writes definitions that baseline cleanly and verify against the database", async () => {
		const database = `eo_pull_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
		// Inside the package, so the generated `@maple-dev/effect-orm/clickhouse` import resolves.
		const dir = mkdtempSync(join(import.meta.dirname, ".pull-"))
		const driver = Layer.effect(
			Migrate.MigrationDriver,
			Effect.gen(function* () {
				const sql = yield* ClickhouseClient.ClickhouseClient
				return Migrate.fromSqlClient(sql, { command: sql.asCommand })
			}),
		).pipe(Layer.provide(client(database)))
		const config: Kit.KitConfig = { schema: "./schema.ts", out: "./migrations", driver }
		await Effect.runPromise(
			Effect.gen(function* () {
				const admin = yield* ClickhouseClient.ClickhouseClient
				yield* admin.asCommand(admin.unsafe(`CREATE DATABASE ${database}`))
				yield* Effect.gen(function* () {
					const sql = yield* ClickhouseClient.ClickhouseClient
					for (const statement of DDL) yield* sql.asCommand(sql.unsafe(statement))
				}).pipe(Effect.provide(client(database)))

				const pulled = yield* Kit.pull(config, dir, { out: "schema.ts" })
				expect(pulled.tables).toEqual(["events", "scratch", "sink", "states", "totals"])
				expect(pulled.external).toEqual(["recent"])
				expect(pulled.review).toEqual([
					"totals_mv: materialized view not generated; write it with CH.materializedView. Its body: SELECT OrgId, Name, count() AS C FROM events GROUP BY OrgId, Name",
				])

				yield* Kit.generate(config, dir, { baseline: "schema", name: "baseline" })
				expect(yield* Kit.generate(config, dir)).toEqual({ written: undefined, plan: [] })
				const migrations = yield* Kit.readMigrations(join(dir, "migrations"))
				yield* Migrate.run({ migrations }).pipe(Effect.provide(driver))
				// The view and the materialized view are the database's, not the schema's.
				const { drift } = yield* Migrate.verify(migrations).pipe(Effect.provide(driver))
				expect(drift).toEqual([
					{ entity: "recent", problem: "unexpected" },
					{ entity: "totals_mv", problem: "unexpected" },
				])
			}).pipe(
				Effect.ensuring(
					Effect.gen(function* () {
						const admin = yield* ClickhouseClient.ClickhouseClient
						yield* Effect.orDie(admin.asCommand(admin.unsafe(`DROP DATABASE IF EXISTS ${database} SYNC`)))
					}),
				),
				Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
				Effect.provide(client("default")),
			),
		)
	})
})
