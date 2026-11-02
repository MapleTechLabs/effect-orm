// Type-level tests: relation filters and counts follow the relation schema, and
// `_count` adds a typed `_count` to the rows of its level.

import type { Effect } from "effect"
import { expectTypeOf } from "expect-type"
import * as PG from "../postgres"
import * as Db from "../database"

const Users = PG.table("users", { columns: { id: PG.int4, name: PG.text }, primaryKey: ["id"] })
const Posts = PG.table("posts", {
	columns: { id: PG.int4, authorId: PG.int4, title: PG.text },
	primaryKey: ["id"],
})

const schema = Db.defineRelations({ users: Users, posts: Posts }, (r) => ({
	users: { posts: r.many("posts", { from: "id", to: "authorId" }) },
	posts: { author: r.one("users", { from: "authorId", to: "id" }) },
}))

type FindError = Db.DatabaseError | PG.QueryBuilderError | PG.CompiledQueryDecodeError

// `_count` adds `_count` with one number per counted relation, at any level.
expectTypeOf(
	Db.findMany(schema.users, {
		_count: { posts: true },
		with: { posts: { with: { author: { _count: { posts: { where: ($) => [$.title.eq("a")] } } } } } },
	}),
).toEqualTypeOf<
	Effect.Effect<
		ReadonlyArray<{
			readonly id: number
			readonly name: string
			readonly _count: { readonly posts: number }
			readonly posts: ReadonlyArray<{
				readonly id: number
				readonly authorId: number
				readonly title: string
				readonly author: {
					readonly id: number
					readonly name: string
					readonly _count: { readonly posts: number }
				} | null
			}>
		}>,
		FindError,
		Db.Database
	>
>()

// `_count` takes `many` relations only, and only relation names.
// @ts-expect-error `author` is a `one` relation
Db.findMany(schema.posts, { _count: { author: true } })
// @ts-expect-error no relation named `comments`
Db.findMany(schema.users, { _count: { comments: true } })

// The filters see the target's columns, and the next level's relations.
Db.findMany(schema.users, {
	where: (_, r) => [
		r.posts.some(($) => [$.title.eq("a")]),
		r.posts.every(($, r) => [r.author.none(($) => [$.name.eq("b")])]),
		// @ts-expect-error `name` is not a column of posts
		r.posts.none(($) => [$.name.eq("a")]),
	],
})
// @ts-expect-error no relation named `comments`
Db.findMany(schema.users, { where: (_, r) => [r.comments.some()] })
// @ts-expect-error `every` needs its condition
Db.findMany(schema.users, { where: (_, r) => [r.posts.every()] })

// On the builder: a count is a number, and params inside a filter reach the query.
PG.from(Users).select(($) => {
	expectTypeOf(Db.related(schema.users, $).posts.count()).toEqualTypeOf<PG.Expr<number, never>>()
	return { id: $.id }
})
const withParam = PG.from(Users)
	.select(($) => ({ id: $.id }))
	.where(($) => [Db.related(schema.users, $).posts.some(($) => [$.title.eq(PG.param.string("title"))])])
expectTypeOf(PG.compileUnsafe(withParam, { title: "a" }).sql).toEqualTypeOf<string>()
// @ts-expect-error the `title` param is required
PG.compileUnsafe(withParam, {})
