// Request batching: `findById` and `findAllBy` turn N concurrent lookups into
// one `WHERE key IN (...)` statement. Counted on PGlite through `observe`.

import { PgliteClient } from "@effect/sql-pglite"
import { assert, expect, layer } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Result } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as CH from "../ch/index"
import * as PG from "../postgres"
import { postgresDialect } from "../pg/dialect"
import * as Db from "../database"

const statements: Array<string> = []

const DatabaseLive = Layer.effect(
	Db.Database,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		return Db.fromSqlClient(sql, {
			dialect: postgresDialect,
			observe: (statement) => Effect.sync(() => void statements.push(statement.sql)),
		})
	}),
).pipe(Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })))

const Users = PG.table("users", {
	columns: { id: PG.int4, org: PG.text, name: PG.text },
	primaryKey: ["id"],
	tenantColumn: "org",
})

const Live = Layer.effectDiscard(
	Effect.gen(function* () {
		yield* Db.execute(Db.sql`CREATE TABLE users (id int4 PRIMARY KEY, org text NOT NULL, name text NOT NULL)`)
		yield* Db.execute(Db.sql`INSERT INTO users VALUES (1, 'a', 'Ann'), (2, 'a', 'Bob'), (3, 'b', 'Cy')`)
	}),
).pipe(Layer.provideMerge(DatabaseLive))

/** Run `effect` and return the statements it sent. */
const counted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		statements.length = 0
		const value = yield* effect
		return { value, sent: [...statements] }
	})

layer(Live, { excludeTestServices: true })("Request batching on PGlite", (it) => {
	it.effect("findById sends one statement for N concurrent lookups and decodes each row", () =>
		Effect.gen(function* () {
			const userById = Db.findById(CH.from(Users).select("id", "name").crossTenant(), { key: "id" })
			const { value, sent } = yield* counted(Effect.forEach([1, 2, 3], userById, { concurrency: "unbounded" }))
			expect(value).toEqual([
				{ id: 1, name: "Ann" },
				{ id: 2, name: "Bob" },
				{ id: 3, name: "Cy" },
			])
			assert.strictEqual(sent.length, 1)
			expect(sent[0]).toContain(" IN (")
		}),
	)

	it.effect("findById fails a missing key with NoSuchElementError and sends a repeated key once", () =>
		Effect.gen(function* () {
			const userById = Db.findById(CH.from(Users).select("id", "name").crossTenant(), { key: "id" })
			const { value, sent } = yield* counted(
				Effect.forEach([1, 1, 9], (id) => Effect.result(userById(id)), { concurrency: "unbounded" }),
			)
			assert(Result.isSuccess(value[0]) && Result.isSuccess(value[1]))
			expect(value[1].success).toEqual({ id: 1, name: "Ann" })
			assert(Result.isFailure(value[2]))
			expect(value[2].failure).toBeInstanceOf(Cause.NoSuchElementError)
			assert.strictEqual(sent.length, 1)
			expect(sent[0]).toMatch(/IN \(\$1, \$2\)/)
		}),
	)

	it.effect("one batch never mixes tenants: each params value gets its own single-tenant statement", () =>
		Effect.gen(function* () {
			const strict = Db.fromSqlClient(yield* SqlClient.SqlClient, {
				dialect: postgresDialect,
				requireTenantScope: true,
				observe: (statement) => Effect.sync(() => void statements.push(statement.sql)),
			})
			const inOrg = CH.from(Users)
				.select("id", "name")
				.where(($) => [$.org.eq(CH.param.string("org"))])
			const userById = Db.findById(inOrg, { key: "id" })
			const lookups = [
				userById.with({ org: "a" })(1),
				userById.with({ org: "b" })(3),
				userById.with({ org: "a" })(2),
				// Another tenant's row is not found, even with its id.
				Effect.flip(userById.with({ org: "b" })(1)),
			] as const
			const { value, sent } = yield* counted(
				Effect.all(lookups, { concurrency: "unbounded" }).pipe(Effect.provideService(Db.Database, strict)),
			)
			expect(value.slice(0, 3)).toEqual([
				{ id: 1, name: "Ann" },
				{ id: 3, name: "Cy" },
				{ id: 2, name: "Bob" },
			])
			expect(value[3]).toBeInstanceOf(Cause.NoSuchElementError)
			assert.strictEqual(sent.length, 2)

			// Without a tenant filter, requireTenantScope refuses the batch statement.
			const unscoped = Db.findById(CH.from(Users).select("id", "name"), { key: "id" })
			const exit = yield* Effect.exit(unscoped(1).pipe(Effect.provideService(Db.Database, strict)))
			assert(Exit.isFailure(exit))
			expect(Cause.squash(exit.cause)).toBeInstanceOf(Db.TenantScopeViolation)
		}),
	)

	it.effect("a lookup inside a transaction never shares a batch with one outside it", () =>
		Effect.gen(function* () {
			const userById = Db.findById(CH.from(Users).select("id", "name").crossTenant(), { key: "id" })
			const { value, sent } = yield* counted(
				Effect.all([Db.transaction(userById(1)), userById(2)], { concurrency: "unbounded" }),
			)
			expect(value).toEqual([
				{ id: 1, name: "Ann" },
				{ id: 2, name: "Bob" },
			])
			assert.strictEqual(sent.length, 2)
		}),
	)

	it.effect("findAllBy groups every row under its key, and a key with no rows gets an empty array", () =>
		Effect.gen(function* () {
			const usersInOrg = Db.findAllBy(CH.from(Users).select("id", "org").orderBy(["id", "asc"]).crossTenant(), { key: "org" })
			const { value, sent } = yield* counted(Effect.forEach(["a", "b", "z"], usersInOrg, { concurrency: "unbounded" }))
			expect(value).toEqual([
				[
					{ id: 1, org: "a" },
					{ id: 2, org: "a" },
				],
				[{ id: 3, org: "b" }],
				[],
			])
			assert.strictEqual(sent.length, 1)
		}),
	)

	it.effect("refuses a query with limit or offset, which would apply to the whole batch", () =>
		Effect.gen(function* () {
			const firstUser = Db.findById(CH.from(Users).select("id", "name").limit(1).crossTenant(), { key: "id" })
			const { value, sent } = yield* counted(Effect.flip(firstUser(1)))
			expect(value).toBeInstanceOf(CH.QueryBuilderError)
			assert.strictEqual(sent.length, 0)
		}),
	)
})
