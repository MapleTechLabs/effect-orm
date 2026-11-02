// Type-level tests: what `findById` and `findAllBy` take and give.

import type { Cause, Effect } from "effect"
import { expectTypeOf } from "expect-type"
import * as CH from "../ch/index"
import * as PG from "../postgres"
import * as Db from "../database"

const Users = PG.table("users", { columns: { id: PG.int4, org: PG.text, name: PG.text }, primaryKey: ["id"] })
type Row = { readonly id: number; readonly name: string }

const userById = Db.findById(CH.from(Users).select("id", "name"), { key: "id" })
expectTypeOf(userById(1)).toEqualTypeOf<Effect.Effect<Row, Cause.NoSuchElementError | Db.LookupError, Db.Database>>()
// @ts-expect-error -- the key is the column's type
userById("1")

const usersByName = Db.findAllBy(CH.from(Users).select("id", "name"), { key: "name" })
expectTypeOf(usersByName("Ann")).toEqualTypeOf<Effect.Effect<ReadonlyArray<Row>, Db.LookupError, Db.Database>>()

// The key must be a selected column of the FROM table.
// @ts-expect-error -- `org` is not selected
Db.findById(CH.from(Users).select("id", "name"), { key: "org" })
// @ts-expect-error -- not a column
Db.findById(CH.from(Users).select("id", "name"), { key: "nope" })

// A query with params takes them through `with`, checked as `run` checks them.
const inOrg = Db.findById(
	CH.from(Users)
		.select("id", "name")
		.where(($) => [$.org.eq(CH.param.string("org"))]),
	{ key: "id" },
)
expectTypeOf(inOrg.with({ org: "a" })(1)).toEqualTypeOf<
	Effect.Effect<Row, Cause.NoSuchElementError | Db.LookupError, Db.Database>
>()
// @ts-expect-error -- the params are required
inOrg(1)
// @ts-expect-error -- a param of the wrong type
inOrg.with({ org: 1 })
