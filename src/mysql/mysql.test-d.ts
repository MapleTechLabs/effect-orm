import { DateTime, Effect } from "effect"
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

const External = MySQL.table("ext", { external: true, columns: { id: MySQL.int } })
MySQL.from(External).select("id")
// @ts-expect-error an external table has only its declared columns
MySQL.from(External).select("columns")
// @ts-expect-error an external table carries no DDL
External.ddl

const Links = MySQL.table("links", {
	columns: {
		id: MySQL.bigint,
		orgId: MySQL.column(MySQL.nullable(MySQL.varchar(36)), { name: "org_id" }),
		hits: MySQL.column(MySQL.int, { default: 0 }),
		code: MySQL.column(MySQL.varchar(16), { unique: true }),
		createdAt: MySQL.column(MySQL.datetime, { defaultExpr: MySQL.dateTimeNow }),
	},
	primaryKey: ["id"],
	indexes: [MySQL.index("links_org", ["orgId"])],
})
expectTypeOf(Links.ddl.dialect).toEqualTypeOf<"mysql">()
expectTypeOf(Links).toExtend<MySQL.MysqlSchemaTable<"links", any>>()
// A defaulted column may be left out of an insert; a nullable one too.
MySQL.insertInto(Links).values({ id: 1, code: "c" })
// @ts-expect-error a unique column without a default is still required
MySQL.insertInto(Links).values({ id: 1 })
// @ts-expect-error a primary key names declared columns only
MySQL.table("bad", { columns: { id: MySQL.int }, primaryKey: ["nope"] })
// @ts-expect-error a default cannot be undefined: the column would be optional with no DEFAULT
MySQL.column(MySQL.text, { default: undefined })
// @ts-expect-error a default is checked against the column's type
MySQL.table("bad", { columns: { n: MySQL.column(MySQL.int, { default: "x" }) } })
// A client default lets an insert leave the column out, and its requirements become the insert's.
const Stamped = MySQL.table("stamped", {
	columns: { id: MySQL.bigint, at: MySQL.column(MySQL.datetime, { defaultFn: Effect.sync(() => DateTime.makeUnsafe(0)) }) },
	primaryKey: ["id"],
})
MySQL.insertInto(Stamped).values({ id: 1 })
