// Seeding from column Schemas: rows offline, and inserts on PGlite (Postgres 17
// in WASM) through the `Database` the rest of the package uses.

import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it, layer } from "@effect/vitest"
import { Arbitrary, DateTime, Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as CH from "../clickhouse"
import * as PG from "../postgres"
import { postgresDialect } from "../pg/dialect"
import * as Db from "../database"
import * as Seed from "../seed"

const Users = PG.table("users", {
	columns: {
		id: PG.uuid,
		org_id: PG.text,
		email: PG.column(PG.text, { unique: true }),
		age: PG.int2,
		score: PG.float4,
		joined: PG.timestamptz,
		bio: PG.nullable(PG.text),
		tags: PG.array(PG.text),
		created_at: PG.column(PG.timestamptz, { defaultExpr: "now()" }),
	},
	primaryKey: ["id"],
	tenantColumn: "org_id",
})

const Orgs = PG.table("orgs", { columns: { id: PG.text, name: PG.text }, primaryKey: ["id"] })

describe("Seed.rows", () => {
	it.effect("the same seed gives the same rows, and another seed other rows", () =>
		Effect.gen(function* () {
			const a = yield* Seed.rows(Orgs, { count: 5, seed: 1 })
			const b = yield* Seed.rows(Orgs, { count: 5, seed: 1 })
			const c = yield* Seed.rows(Orgs, { count: 5, seed: 2 })
			expect(a).toEqual(b)
			expect(a).not.toEqual(c)
			expect(a).toHaveLength(5)
		}),
	)

	it.effect("a new column leaves the values of the others unchanged", () =>
		Effect.gen(function* () {
			const Wider = PG.table("orgs", { columns: { id: PG.text, name: PG.text, plan: PG.int4 }, primaryKey: ["id"] })
			const before = yield* Seed.rows(Orgs, { count: 4, seed: "s" })
			const after = yield* Seed.rows(Wider, { count: 4, seed: "s" })
			expect(after.map(({ id, name }) => ({ id, name }))).toEqual(before)
		}),
	)

	it.effect("values fit the column type's storage range", () =>
		Effect.gen(function* () {
			const Numbers = CH.table("numbers", {
				columns: { u8: CH.uint8, i32: CH.int32, at: CH.dateTime, at64: CH.dateTime64 },
				engine: CH.engine.mergeTree(),
				orderBy: [],
			})
			const rows = yield* Seed.rows(Numbers, { count: 200, seed: 3 })
			for (const row of rows) {
				expect(Number.isInteger(row.u8) && row.u8 >= 0 && row.u8 <= 255).toBe(true)
				expect(Number.isInteger(row.i32) && row.i32 >= -(2 ** 31) && row.i32 < 2 ** 31).toBe(true)
				const at = DateTime.toEpochMillis(row.at)
				expect(at % 1000).toBe(0)
				expect(at >= 0 && at <= Date.UTC(2106, 1, 7, 6, 28, 15)).toBe(true)
				const at64 = DateTime.toEpochMillis(row.at64)
				expect(at64 >= Date.UTC(1900, 0, 1) && at64 <= Date.UTC(2299, 11, 31, 23, 59, 59, 999)).toBe(true)
			}
		}),
	)

	it.effect("a branded column gets only values of its brand", () =>
		Effect.gen(function* () {
			const Slug = Schema.String.check(Schema.isPattern(/^[a-z]{3,8}$/)).pipe(Schema.brand("Slug"))
			const Pages = PG.table("pages", { columns: { slug: PG.brand(PG.text, Slug) }, primaryKey: ["slug"] })
			const rows = yield* Seed.rows(Pages, { count: 20, seed: 4 })
			for (const row of rows) expect(row.slug).toMatch(/^[a-z]{3,8}$/)
		}),
	)

	it.effect("a primary key, a unique column and a `unique` option get distinct values", () =>
		Effect.gen(function* () {
			const rows = yield* Seed.rows(Users, { count: 50, seed: 5, tenant: "org_1", unique: ["age"] })
			expect(new Set(rows.map((row) => row.id)).size).toBe(50)
			expect(new Set(rows.map((row) => row.email)).size).toBe(50)
			expect(new Set(rows.map((row) => row.age)).size).toBe(50)
		}),
	)

	it.effect("a unique column with too few values is a SeedError", () =>
		Effect.gen(function* () {
			const Flags = PG.table("flags", { columns: { on: PG.bool }, primaryKey: ["on"] })
			const error = yield* Effect.flip(Seed.rows(Flags, { count: 3 }))
			expect(error).toBeInstanceOf(Seed.SeedError)
			expect(error.column).toBe("on")
		}),
	)

	it.effect("overrides: a value, an Arbitrary, and a function of the row index", () =>
		Effect.gen(function* () {
			const rows = yield* Seed.rows(Users, {
				count: 3,
				tenant: "org_1",
				columns: {
					email: (i) => `user${i}@example.com`,
					age: Seed.pick([20, 30] as const),
					bio: null,
				},
			})
			expect(rows.map((row) => row.email)).toEqual(["user0@example.com", "user1@example.com", "user2@example.com"])
			for (const row of rows) {
				expect([20, 30]).toContain(row.age)
				expect(row.bio).toBeNull()
				expect(row.org_id).toBe("org_1")
			}
		}),
	)

	it.effect("a defaulted column is left to the database unless it has an override", () =>
		Effect.gen(function* () {
			const [plain] = yield* Seed.rows(Users, { count: 1, tenant: "org_1" })
			expect(plain).not.toHaveProperty("created_at")
			const at = DateTime.makeUnsafe("2026-01-01T00:00:00Z")
			const [given] = yield* Seed.rows(Users, { count: 1, tenant: "org_1", columns: { created_at: at } })
			expect(given?.created_at).toEqual(at)
		}),
	)

	it.effect("a tenanted table needs `tenant` or `crossTenant`", () =>
		Effect.gen(function* () {
			const missing = yield* Effect.flip(Seed.rows(Users, { count: 1 }))
			expect(missing.message).toMatch(/tenant column org_id/)
			const spread = yield* Seed.rows(Users, { count: 20, seed: 6, crossTenant: true })
			expect(new Set(spread.map((row) => row.org_id)).size).toBeGreaterThan(1)
			const both = yield* Effect.flip(Seed.rows(Users, { count: 1, tenant: "org_1", crossTenant: true }))
			expect(both).toBeInstanceOf(Seed.SeedError)
			const wrongType = yield* Effect.flip(Seed.rows(Users, { count: 1, tenant: 1 }))
			expect(wrongType.column).toBe("org_id")
		}),
	)

	it.effect("an override that is not a value of the column is a SeedError", () =>
		Effect.gen(function* () {
			// @ts-expect-error -- name is text
			const constant = yield* Effect.flip(Seed.rows(Orgs, { count: 1, columns: { name: 1 } }))
			expect(constant.column).toBe("name")
			const fromIndex = yield* Effect.flip(Seed.rows(Orgs, { count: 2, columns: { name: (i) => (i === 1 ? (3 as never) : "a") } }))
			expect(fromIndex.column).toBe("name")
		}),
	)

	it.effect("a column whose Schema has no arbitrary is a SeedError naming it", () =>
		Effect.gen(function* () {
			const Opaque = CH.custom("Opaque", Schema.declare((u): u is symbol => typeof u === "symbol"))
			const Things = CH.table("things", { columns: { id: CH.string, blob: Opaque }, engine: CH.engine.mergeTree(), orderBy: [] })
			const error = yield* Effect.flip(Seed.rows(Things, { count: 1 }))
			expect(error.column).toBe("blob")
			const given = yield* Seed.rows(Things, { count: 1, columns: { blob: Symbol.for("x") } })
			expect(given[0]?.blob).toBe(Symbol.for("x"))
		}),
	)

	it.effect("count must be a non-negative integer", () =>
		Effect.gen(function* () {
			expect(yield* Seed.rows(Orgs, { count: 0 })).toEqual([])
			expect(yield* Effect.flip(Seed.rows(Orgs, { count: -1 }))).toBeInstanceOf(Seed.SeedError)
		}),
	)
})

describe("Seed.arbitrary", () => {
	it.effect("drives a property test with whole rows", () =>
		Effect.gen(function* () {
			const rows = yield* Seed.arbitrary(Users, { tenant: "org_1" })
			const result = yield* Arbitrary.checkEffect(rows, (row) => row.org_id === "org_1" && row.age >= -32768, {
				runs: 50,
				seed: 7,
			})
			expect(result._tag).toBe("Passed")
		}),
	)
})

const statements: Array<string> = []
const Live = Layer.effect(
	Db.Database,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		return Db.fromSqlClient(sql, {
			dialect: postgresDialect,
			requireTenantScope: true,
			observe: (statement) => Effect.sync(() => void statements.push(statement.sql)),
		})
	}),
).pipe(Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })))

layer(Live, { excludeTestServices: true })("Seed.insert on PGlite", (it) => {
	it.effect("inserts the rows in batches, and they read back as seeded", () =>
		Effect.gen(function* () {
			yield* Db.execute(
				Db.sql`CREATE TABLE users (id uuid PRIMARY KEY, org_id text NOT NULL, email text NOT NULL UNIQUE, age int2 NOT NULL,
					score float4 NOT NULL, joined timestamptz NOT NULL, bio text, tags text[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
			)
			statements.length = 0
			const seeded = yield* Seed.insert(Users, { count: 25, seed: 8, tenant: "org_1", batchSize: 10 })
			expect(statements.filter((sql) => sql.startsWith("INSERT"))).toHaveLength(3)
			const read = yield* Db.run(
				PG.from(Users)
					.select("id", "email", "age", "joined", "bio", "tags")
					.where(($) => [$.org_id.eq("org_1")]),
			)
			const byId = new Map(read.map((row) => [row.id, row]))
			expect(byId.size).toBe(25)
			for (const row of seeded) {
				const back = byId.get(row.id)!
				expect(back.email).toBe(row.email)
				expect(back.age).toBe(row.age)
				expect(back.bio).toBe(row.bio)
				expect(back.tags).toEqual(row.tags)
				expect(DateTime.toEpochMillis(back.joined)).toBe(DateTime.toEpochMillis(row.joined))
			}
		}),
	)

	it.effect("a child table picks its foreign keys from the parent's seeded rows", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`CREATE TABLE orgs (id text PRIMARY KEY, name text NOT NULL)`)
			yield* Db.execute(Db.sql`CREATE TABLE members (id int4 PRIMARY KEY, org_id text NOT NULL REFERENCES orgs (id))`)
			const Members = PG.table("members", { columns: { id: PG.int4, org_id: PG.text }, primaryKey: ["id"], tenantColumn: "org_id" })
			const orgs = yield* Seed.insert(Orgs, { count: 3, seed: 9 })
			const ids = orgs.map((org) => org.id) as [string, ...Array<string>]
			const members = yield* Seed.insert(Members, { count: 12, seed: 9, crossTenant: true, columns: { org_id: Seed.pick(ids) } })
			for (const member of members) expect(ids).toContain(member.org_id)
		}),
	)

	it.effect("every built-in Postgres type gets values the server stores, which read back as seeded", () =>
		Effect.gen(function* () {
			const Channel = PG.enumType("channel", ["sms", "email"])
			const Wide = PG.table("wide", {
				columns: {
					id: PG.int8,
					ok: PG.bool,
					ratio: PG.float8,
					amount: PG.numeric,
					at_ms: PG.timestamptzMillis,
					channel: Channel,
					channels: PG.array(Channel),
					maybe: PG.array(PG.nullable(PG.int4)),
					doc: PG.jsonb(),
				},
				primaryKey: ["id"],
			})
			yield* Db.execute(Db.sql`CREATE TYPE channel AS ENUM ('sms', 'email')`)
			yield* Db.execute(
				Db.sql`CREATE TABLE wide (id int8 PRIMARY KEY, ok boolean NOT NULL, ratio float8 NOT NULL, amount numeric NOT NULL,
					at_ms timestamptz NOT NULL, channel channel NOT NULL, channels channel[] NOT NULL, maybe int4[] NOT NULL, doc jsonb NOT NULL)`,
			)
			const seeded = yield* Seed.insert(Wide, { count: 40, seed: 10 })
			const read = yield* Db.run(PG.from(Wide).select("id", "ok", "ratio", "amount", "at_ms", "channel", "channels", "maybe", "doc"))
			const byId = new Map(read.map((row) => [row.id, row]))
			for (const row of seeded) expect(byId.get(row.id)).toEqual(row)
		}),
	)

	it.effect("batchSize must be a positive integer", () =>
		Effect.gen(function* () {
			expect(yield* Effect.flip(Seed.insert(Orgs, { count: 1, batchSize: 0 }))).toBeInstanceOf(Seed.SeedError)
		}),
	)
})
