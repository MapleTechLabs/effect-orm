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
const External = SQLite.table("ext", { external: true, columns: { id: SQLite.integer } })
SQLite.from(External).select("id")
// @ts-expect-error an external table has only its declared columns
SQLite.from(External).select("columns")

const Links = SQLite.table("links", {
	columns: {
		id: SQLite.text,
		orgId: SQLite.column(SQLite.nullable(SQLite.text), { name: "org_id" }),
		hits: SQLite.column(SQLite.integer, { default: 0 }),
		code: SQLite.column(SQLite.text, { unique: true }),
	},
	primaryKey: ["id"],
	indexes: [SQLite.index("links_org", ["orgId"])],
})
expectTypeOf(Links.ddl.dialect).toEqualTypeOf<"sqlite">()
// A defaulted column may be left out of an insert; a nullable one too.
SQLite.insertInto(Links).values({ id: "a", code: "c" })
// @ts-expect-error a unique column without a default is still required
SQLite.insertInto(Links).values({ id: "a" })
// @ts-expect-error a primary key names declared columns only
SQLite.table("bad", { columns: { id: SQLite.text }, primaryKey: ["nope"] })
// @ts-expect-error a default is checked against the column's type
SQLite.table("bad", { columns: { n: SQLite.column(SQLite.integer, { default: "x" }) } })
// @ts-expect-error an external table carries no DDL
External.ddl
