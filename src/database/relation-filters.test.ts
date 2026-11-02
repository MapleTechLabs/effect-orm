// Relation filters (`some`, `none`, `every`), relation counts, and `_count` in
// `findMany`, on PGlite. The filters are correlated EXISTS subqueries; the
// tenant tests check that the subquery stays inside the outer query's tenant.

import { PgliteClient } from "@effect/sql-pglite"
import { assert, describe, expect, it as plain, layer } from "@effect/vitest"
import { Cause, Effect, Exit, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as PG from "../postgres"
import { postgresDialect } from "../pg/dialect"
import * as Db from "../database"

const statements: Array<string> = []

const live = (requireTenantScope: boolean) =>
	Layer.effect(
		Db.Database,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			return Db.fromSqlClient(sql, {
				dialect: postgresDialect,
				requireTenantScope,
				observe: (statement) => Effect.sync(() => void statements.push(statement.sql)),
			})
		}),
	).pipe(Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })))

const Users = PG.table("users", { columns: { id: PG.int4, name: PG.text }, primaryKey: ["id"] })
const Posts = PG.table("posts", {
	columns: {
		id: PG.int4,
		authorId: PG.column(PG.int4, { name: "author_id" }),
		title: PG.text,
		published: PG.bool,
	},
	primaryKey: ["id"],
})
const Comments = PG.table("comments", {
	columns: { id: PG.int4, postId: PG.column(PG.int4, { name: "post_id" }), body: PG.text },
	primaryKey: ["id"],
})

const schema = Db.defineRelations({ users: Users, posts: Posts, comments: Comments }, (r) => ({
	users: { posts: r.many("posts", { from: "id", to: "authorId" }) },
	posts: {
		author: r.one("users", { from: "authorId", to: "id" }),
		comments: r.many("comments", { from: "id", to: "postId" }),
	},
}))

const setup = Effect.gen(function* () {
	yield* Db.execute(Db.sql`CREATE TABLE users (id int4 PRIMARY KEY, name text NOT NULL)`)
	yield* Db.execute(
		Db.sql`CREATE TABLE posts (id int4 PRIMARY KEY, author_id int4 NOT NULL, title text NOT NULL, published bool NOT NULL)`,
	)
	yield* Db.execute(Db.sql`CREATE TABLE comments (id int4 PRIMARY KEY, post_id int4 NOT NULL, body text NOT NULL)`)
	// ada: one published and one draft post; bob: one published post; cy: none.
	yield* Db.execute(Db.sql`INSERT INTO users VALUES (1, 'ada'), (2, 'bob'), (3, 'cy')`)
	yield* Db.execute(Db.sql`INSERT INTO posts VALUES (10, 1, 'a1', true), (11, 1, 'a2', false), (12, 2, 'b1', true)`)
	yield* Db.execute(Db.sql`INSERT INTO comments VALUES (100, 10, 'nice'), (101, 12, 'ok')`)
})

const names = (rows: ReadonlyArray<{ readonly name: string }>) => rows.map((row) => row.name)

layer(live(false), { excludeTestServices: true })("relation filters on PGlite", (it) => {
	it.effect("some: at least one related row matches", () =>
		Effect.gen(function* () {
			yield* setup
			const any = yield* Db.findMany(schema.users, {
				where: (_, r) => [r.posts.some()],
				orderBy: ($) => [[$.id, "asc"]],
			})
			expect(names(any)).toEqual(["ada", "bob"])
			const drafts = yield* Db.findMany(schema.users, {
				where: (_, r) => [r.posts.some(($) => [$.published.eq(false)])],
			})
			expect(names(drafts)).toEqual(["ada"])
		}),
	)

	it.effect("none: no related row matches", () =>
		Effect.gen(function* () {
			const noPosts = yield* Db.findMany(schema.users, { where: (_, r) => [r.posts.none()] })
			expect(names(noPosts)).toEqual(["cy"])
			const noDrafts = yield* Db.findMany(schema.users, {
				where: (_, r) => [r.posts.none(($) => [$.published.eq(false)])],
				orderBy: ($) => [[$.id, "asc"]],
			})
			expect(names(noDrafts)).toEqual(["bob", "cy"])
		}),
	)

	it.effect("every: all related rows match, and a row with none passes", () =>
		Effect.gen(function* () {
			const allPublished = yield* Db.findMany(schema.users, {
				where: (_, r) => [r.posts.every(($) => [$.published.eq(true)])],
				orderBy: ($) => [[$.id, "asc"]],
			})
			expect(names(allPublished)).toEqual(["bob", "cy"])
		}),
	)

	it.effect("filters nest, through a one relation too", () =>
		Effect.gen(function* () {
			// Users with a post that has a comment.
			const commented = yield* Db.findMany(schema.users, {
				where: (_, r) => [r.posts.some((_, r) => [r.comments.some()])],
				orderBy: ($) => [[$.id, "asc"]],
			})
			expect(names(commented)).toEqual(["ada", "bob"])
			// Posts whose author has a draft.
			const posts = yield* Db.findMany(schema.posts, {
				where: (_, r) => [r.author.some((_, r) => [r.posts.some(($) => [$.published.eq(false)])])],
				orderBy: ($) => [[$.id, "asc"]],
			})
			expect(posts.map((post) => post.id)).toEqual([10, 11])
		}),
	)

	it.effect("a filter applies on a nested level of with", () =>
		Effect.gen(function* () {
			const users = yield* Db.findMany(schema.users, {
				where: ($) => [$.id.eq(1)],
				with: { posts: { where: (_, r) => [r.comments.none()] } },
			})
			expect(users[0]!.posts.map((post) => post.id)).toEqual([11])
		}),
	)

	it.effect("on the builder: related() filters a where and counts in a select", () =>
		Effect.gen(function* () {
			const query = PG.from(Users)
				.select(($) => ({
					name: $.name,
					posts: Db.related(schema.users, $).posts.count(),
					published: Db.related(schema.users, $).posts.count(($) => [$.published.eq(true)]),
				}))
				.where(($) => [Db.related(schema.users, $).posts.none(($) => [$.title.eq("b1")])])
				.orderBy(["name", "asc"])
			const rows = yield* Db.run(query)
			expect(rows).toEqual([
				{ name: "ada", posts: 2, published: 1 },
				{ name: "cy", posts: 0, published: 0 },
			])
		}),
	)

	it.effect("a relation count works in a where", () =>
		Effect.gen(function* () {
			const query = PG.from(Users)
				.select(($) => ({ name: $.name }))
				.where(($) => [Db.related(schema.users, $).posts.count().gte(2)])
			expect(yield* Db.run(query)).toEqual([{ name: "ada" }])
		}),
	)

	it.effect("_count: one grouped statement per counted relation, 0 for none", () =>
		Effect.gen(function* () {
			statements.length = 0
			const users = yield* Db.findMany(schema.users, {
				orderBy: ($) => [[$.id, "asc"]],
				_count: { posts: true },
			})
			expect(users.map((user) => [user.name, user._count.posts])).toEqual([
				["ada", 2],
				["bob", 1],
				["cy", 0],
			])
			expect(statements).toHaveLength(2)
			expect(statements[1]).toMatch(/count\(\*\)/)
			expect(statements[1]).toMatch(/GROUP BY/)
			expect(statements[1]).toMatch(/IN \(/)
		}),
	)

	it.effect("_count takes a where, and works on a nested level", () =>
		Effect.gen(function* () {
			const users = yield* Db.findMany(schema.users, {
				where: ($) => [$.id.eq(1)],
				_count: { posts: { where: ($) => [$.published.eq(true)] } },
				with: { posts: { orderBy: ($) => [[$.id, "asc"]], _count: { comments: true } } },
			})
			expect(users).toEqual([
				{
					id: 1,
					name: "ada",
					_count: { posts: 1 },
					posts: [
						{ id: 10, authorId: 1, title: "a1", published: true, _count: { comments: 1 } },
						{ id: 11, authorId: 1, title: "a2", published: false, _count: { comments: 0 } },
					],
				},
			])
		}),
	)
})

describe("relation filters and the subquery alias", () => {
	plain("a filter on an update's or a delete's unqualified $ is refused, not correlated to itself", () => {
		const query = PG.deleteFrom(Users).where(($) => [Db.related(schema.users, $ as any).posts.none()])
		expect(() => PG.compileUnsafe(query, {})).toThrow(/an update or delete has no alias/)
	})

	const Nodes = PG.table("nodes", {
		columns: { id: PG.int4, parentId: PG.column(PG.nullable(PG.int4), { name: "parent_id" }) },
		primaryKey: ["id"],
	})
	const tree = Db.defineRelations({ nodes: Nodes }, (r) => ({
		nodes: { children: r.many("nodes", { from: "id", to: "parentId" }) },
	}))

	plain("a table related to itself reads the subquery under its own alias", () => {
		const compiled = PG.compileUnsafe(
			PG.from(Nodes)
				.select(($) => ({ id: $.id }))
				.where(($) => [Db.related(tree.nodes, $).children.some()]),
			{},
		)
		expect(compiled.sql).toMatch(/FROM "nodes" AS "nodes__children"\s+WHERE "nodes__children"."parent_id" = "nodes"."id"/)
	})
})

// Tenant scope: the subquery is pinned to the outer row's tenant.
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
const Gateways = PG.table("gateways", {
	columns: { id: PG.int4, lockId: PG.column(PG.int4, { name: "lock_id" }) },
	primaryKey: ["id"],
})
const tenancy = Db.defineRelations({ orgs: Orgs, units: Units, locks: Locks, gateways: Gateways }, (r) => ({
	orgs: { units: r.many("units", { from: "id", to: "orgId" }) },
	units: { locks: r.many("locks", { from: "id", to: "unitId" }) },
	locks: { gateways: r.many("gateways", { from: "id", to: "lockId" }) },
}))

describe("relation filters keep the tenant scope", () => {
	const scope = (query: PG.CHQuery<any, any, any, any>) => PG.compileUnsafe(query, {}).tenantScope

	plain("a filter under a scoped outer query is single-tenant, with the tenant equality in the subquery", () => {
		const query = PG.from(Units)
			.select(($) => ({ id: $.id }))
			.where(($) => [$.orgId.eq("a"), Db.related(tenancy.units, $).locks.some()])
		const compiled = PG.compileUnsafe(query, {})
		expect(compiled.tenantScope).toBe("single-tenant")
		expect(compiled.sql).toContain(`"units__locks"."org_id" = "units"."org_id"`)
	})

	plain("nested filters and counts stay single-tenant", () => {
		expect(
			scope(
				PG.from(Units)
					.select(($) => ({ id: $.id, n: Db.related(tenancy.units, $).locks.count() }))
					.where(($) => [$.orgId.eq("a"), Db.related(tenancy.units, $).locks.some((_, r) => [r.gateways.none()])]),
			),
		).toBe("single-tenant")
	})

	plain("a filter does not scope an unscoped outer query", () => {
		expect(
			scope(
				PG.from(Units)
					.select(($) => ({ id: $.id }))
					.where(($) => [Db.related(tenancy.units, $).locks.some(($) => [$.orgId.eq("a")])]),
			),
		).toBe("cross-tenant")
	})

	plain("a filter from an untenanted table into a tenanted one needs its own tenant equality", () => {
		const orgs = (where: (r: Db.Related<typeof tenancy.orgs.tables, typeof tenancy.orgs.relations, "orgs">) => PG.Condition) =>
			scope(PG.from(Orgs).select(($) => ({ id: $.id })).where(($) => [where(Db.related(tenancy.orgs, $))]))
		expect(orgs((r) => r.units.some())).toBe("cross-tenant")
		expect(orgs((r) => r.units.some(($) => [$.orgId.eq("a")]))).toBe("single-tenant")
	})

	plain("a filter whose own tenant equality names another tenant is cross-tenant", () => {
		expect(
			scope(
				PG.from(Units)
					.select(($) => ({ id: $.id }))
					.where(($) => [$.orgId.eq("a"), Db.related(tenancy.units, $).locks.some(($) => [$.orgId.eq("b")])]),
			),
		).toBe("cross-tenant")
	})
})

layer(live(true), { excludeTestServices: true })("relation filters under requireTenantScope", (it) => {
	const tenantSetup = Effect.gen(function* () {
		yield* Db.execute(Db.sql`CREATE TABLE orgs (id text PRIMARY KEY)`)
		yield* Db.execute(Db.sql`CREATE TABLE units (id int4 PRIMARY KEY, org_id text NOT NULL)`)
		yield* Db.execute(Db.sql`CREATE TABLE locks (id int4 PRIMARY KEY, org_id text NOT NULL, unit_id int4 NOT NULL)`)
		yield* Db.execute(Db.sql`CREATE TABLE gateways (id int4 PRIMARY KEY, lock_id int4 NOT NULL)`)
		yield* Db.execute(Db.sql`INSERT INTO orgs VALUES ('a'), ('b')`)
		yield* Db.execute(Db.sql`INSERT INTO units VALUES (1, 'a'), (2, 'a'), (3, 'b')`)
		// Lock 21 points at unit 2 but belongs to org b: bad data the tenant equality must not count.
		yield* Db.execute(Db.sql`INSERT INTO locks VALUES (10, 'a', 1), (11, 'a', 1), (21, 'b', 2), (30, 'b', 3)`)
	})

	it.effect("filters and _count run scoped, and a row of another tenant does not match", () =>
		Effect.gen(function* () {
			yield* tenantSetup
			const units = yield* Db.findMany(tenancy.units, {
				where: ($, r) => [$.orgId.eq("a"), r.locks.none()],
			})
			expect(units.map((unit) => unit.id)).toEqual([2])
			const counted = yield* Db.findMany(tenancy.units, {
				where: ($) => [$.orgId.eq("a")],
				orderBy: ($) => [[$.id, "asc"]],
				_count: { locks: true },
			})
			expect(counted.map((unit) => [unit.id, unit._count.locks])).toEqual([
				[1, 2],
				[2, 0],
			])
		}),
	)

	it.effect("an unscoped filter is refused", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				Db.findMany(tenancy.orgs, { where: ($, r) => [$.id.eq("a"), r.units.some()] }),
			)
			assert(Exit.isFailure(exit))
			expect(Cause.squash(exit.cause)).toBeInstanceOf(Db.TenantScopeViolation)
		}),
	)
})
