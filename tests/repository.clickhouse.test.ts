// `makeRepository` on a live ClickHouse. ClickHouse has no RETURNING, so
// `insert` and `update` are defects there; `insertVoid`, `updateVoid` (a
// mutation that waits), `findById` and `delete` (a lightweight delete that
// waits) work. Creates one table in a throwaway database.

import { ClickhouseClient } from "@effect/sql-clickhouse"
import { Cause, Effect, Exit, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as Db from "@maple-dev/effect-orm/database"
import { endpoint } from "./clickhouse-support"

const user = process.env.EFFECT_ORM_CLICKHOUSE_USER ?? "default"
const password = process.env.EFFECT_ORM_CLICKHOUSE_PASSWORD ?? ""

const Tickets = CH.table("tickets", {
	external: true,
	tenantColumn: "OrgId",
	columns: { OrgId: CH.string, Id: CH.uint64, Title: CH.string, Seats: CH.column(CH.uint32, { default: 1 }) },
})

const withRepository = <A, E>(
	body: (repo: Db.RepositoryOf<typeof Tickets, "Id", "OrgId">, sent: Array<string>) => Effect.Effect<A, E, Db.Database>,
) =>
	Effect.gen(function* () {
		const database = `eo_repository_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
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
				Db.sql`CREATE TABLE tickets (OrgId String, Id UInt64, Title String, Seats UInt32 DEFAULT 1) ENGINE = MergeTree ORDER BY (OrgId, Id)`,
			)
			return yield* Effect.gen(function* () {
				const repo = yield* Db.makeRepository(Tickets, { idColumn: "Id", tenantColumn: "OrgId" })
				return yield* body(repo, sent)
			}).pipe(Effect.provideService(Db.Database, db))
		}).pipe(
			Effect.provide(ClickhouseClient.layer({ url: endpoint!, username: user, password, database })),
			Effect.ensuring(Effect.orDie(admin.asCommand(admin.unsafe(`DROP DATABASE IF EXISTS ${database} SYNC`)))),
		)
	}).pipe(Effect.provide(ClickhouseClient.layer({ url: endpoint!, username: user, password, database: "default" })))

describe.skipIf(!endpoint)("makeRepository on live ClickHouse", () => {
	it("inserts, finds, updates and deletes only within the tenant", async () => {
		const result = await Effect.runPromise(
			withRepository((repo, sent) =>
				Effect.gen(function* () {
					yield* repo.insertVoid("a", { Id: 1, Title: "Board" })
					const found = yield* repo.findById("a", 1)
					const otherTenant = yield* repo.findById("b", 1)
					yield* repo.updateVoid("b", 1, { Title: "Stolen" })
					yield* repo.updateVoid("a", 1, { Title: "Renamed", Seats: 4 })
					const updated = yield* repo.findById("a", 1)
					yield* repo.delete("b", 1)
					const afterOtherDelete = yield* repo.findById("a", 1)
					yield* repo.delete("a", 1)
					const deleted = yield* repo.findById("a", 1)
					return { found, otherTenant, updated, afterOtherDelete, deleted, sent: [...sent] }
				}),
			),
		)
		expect(result.found).toEqual(Option.some({ OrgId: "a", Id: 1, Title: "Board", Seats: 1 }))
		expect(result.otherTenant).toEqual(Option.none())
		expect(result.updated).toEqual(Option.some({ OrgId: "a", Id: 1, Title: "Renamed", Seats: 4 }))
		expect(Option.isSome(result.afterOtherDelete)).toBe(true)
		expect(result.deleted).toEqual(Option.none())
		expect(result.sent.find((sql) => sql.startsWith("ALTER TABLE"))).toMatch(/SETTINGS mutations_sync = 2$/)
		expect(result.sent.find((sql) => sql.startsWith("DELETE"))).toMatch(/SETTINGS lightweight_deletes_sync = 2$/)
	})

	it("insert and update need RETURNING, which ClickHouse has not: a defect, and nothing is written", async () => {
		const { inserted, updated, rows } = await Effect.runPromise(
			withRepository((repo) =>
				Effect.gen(function* () {
					const inserted = yield* Effect.exit(repo.insert("a", { Id: 2, Title: "x" }))
					const updated = yield* Effect.exit(repo.update("a", 2, { Title: "y" }))
					return { inserted, updated, rows: yield* repo.findById("a", 2) }
				}),
			),
		)
		for (const exit of [inserted, updated] as Array<Exit.Exit<unknown, unknown>>) {
			expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
			expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : "")).toMatch(/no RETURNING clause/)
		}
		expect(rows).toEqual(Option.none())
	})
})
