// Type-level tests: a built-in function of one dialect in a query compiled or
// run for another is a type error, not only a defect at compile time.

import { Layer } from "effect"
import { expectTypeOf } from "expect-type"
import type * as SqlClient from "effect/sql/SqlClient"
import * as CH from "./index"
import * as PG from "../postgres"
import * as Db from "../database"
import type { Dialect } from "./dialect"
import type { DialectSatisfied, DialectEntry } from "./expr"

const Events = CH.table("events", { Id: CH.string, Name: CH.string, Age: CH.uint64 })
const Users = PG.table("users", { columns: { id: PG.text, name: PG.text, age: PG.int4 }, primaryKey: ["id"] })

// A ClickHouse function tags its expression, and the query that selects it.
expectTypeOf(CH.countIf(CH.lit(1).eq(1))).toEqualTypeOf<CH.Expr<number, DialectEntry<"clickhouse">>>()
expectTypeOf(PG.countIf(CH.lit(1).eq(1))).toEqualTypeOf<CH.Expr<number, DialectEntry<"postgres">>>()

const chQuery = CH.from(Events).select(($) => ({ n: CH.countIf($.Age.gt(1)) }))
const pgQuery = PG.from(Users).select(($) => ({ n: PG.countIf($.age.gt(1)) }))
const portable = PG.from(Users).select(($) => ({ name: CH.nullIf($.name, "") }))

// Each entry's default dialect accepts its own functions...
CH.compileUnsafe(chQuery)
PG.compileUnsafe(pgQuery)
void CH.compile(chQuery)
void PG.compile(pgQuery)
// ...and refuses the other's.
// @ts-expect-error -- countIf() is a ClickHouse function
PG.compileUnsafe(chQuery)
// @ts-expect-error -- countIf() is a ClickHouse function
void PG.compile(chQuery)
// @ts-expect-error -- countIf(*) FILTER is a Postgres function
CH.compileUnsafe(pgQuery)
// @ts-expect-error -- countIf(*) FILTER is a Postgres function
void CH.compile(pgQuery)

// `options.dialect` decides, when given.
CH.compileUnsafe(pgQuery, {}, { dialect: PG.postgresDialect })
PG.compileUnsafe(chQuery, {}, { dialect: CH.clickhouseDialect })
// @ts-expect-error -- countIf() is a ClickHouse function
CH.compileUnsafe(chQuery, {}, { dialect: PG.postgresDialect })

// A dialect that does not name its function set is not checked by the type.
declare const custom: Dialect
CH.compileUnsafe(pgQuery, {}, { dialect: custom })
PG.compileUnsafe(chQuery, {}, { dialect: custom })

// Portable functions and shared operators render for every dialect.
CH.compileUnsafe(portable)
PG.compileUnsafe(portable)

// The message names both sides.
expectTypeOf<DialectSatisfied<DialectEntry<"clickhouse">, "postgres">>().toEqualTypeOf<{
	readonly wrongDialect: "this query uses ClickHouse functions; it cannot compile for the postgres dialect"
}>()
expectTypeOf<DialectSatisfied<DialectEntry<"clickhouse">, "clickhouse">>().toEqualTypeOf<unknown>()
expectTypeOf<DialectSatisfied<never, "postgres">>().toEqualTypeOf<unknown>()
expectTypeOf<DialectSatisfied<DialectEntry<"postgres">, string>>().toEqualTypeOf<unknown>()

// Two dialects in one query: no dialect can compile it, a custom one included.
const mixed = PG.from(Users).select(($) => ({ a: PG.countIf($.age.gt(1)), b: CH.countIf($.age.gt(1)) }))
// @ts-expect-error -- ClickHouse and Postgres functions in one query
PG.compileUnsafe(mixed)
// @ts-expect-error -- ClickHouse and Postgres functions in one query
CH.compileUnsafe(mixed, {}, { dialect: custom })
expectTypeOf<DialectSatisfied<DialectEntry<"clickhouse"> | DialectEntry<"postgres">, string>>().toEqualTypeOf<{
	readonly mixedDialects: "this query uses both ClickHouse and Postgres functions; no dialect can compile it"
}>()

// The tag travels with params, through every clause and into nested queries.
const inWhere = PG.from(Users).select("id").where(($) => [CH.hasToken($.name, "a")])
// @ts-expect-error -- hasToken() is a ClickHouse function
PG.compileUnsafe(inWhere)
const inOrderBy = PG.from(Users).select("id").orderBy(($) => [[CH.lower($.name), "asc"], [CH.length($.name), "desc"]])
// @ts-expect-error -- length() is a ClickHouse function
PG.compileUnsafe(inOrderBy)
const inHaving = PG.from(Users).select(($) => ({ n: PG.count() })).having(() => [CH.uniq(CH.lit(1)).gt(1)])
// @ts-expect-error -- uniq() is a ClickHouse function
PG.compileUnsafe(inHaving)
const withParam = PG.from(Users)
	.select("id")
	.where(($) => [CH.hasToken($.name, CH.param.string("token"))])
// @ts-expect-error -- hasToken() is a ClickHouse function, with a param
PG.compileUnsafe(withParam, { token: "a" })
// @ts-expect-error -- the param is still required
CH.compileUnsafe(withParam, {})
CH.compileUnsafe(withParam, { token: "a" })
const outer = PG.from(Users).select("id").where(() => [CH.exists(chQuery)])
// @ts-expect-error -- the subquery uses a ClickHouse function
PG.compileUnsafe(outer)
const joined = PG.from(Users).innerJoinQuery(chQuery, "c", ($, c) => c.n.eq($.age)).select("id")
// @ts-expect-error -- the joined subquery uses a ClickHouse function
PG.compileUnsafe(joined)
const union = CH.unionAll(PG.from(Users).select(($) => ({ n: PG.count() })), PG.from(Users).select(($) => ({ n: CH.count() })))
// @ts-expect-error -- one branch uses a ClickHouse function
PG.compileUnionUnsafe(union)
// @ts-expect-error -- one branch uses a Postgres function
CH.compileUnionUnsafe(union, {}, { dialect: CH.clickhouseDialect })

// Writes too.
const update = PG.update(Users)
	.set(($) => ({ name: CH.toString($.age) }))
	.where(($) => [$.id.eq("u")])
// @ts-expect-error -- toString() is a ClickHouse function
PG.compileUnsafe(update)

// A `Database` built for a dialect takes only that dialect's queries.
declare const client: SqlClient.SqlClient
const pg = Db.fromSqlClient(client, { dialect: PG.postgresDialect })
expectTypeOf(pg).toEqualTypeOf<Db.DatabaseApi<"postgres">>()
void pg.run(pgQuery)
void pg.run(portable)
// @ts-expect-error -- countIf() is a ClickHouse function
void pg.run(chQuery)
// The `Database` in context has no dialect in its type; it still refuses a mixed query.
void Db.run(chQuery)
void Db.run(pgQuery)
// @ts-expect-error -- ClickHouse and Postgres functions in one query
void Db.run(mixed)
// A typed `Database` still provides the `Database` in context.
expectTypeOf(Layer.succeed(Db.Database, pg)).toEqualTypeOf<Layer.Layer<Db.Database>>()
