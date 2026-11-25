import { DateTime, Effect } from "effect"
import { expectTypeOf } from "expect-type"
import * as CH from "../clickhouse"
import * as PG from "../postgres"
import * as SQLite from "../sqlite"
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

// A generated column is read like any other, but an insert or update may not write it.
const Orders = MySQL.table("orders", {
	columns: {
		id: MySQL.bigint,
		qty: MySQL.int,
		total: MySQL.column(MySQL.int, { generated: { as: ($) => $.qty.mul(2), stored: true } }),
		label: MySQL.column(MySQL.nullable(MySQL.varchar(20)), { generated: { as: "CONCAT('#', id)" } }),
	},
	primaryKey: ["id"],
})
expectTypeOf(Orders).toExtend<MySQL.MysqlSchemaTable<"orders", any>>()
MySQL.insertInto(Orders).values({ id: 1, qty: 2 })
// @ts-expect-error a generated column cannot be inserted
MySQL.insertInto(Orders).values({ id: 1, qty: 2, total: 4 })
// @ts-expect-error a nullable generated column cannot be inserted either
MySQL.insertInto(Orders).values({ id: 1, qty: 2, label: null })
MySQL.update(Orders).set({ qty: 3 }).allRows()
// @ts-expect-error a generated column cannot be set
MySQL.update(Orders).set({ total: 3 }).allRows()
// @ts-expect-error onDuplicateKeyUpdate cannot set a generated column
MySQL.insertInto(Orders).values({ id: 1, qty: 2 }).onDuplicateKeyUpdate({ set: { total: 1 } })
expectTypeOf<keyof MySQL.InsertRowOf<typeof Orders>>().toEqualTypeOf<"id" | "qty">()
expectTypeOf<MySQL.SelectRowOf<typeof Orders>>().toEqualTypeOf<{ readonly id: number; readonly qty: number; readonly total: number; readonly label: string | null }>()
expectTypeOf<keyof MySQL.TableSchemas<typeof Orders>["update"]["Type"]>().toEqualTypeOf<"id" | "qty">()
// @ts-expect-error a generated column takes no default: the database computes it
MySQL.column(MySQL.int, { generated: { as: "1" }, default: 1 })
// @ts-expect-error nor a client default
MySQL.column(MySQL.int, { generated: { as: "1" }, defaultFn: Effect.succeed(1) })

const ExternalOrders = MySQL.table("orders", {
	external: true,
	columns: { id: MySQL.bigint, total: MySQL.column(MySQL.int, { generated: { as: "qty * 2", stored: true } }) },
})
MySQL.insertInto(ExternalOrders).values({ id: 1 })
// @ts-expect-error an external table's generated column cannot be inserted
MySQL.insertInto(ExternalOrders).values({ id: 1, total: 2 })
// @ts-expect-error nor set
MySQL.update(ExternalOrders).set({ total: 2 }).allRows()

// ORDER BY and LIMIT on a single-table UPDATE or DELETE: MySQL and MariaDB only.
const Runs = MySQL.table("runs", { id: MySQL.bigint, runId: MySQL.varchar(36), n: MySQL.int })
const chunk = MySQL.deleteFrom(Runs).where(($) => [$.runId.eq(MySQL.param.string("run"))]).orderBy(["id", "asc"]).limit(20000)
MySQL.compileUnsafe(chunk, { run: "r" })
MySQL.compileUnsafe(MySQL.update(Runs).set({ n: 1 }).allRows().orderBy(($) => [[$.runId, "desc"]]).limit(5))
// @ts-expect-error UPDATE/DELETE ... ORDER BY/LIMIT has no meaning for the postgres dialect
PG.compileUnsafe(chunk, { run: "r" })
// @ts-expect-error ... nor for ClickHouse
CH.compileUnsafe(MySQL.deleteFrom(Runs).allRows().limit(1))
// @ts-expect-error ... nor for SQLite, which has it only as a compile-time option
SQLite.compileUnsafe(MySQL.update(Runs).set({ n: 1 }).allRows().orderBy(["id", "asc"]))
// @ts-expect-error a negative limit
MySQL.deleteFrom(Runs).allRows().limit(-1)
// @ts-expect-error a fractional limit
MySQL.deleteFrom(Runs).allRows().limit(1.5)
// @ts-expect-error orderBy names the table's columns
MySQL.deleteFrom(Runs).allRows().orderBy(["nope", "asc"])
// @ts-expect-error orderBy needs a column
MySQL.deleteFrom(Runs).allRows().orderBy()
// The limit's params still have to be given: the WHERE's param is required.
// @ts-expect-error required params remain required
MySQL.compileUnsafe(chunk, {})
// An UPDATE ... FROM with a LIMIT is a multi-table write MySQL refuses, and Postgres refuses the LIMIT.
const joined = PG.update(Runs).from(Items, "i").set({ n: 1 }).where(($) => [$.id.eq($.i.id)]).limit(1)
// @ts-expect-error no dialect writes both
PG.compileUnsafe(joined)
// @ts-expect-error no dialect writes both
MySQL.compileUnsafe(joined)
