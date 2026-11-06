import type { DateTime, Effect } from "effect"
import { expectTypeOf } from "expect-type"
import * as PG from "../postgres"
import * as MySQL from "../mysql"

const Items = MySQL.table("items", { id: MySQL.bigint, note: MySQL.text, at: MySQL.nullable(MySQL.datetime), price: MySQL.decimal(10, 2) })
const query = MySQL.from(Items).select().where(($) => [$.id.eq(MySQL.param.int("id"))])
const compiled = MySQL.compileUnsafe(query, { id: 1 })
expectTypeOf<Effect.Success<ReturnType<typeof compiled.decodeRows>>>().toEqualTypeOf<
	ReadonlyArray<{ readonly id: number; readonly note: string; readonly at: DateTime.Utc | null; readonly price: string }>
>()
const effect = MySQL.compile(query, { id: 1 })
expectTypeOf<Effect.Success<typeof effect>>().toEqualTypeOf<typeof compiled>()
// @ts-expect-error required params remain required through the MySQL compile wrapper
MySQL.compile(query, {})
// @ts-expect-error a bigint column cannot take a string
MySQL.insertInto(Items).values({ id: "1", note: "n", at: null, price: "1.00" })

// MySQL writes FOR UPDATE and FOR SHARE, not Postgres's weaker locks.
MySQL.compileUnsafe(MySQL.from(Items).select("id").forUpdate({ skipLocked: true }))
MySQL.compileUnsafe(MySQL.from(Items).select("id").forShare())
// @ts-expect-error FOR NO KEY UPDATE has no meaning for the mysql dialect
MySQL.compileUnsafe(MySQL.from(Items).select("id").forNoKeyUpdate())
// @ts-expect-error a Postgres function cannot compile for MySQL
MySQL.compileUnsafe(MySQL.from(Items).select(($) => ({ n: PG.count(), id: $.id })))
// @ts-expect-error a MySQL function cannot compile for Postgres
PG.compileUnsafe(MySQL.from(Items).select(() => ({ n: MySQL.count() })))
