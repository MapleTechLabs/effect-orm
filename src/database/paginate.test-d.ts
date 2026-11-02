// Type-level tests for `paginate`: the page's rows, and which keys it accepts.

import { Effect } from "effect"
import { expectTypeOf } from "expect-type"
import * as PG from "../postgres"
import * as Db from "../database"

const Items = PG.table("items", {
	columns: { id: PG.int4, org: PG.text, note: PG.nullable(PG.text) },
	primaryKey: ["id"],
})
const items = PG.from(Items)
	.select("id", "note")
	.where(($) => [$.org.eq(PG.param.string("org"))])
type Row = { readonly id: number; readonly note: string | null }

// The page holds the query's rows and an optional next cursor.
expectTypeOf(Db.paginate(items, { orderBy: [["id", "asc"]], limit: 10 }, { org: "a" })).toEqualTypeOf<
	Effect.Effect<
		Db.Page<Row>,
		Db.InvalidCursor | Db.DatabaseError | PG.QueryBuilderError | PG.CompiledQueryDecodeError,
		Db.Database
	>
>()

// Only a selected, non-null alias can be a key.
expectTypeOf<Db.KeysetColumn<Row>>().toEqualTypeOf<"id">()
// @ts-expect-error -- a nullable column cannot order a keyset
Db.paginate(items, { orderBy: [["note", "asc"]], limit: 10 }, { org: "a" })
// @ts-expect-error -- "org" is not selected
Db.paginate(items, { orderBy: [["org", "asc"]], limit: 10 }, { org: "a" })
// @ts-expect-error -- the key needs at least one column
Db.paginate(items, { orderBy: [], limit: 10 }, { org: "a" })
// @ts-expect-error -- a missing param is a type error, as for `run`
Db.paginate(items, { orderBy: [["id", "asc"]], limit: 10 })
