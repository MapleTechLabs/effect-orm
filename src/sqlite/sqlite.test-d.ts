import type { Effect } from "effect"
import { expectTypeOf } from "expect-type"
import * as SQLite from "../sqlite"

const Items = SQLite.table("items", { id: SQLite.integer, note: SQLite.text })
const query = SQLite.from(Items).select().where(($) => [$.id.eq(SQLite.param.int("id"))])
const compiled = SQLite.compileUnsafe(query, { id: 1 })
expectTypeOf<Effect.Success<ReturnType<typeof compiled.decodeRows>>>().toEqualTypeOf<ReadonlyArray<{ readonly id: number; readonly note: string }>>()
const effect = SQLite.compile(query, { id: 1 })
expectTypeOf<Effect.Success<typeof effect>>().toEqualTypeOf<typeof compiled>()
const insert = SQLite.compileUnsafe(SQLite.insertInto(Items).values({ id: 1, note: "n" }).returning("note"))
expectTypeOf<Effect.Success<ReturnType<typeof insert.decodeRows>>>().toEqualTypeOf<ReadonlyArray<{ readonly note: string }>>()
// @ts-expect-error a select cannot name a missing column
SQLite.from(Items).select("missing")
// @ts-expect-error required params remain required through the SQLite compile wrapper
SQLite.compile(query, {})
// @ts-expect-error an integer column cannot take a string
SQLite.insertInto(Items).values({ id: "wrong", note: "n" })
