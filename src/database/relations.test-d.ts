// Type-level tests: relation declarations are checked against the tables, and
// `findMany` rows follow the `with` tree.

import type { DateTime, Effect } from "effect"
import { expectTypeOf } from "expect-type"
import * as PG from "../postgres"
import * as Db from "../database"

const Users = PG.table("users", { columns: { id: PG.int4, name: PG.text }, primaryKey: ["id"] })
const Posts = PG.table("posts", {
	columns: { id: PG.int4, authorId: PG.int4, title: PG.text, at: PG.timestamptz },
	primaryKey: ["id"],
})

const schema = Db.defineRelations({ users: Users, posts: Posts }, (r) => ({
	users: { posts: r.many("posts", { from: "id", to: "authorId" }) },
	posts: { author: r.one("users", { from: "authorId", to: "id" }) },
}))

type User = { readonly id: number; readonly name: string }
type FindError = Db.DatabaseError | import("../postgres").QueryBuilderError | import("../postgres").CompiledQueryDecodeError

// No `with`: the table's own row.
expectTypeOf(Db.findMany(schema.users)).toEqualTypeOf<Effect.Effect<ReadonlyArray<User>, FindError, Db.Database>>()
expectTypeOf(Db.findMany(schema.users, { where: ($) => [$.name.eq("ada")] })).toEqualTypeOf<
	Effect.Effect<ReadonlyArray<User>, FindError, Db.Database>
>()

// `many` is an array, `one` is a row or null, nested to any depth.
expectTypeOf(
	Db.findMany(schema.users, {
		with: { posts: { where: ($) => [$.title.eq("a")], with: { author: true } } },
	}),
).toEqualTypeOf<
	Effect.Effect<
		ReadonlyArray<{
			readonly id: number
			readonly name: string
			readonly posts: ReadonlyArray<{
				readonly id: number
				readonly authorId: number
				readonly title: string
				readonly at: DateTime.Utc
				readonly author: User | null
			}>
		}>,
		FindError,
		Db.Database
	>
>()

// `where` and `orderBy` on a nested level see that level's columns.
Db.findMany(schema.users, {
	// @ts-expect-error -- `title` is a column of posts, not users
	where: ($) => [$.title.eq("a")],
})

// A relation name `with` does not declare.
// @ts-expect-error -- users has no relation `author`
Db.findMany(schema.users, { with: { author: true } })

// Declarations are checked: target table, `to` column, `from` column.
Db.defineRelations({ users: Users, posts: Posts }, (r) => ({
	// @ts-expect-error -- no table `comments`
	users: { posts: r.many("comments", { from: "id", to: "authorId" }) },
}))
Db.defineRelations({ users: Users, posts: Posts }, (r) => ({
	// @ts-expect-error -- posts has no column `userId`
	users: { posts: r.many("posts", { from: "id", to: "userId" }) },
}))
Db.defineRelations({ users: Users, posts: Posts }, (r) => ({
	// @ts-expect-error -- users has no column `uid`
	users: { posts: r.many("posts", { from: "uid", to: "authorId" }) },
}))
Db.defineRelations({ users: Users, posts: Posts }, (r) => ({
	// @ts-expect-error -- a timestamptz decodes to DateTime, which is not a key
	posts: { author: r.one("users", { from: "at", to: "id" }) },
}))
Db.defineRelations({ users: Users, posts: Posts }, (r) => ({
	// @ts-expect-error -- `name` is already a column of users
	users: { name: r.many("posts", { from: "id", to: "authorId" }) },
}))
