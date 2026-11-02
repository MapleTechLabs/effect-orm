// Relational reads (`defineRelations`, `findMany`) on PGlite: one statement per
// level of `with`, rows decoded through each level's own row codec.

import { PgliteClient } from "@effect/sql-pglite"
import { assert, expect, layer } from "@effect/vitest"
import { Cause, DateTime, Effect, Exit, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as PG from "../postgres"
import { postgresDialect } from "../pg/dialect"
import * as Db from "../database"

const statements: Array<string> = []

const Live = Layer.effect(
	Db.Database,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		return Db.fromSqlClient(sql, {
			dialect: postgresDialect,
			observe: (statement) => Effect.sync(() => void statements.push(statement.sql)),
		})
	}),
).pipe(Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })))

const Users = PG.table("users", { columns: { id: PG.int4, name: PG.text }, primaryKey: ["id"] })
const Posts = PG.table("posts", {
	columns: { id: PG.int4, authorId: PG.column(PG.int4, { name: "author_id" }), title: PG.text },
	primaryKey: ["id"],
})

const schema = Db.defineRelations({ users: Users, posts: Posts }, (r) => ({
	users: { posts: r.many("posts", { from: "id", to: "authorId" }) },
	posts: { author: r.one("users", { from: "authorId", to: "id" }) },
}))

const setup = Effect.gen(function* () {
	yield* Db.execute(Db.sql`CREATE TABLE users (id int4 PRIMARY KEY, name text NOT NULL)`)
	yield* Db.execute(Db.sql`CREATE TABLE posts (id int4 PRIMARY KEY, author_id int4 NOT NULL, title text NOT NULL)`)
	yield* Db.execute(Db.sql`INSERT INTO users VALUES (1, 'ada'), (2, 'bob'), (3, 'cy')`)
	yield* Db.execute(Db.sql`INSERT INTO posts VALUES (10, 1, 'a1'), (11, 1, 'a2'), (12, 2, 'b1')`)
})

layer(Live, { excludeTestServices: true })("findMany on PGlite", (it) => {
	it.effect("loads a many relation and a nested one, one statement per level", () =>
		Effect.gen(function* () {
			yield* setup
			statements.length = 0
			const users = yield* Db.findMany(schema.users, {
				orderBy: ($) => [[$.id, "asc"]],
				with: { posts: { orderBy: ($) => [[$.id, "asc"]], with: { author: true } } },
			})
			expect(users).toEqual([
				{
					id: 1,
					name: "ada",
					posts: [
						{ id: 10, authorId: 1, title: "a1", author: { id: 1, name: "ada" } },
						{ id: 11, authorId: 1, title: "a2", author: { id: 1, name: "ada" } },
					],
				},
				{ id: 2, name: "bob", posts: [{ id: 12, authorId: 2, title: "b1", author: { id: 2, name: "bob" } }] },
				{ id: 3, name: "cy", posts: [] },
			])
			expect(statements).toHaveLength(3)
			expect(statements[1]).toMatch(/IN \(/)
		}),
	)

	it.effect("a one relation is null when no row matches, and an empty level sends nothing", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`INSERT INTO posts VALUES (13, 99, 'orphan')`)
			const orphan = yield* Db.findMany(schema.posts, { where: ($) => [$.id.eq(13)], with: { author: true } })
			expect(orphan).toEqual([{ id: 13, authorId: 99, title: "orphan", author: null }])
			statements.length = 0
			const none = yield* Db.findMany(schema.users, { where: ($) => [$.id.eq(404)], with: { posts: true } })
			expect(none).toEqual([])
			expect(statements).toHaveLength(1)
		}),
	)

	it.effect("a nested where filters that level only", () =>
		Effect.gen(function* () {
			const users = yield* Db.findMany(schema.users, {
				where: ($) => [$.id.in_(1, 2)],
				orderBy: ($) => [[$.id, "asc"]],
				with: { posts: { where: ($) => [$.title.eq("a2")] } },
			})
			expect(users.map((user) => [user.name, user.posts.map((post) => post.title)])).toEqual([
				["ada", ["a2"]],
				["bob", []],
			])
		}),
	)

	it.effect("nested rows decode through their column codecs", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`CREATE TABLE events (id int4 PRIMARY KEY, user_id int4 NOT NULL, at timestamptz NOT NULL)`)
			yield* Db.execute(Db.sql`INSERT INTO events VALUES (1, 1, '2026-01-02T03:04:05Z')`)
			const Events = PG.table("events", {
				columns: { id: PG.int4, userId: PG.column(PG.int4, { name: "user_id" }), at: PG.timestamptz },
				primaryKey: ["id"],
			})
			const withEvents = Db.defineRelations({ users: Users, events: Events }, (r) => ({
				users: { events: r.many("events", { from: "id", to: "userId" }) },
			}))
			const [ada] = yield* Db.findMany(withEvents.users, { where: ($) => [$.id.eq(1)], with: { events: true } })
			const at = ada!.events[0]!.at
			assert(DateTime.isDateTime(at))
			expect(DateTime.formatIso(at)).toBe("2026-01-02T03:04:05.000Z")
		}),
	)
})

// Tenant scope on every level: a separate database that refuses unscoped statements.
const Orgs = PG.table("orgs", { columns: { id: PG.text }, primaryKey: ["id"] })
const Units = PG.table("units", {
	columns: { id: PG.int4, orgId: PG.column(PG.text, { name: "org_id" }) },
	primaryKey: ["id"],
	tenantColumn: "orgId",
})
const Locks = PG.table("locks", {
	columns: { id: PG.int4, orgId: PG.column(PG.text, { name: "org_id" }), unitId: PG.column(PG.int4, { name: "unit_id" }) },
	primaryKey: ["id"],
	tenantColumn: "orgId",
})
const tenancy = Db.defineRelations({ orgs: Orgs, units: Units, locks: Locks }, (r) => ({
	orgs: { units: r.many("units", { from: "id", to: "orgId" }) },
	units: { locks: r.many("locks", { from: "id", to: "unitId" }) },
}))

const Scoped = Layer.effect(
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

const tenantSetup = Effect.gen(function* () {
	yield* Db.execute(Db.sql`CREATE TABLE orgs (id text PRIMARY KEY)`)
	yield* Db.execute(Db.sql`CREATE TABLE units (id int4 PRIMARY KEY, org_id text NOT NULL)`)
	yield* Db.execute(Db.sql`CREATE TABLE locks (id int4 PRIMARY KEY, org_id text NOT NULL, unit_id int4 NOT NULL)`)
	yield* Db.execute(Db.sql`INSERT INTO orgs VALUES ('a'), ('b')`)
	yield* Db.execute(Db.sql`INSERT INTO units VALUES (1, 'a'), (2, 'b')`)
	// Lock 21 points at unit 1 but belongs to org b: bad data a tenant pin must not leak.
	yield* Db.execute(Db.sql`INSERT INTO locks VALUES (10, 'a', 1), (20, 'b', 2), (21, 'b', 1)`)
})

layer(Scoped, { excludeTestServices: true })("findMany tenant scope", (it) => {
	it.effect("a level under one tenant's rows is pinned to that tenant", () =>
		Effect.gen(function* () {
			yield* tenantSetup
			statements.length = 0
			const units = yield* Db.findMany(tenancy.units, { where: ($) => [$.orgId.eq("a")], with: { locks: true } })
			expect(units).toEqual([{ id: 1, orgId: "a", locks: [{ id: 10, orgId: "a", unitId: 1 }] }])
			expect(statements[1]).toMatch(/org_id" = /)
		}),
	)

	it.effect("an unscoped top level is refused before any nested level runs", () =>
		Effect.gen(function* () {
			statements.length = 0
			const exit = yield* Effect.exit(Db.findMany(tenancy.units, { with: { locks: true } }))
			assert(Exit.isFailure(exit))
			expect(Cause.squash(exit.cause)).toBeInstanceOf(Db.TenantScopeViolation)
			expect(statements).toEqual([])
		}),
	)

	it.effect("an untenanted parent gives a tenanted level nothing to pin, so it is refused", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(Db.findMany(tenancy.orgs, { with: { units: true } }))
			assert(Exit.isFailure(exit))
			expect(Cause.squash(exit.cause)).toBeInstanceOf(Db.TenantScopeViolation)
		}),
	)

	it.effect("crossTenant declares every level", () =>
		Effect.gen(function* () {
			const units = yield* Db.findMany(tenancy.units, {
				orderBy: ($) => [[$.id, "asc"]],
				with: { locks: { orderBy: ($) => [[$.id, "asc"]] } },
				crossTenant: true,
			})
			expect(units.map((unit) => unit.locks.map((lock) => lock.id))).toEqual([[10, 21], [20]])
		}),
	)
})
