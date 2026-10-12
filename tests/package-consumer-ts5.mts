// Copied into an isolated directory by check-package.ts and typechecked on its
// own, with TypeScript 5 as well as 7. Kept alone and first: TypeScript 5
// measures a generic type's variance once, from whichever comparison asks
// first, so a file that touched `CHInsert` elsewhere could hide a regression.
import assert from "node:assert/strict"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"

const Counters = PG.table("counters", { columns: { key: PG.text, count: PG.int4 }, primaryKey: ["key"] })

// A concrete insert, upsert included, is a Runnable and compiles.
const insert: Db.Runnable = PG.insertInto(Counters).values({ key: "k", count: 1 })
const upsert = PG.insertInto(Counters)
	.values({ key: "k", count: PG.param.int("count") })
	.onConflictDoUpdate({ target: ["key"], set: { count: 1 } })
const runnable: Db.Runnable = upsert
assert.ok(insert !== undefined && runnable === upsert)
assert.match(PG.compileUnsafe(upsert, { count: 1 }).sql, /ON CONFLICT \("key"\) DO UPDATE/)
