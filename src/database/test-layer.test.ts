// `layerTest`: a `Database` with no server. It records each statement it is
// given and answers with the rows the test supplies, so the real compile,
// decode, tenant-scope and transaction code runs above it.

import { assert, describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { SqlError, UniqueViolation } from "effect/sql/SqlError"
import * as CH from "../ch/index"
import * as PG from "../postgres"
import * as Db from "../database"

const Accounts = PG.table("accounts", { columns: { id: PG.int4, org: PG.text, balance: PG.int8 }, primaryKey: ["id"] })

const balanceOf = (org: string) =>
	Db.run(
		PG.from(Accounts)
			.select("id", "balance")
			.where(($) => [$.org.eq(org)]),
	)

describe("layerTest", () => {
	it.effect("run sends the compiled statement and decodes the given rows with the query's row schema", () =>
		Effect.gen(function* () {
			const test = yield* Db.TestDatabase
			yield* test.reply([{ id: 1, balance: "42" }])
			expect(yield* balanceOf("org_1")).toEqual([{ id: 1, balance: 42 }])
			const [sent] = yield* test.statements
			expect(sent?.parameters).toEqual(["org_1"])
			expect(sent?.sql).toContain('"accounts"."org" = $1')
		}).pipe(Effect.provide(Db.layerTest({ dialect: PG.postgresDialect }))),
	)
	it.effect("a given row that does not match the row schema fails as it would from a server", () =>
		Effect.gen(function* () {
			const test = yield* Db.TestDatabase
			yield* test.reply([{ id: 1, balance: "not a number" }])
			const error = yield* Effect.flip(balanceOf("org_1"))
			expect(error).toBeInstanceOf(CH.CompiledQueryDecodeError)
		}).pipe(Effect.provide(Db.layerTest({ dialect: PG.postgresDialect }))),
	)
	it.effect("a transaction records BEGIN and COMMIT, or ROLLBACK, and they take no reply", () =>
		Effect.gen(function* () {
			const test = yield* Db.TestDatabase
			yield* test.reply([{ id: 1, balance: "5" }])
			expect(yield* Db.transaction(balanceOf("org_1"))).toEqual([{ id: 1, balance: 5 }])
			class Refused {
				readonly _tag = "Refused"
			}
			const refused = yield* Effect.flip(
				Db.transaction(Effect.andThen(Db.execute(Db.sql`UPDATE accounts SET balance = 0`), Effect.fail(new Refused()))),
			)
			expect(refused).toBeInstanceOf(Refused)
			const sent = (yield* test.statements).map((statement) => statement.sql.split(/\s/)[0])
			expect(sent).toEqual(["BEGIN", "SELECT", "COMMIT", "BEGIN", "UPDATE", "ROLLBACK"])
		}).pipe(Effect.provide(Db.layerTest({ dialect: PG.postgresDialect }))),
	)
	it.effect("a given driver error becomes the DatabaseError a real driver's would", () =>
		Effect.gen(function* () {
			const test = yield* Db.TestDatabase
			const duplicate = new SqlError({
				reason: new UniqueViolation({ cause: { code: "23505" }, message: "duplicate key value", constraint: "accounts_pkey" }),
			})
			yield* test.reply(duplicate)
			const error = yield* Effect.flip(Db.execute(Db.sql`INSERT INTO accounts VALUES (${1}, ${"org_1"}, ${0})`))
			expect(error).toBeInstanceOf(Db.DatabaseError)
			expect(error.reason).toBe("UniqueViolation")
			expect(error.sqlState).toBe("23505")
			expect(yield* test.statements).toEqual([{ sql: "INSERT INTO accounts VALUES ($1, $2, $3)", parameters: [1, "org_1", 0] }])
		}).pipe(Effect.provide(Db.layerTest({ dialect: PG.postgresDialect }))),
	)

	it.effect("respond answers every statement that has no queued reply", () =>
		Effect.gen(function* () {
			const respond = (statement: Db.TestStatement) => (statement.parameters[0] === "org_1" ? [{ id: 1, balance: "7" }] : [])
			const rows = yield* Effect.all([balanceOf("org_1"), balanceOf("org_2")]).pipe(
				Effect.provide(Db.layerTest({ dialect: PG.postgresDialect, respond })),
			)
			expect(rows).toEqual([[{ id: 1, balance: 7 }], []])
		}),
	)
	it.effect("requireTenantScope refuses an unscoped query before anything is sent", () =>
		Effect.gen(function* () {
			const test = yield* Db.TestDatabase
			const Tenanted = PG.table("accounts", { columns: { id: PG.int4, org: PG.text }, primaryKey: ["id"], tenantColumn: "org" })
			const exit = yield* Effect.exit(Db.run(PG.from(Tenanted).select("id")))
			assert(Exit.isFailure(exit))
			expect(Cause.squash(exit.cause)).toBeInstanceOf(Db.TenantScopeViolation)
			expect(yield* Db.run(PG.from(Tenanted).select("id").where(($) => [$.org.eq("org_1")]))).toEqual([])
			expect(yield* test.statements).toHaveLength(1)
		}).pipe(Effect.provide(Db.layerTest({ dialect: PG.postgresDialect, requireTenantScope: true }))),
	)

	it.effect("on ClickHouse a transaction fails with TransactionUnsupported and sends nothing", () =>
		Effect.gen(function* () {
			const test = yield* Db.TestDatabase
			const error = yield* Effect.flip(Db.transaction(Db.execute(Db.sql`SELECT 1`)))
			expect(error).toBeInstanceOf(Db.TransactionUnsupported)
			expect(yield* test.statements).toEqual([])
		}).pipe(Effect.provide(Db.layerTest({ dialect: CH.clickhouseDialect }))),
	)

	it.effect("reset forgets the recorded statements and the queued replies", () =>
		Effect.gen(function* () {
			const test = yield* Db.TestDatabase
			yield* test.reply([{ id: 1, balance: "1" }])
			yield* Db.execute(Db.sql`SELECT 1`)
			yield* test.reply([{ id: 2, balance: "2" }])
			yield* test.reset
			expect(yield* test.statements).toEqual([])
			expect(yield* balanceOf("org_1")).toEqual([])
		}).pipe(Effect.provide(Db.layerTest({ dialect: PG.postgresDialect }))),
	)
})
