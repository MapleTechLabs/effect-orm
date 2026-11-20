// Type tests for the SQLite query features: result types, params carried,
// and refusal for a dialect that lacks the construct.

import type { Effect } from "effect"
import { Schema } from "effect"
import { expectTypeOf } from "expect-type"
import * as CH from "../clickhouse"
import * as Db from "../database"
import * as PG from "../postgres"
import * as SQLite from "../sqlite"

const Activity = SQLite.table("activity", { external: true, columns: { contactId: SQLite.text, accountId: SQLite.text, day: SQLite.text } })
const Accounts = SQLite.table("accounts", { external: true, columns: { id: SQLite.text, domains: SQLite.json(Schema.Array(Schema.String)) } })
const Subs = SQLite.table("subs", { external: true, columns: { id: SQLite.text, planName: SQLite.nullable(SQLite.text) } })
const Daily = SQLite.table("daily", { external: true, columns: { day: SQLite.text, dau: SQLite.integer } })

type RowOf<Q> = Q extends { readonly _phantom?: { readonly output: infer O } } ? O : never

// Window functions: lead/lag decode NULL past the partition unless a fallback fills it.
const windowed = SQLite.from(Activity).select(($) => {
	const spec = SQLite.windowSpec({ partitionBy: [$.contactId], orderBy: [[$.day, "asc"]] })
	return {
		next: SQLite.over(SQLite.lead($.day), spec),
		previous: SQLite.over(SQLite.lag($.day, 1, "none"), spec),
		position: SQLite.over(SQLite.rowNumber(), spec),
		first: SQLite.over(SQLite.firstValue($.day), spec),
	}
})
expectTypeOf<RowOf<typeof windowed>>().toEqualTypeOf<{ readonly next: string | null; readonly previous: string; readonly position: number; readonly first: string }>()
// @ts-expect-error -- a SQLite window function cannot compile for Postgres
PG.compileUnsafe(windowed)
const pgWindow = CH.from(Activity).select(($) => ({ next: PG.over(PG.lead($.day), PG.windowSpec({ orderBy: [[$.day, "asc"]] })) }))
PG.compileUnsafe(pgWindow)
// @ts-expect-error -- a Postgres window function cannot compile for SQLite
SQLite.compileUnsafe(pgWindow)
// @ts-expect-error -- a lag fallback has the column's type
SQLite.lag(SQLite.from(Activity) as never as SQLite.Expr<string>, 1, 5)

// json_each: typed value and key, params carried, SQLite only.
const each = SQLite.jsonEach(SQLite.param.of(SQLite.json(Schema.Record(Schema.String, Schema.String)), "after"), { value: SQLite.text, key: SQLite.text })
const pairs = SQLite.from(each, "j").select(($) => ({ key: $.key, value: $.value, type: $.type, parent: $.parent }))
expectTypeOf<RowOf<typeof pairs>>().toEqualTypeOf<{ readonly key: string; readonly value: string; readonly type: string; readonly parent: number | null }>()
SQLite.compileUnsafe(pairs, { after: { a: "b" } })
// @ts-expect-error -- the param inside json_each is required
SQLite.compileUnsafe(pairs, {})
// @ts-expect-error -- json_each is SQLite's
PG.compileUnsafe(pairs, { after: { a: "b" } })
const untyped = SQLite.from(SQLite.jsonEach([1, 2])).select(($) => ({ value: $.value, key: $.key }))
expectTypeOf<RowOf<typeof untyped>>().toEqualTypeOf<{ readonly value: unknown; readonly key: string | number | null }>()
SQLite.from(Activity).select("contactId").where(($) => [SQLite.inSubquery($.accountId, SQLite.from(SQLite.jsonEach(["a"], { value: SQLite.text })).select(($) => ({ value: $.value })))])
// @ts-expect-error -- the subquery's column must compare with the outer column
SQLite.from(Activity).select("contactId").where(($) => [SQLite.inSubquery($.accountId, SQLite.from(SQLite.jsonEach([1], { value: SQLite.integer })).select(($) => ({ value: $.value })))])
// A callback source reads the earlier sources' columns.
const crossed = SQLite.from(Accounts, "a").crossJoin(($) => SQLite.jsonEach($.domains, { value: SQLite.text }), "d").select(($) => ({ id: $.id, domain: $.d.value }))
expectTypeOf<RowOf<typeof crossed>>().toEqualTypeOf<{ readonly id: string; readonly domain: string }>()
SQLite.compileUnsafe(crossed)

// jsonRows: typed rows that fit an insert.
const rows = SQLite.jsonRows([{ day: "d", dau: 1 }], { day: SQLite.text, dau: SQLite.integer })
expectTypeOf<RowOf<typeof rows>>().toEqualTypeOf<{ readonly day: string; readonly dau: number }>()
SQLite.insertInto(Daily).select(rows)
// @ts-expect-error -- a row must have the given columns' types
SQLite.jsonRows([{ day: "d", dau: "1" }], { day: SQLite.text, dau: SQLite.integer })
// @ts-expect-error -- the insert needs every required column
SQLite.insertInto(Daily).select(SQLite.jsonRows([{ day: "d" }], { day: SQLite.text }))

// UPDATE ... FROM: the source's columns in set and where; Postgres and SQLite only.
const updateFrom = SQLite.update(Daily)
	.from(rows, "r")
	.set(($) => ({ dau: $.r.dau }))
	.where(($) => [$.day.eq($.r.day)])
SQLite.compileUnsafe(updateFrom)
const pgUpdate = PG.update(Daily).from(Activity, "a").set(() => ({ dau: 1 })).where(($) => [$.day.eq($.a.day)])
PG.compileUnsafe(pgUpdate)
// @ts-expect-error -- ClickHouse has no UPDATE ... FROM
CH.compileUnsafe(pgUpdate)
SQLite.update(Daily)
	.from(rows, "r")
	// @ts-expect-error -- the source's column has its own type
	.set(($) => ({ dau: $.r.day }))

// scalar: a one-column query as a nullable value.
const count = SQLite.scalar(SQLite.from(Activity).select(() => ({ n: SQLite.count() })))
expectTypeOf(count).toEqualTypeOf<SQLite.Expr<number | null, SQLite.SqliteOnly>>()
// @ts-expect-error -- a scalar subquery selects one column
SQLite.scalar(SQLite.from(Activity).select("day", "contactId"))

// Scalar functions. Their params carry the columns' source and `SqliteOnly`.
type P = SQLite.SourceEntry<"subs"> | SQLite.SqliteOnly
SQLite.from(Subs).select(($) => {
	expectTypeOf(SQLite.iif($.id.eq("a"), $.planName, "none")).toEqualTypeOf<SQLite.Expr<string | null, P>>()
	expectTypeOf(SQLite.caseWhen([[$.id.eq("a"), 1]], 0)).toEqualTypeOf<SQLite.Expr<number, P>>()
	expectTypeOf(SQLite.caseWhen([[$.id.eq("a"), 1]])).toEqualTypeOf<SQLite.Expr<number | null, P>>()
	expectTypeOf(SQLite.concat($.id, ":", $.planName)).toEqualTypeOf<SQLite.Expr<string | null, P>>()
	expectTypeOf(SQLite.concat($.id, ":")).toEqualTypeOf<SQLite.Expr<string, P>>()
	expectTypeOf(SQLite.cast($.id, SQLite.integer)).toEqualTypeOf<SQLite.Expr<number, P>>()
	expectTypeOf(SQLite.cast($.planName, SQLite.integer)).toEqualTypeOf<SQLite.Expr<number | null, P>>()
	expectTypeOf(SQLite.jsonExtract($.id, "$.a", SQLite.integer)).toEqualTypeOf<SQLite.Expr<number, P>>()
	expectTypeOf(SQLite.greatest(SQLite.length($.id), 2)).toEqualTypeOf<SQLite.Expr<number | null, P>>()
	expectTypeOf(SQLite.trim($.planName)).toEqualTypeOf<SQLite.Expr<string | null, P>>()
	expectTypeOf(SQLite.julianday($.id)).toEqualTypeOf<SQLite.Expr<number | null, P>>()
	expectTypeOf(SQLite.coalesce($.planName, "none")).toEqualTypeOf<SQLite.Expr<string, P>>()
	expectTypeOf(SQLite.jsonGroupArray($.id)).toEqualTypeOf<SQLite.Expr<ReadonlyArray<string>, P>>()
	return { id: $.id }
})

// FTS5.
const Fts = SQLite.fts5Table("notes_fts", { body: SQLite.text })
const search = SQLite.from(Fts)
	.select(($) => ({ rowid: $.rowid, snippet: SQLite.fts5.snippet($, "body", "[", "]", "…", 8), score: SQLite.fts5.bm25($) }))
	.where(($) => [SQLite.fts5.match($, SQLite.param.string("q"))])
expectTypeOf<RowOf<typeof search>>().toEqualTypeOf<{ readonly rowid: number; readonly snippet: string; readonly score: number }>()
// @ts-expect-error -- the query param is required
SQLite.compileUnsafe(search, {})
// @ts-expect-error -- a snippet names a column of the FTS5 table
SQLite.from(Fts).select(($) => ({ s: SQLite.fts5.snippet($, "nope", "[", "]", "…", 8) }))
// @ts-expect-error -- only an FTS5 table's accessor
SQLite.from(Activity).select(($) => ({ s: SQLite.fts5.bm25($) }))

// A where on a FROM column narrows it for a later select; an OR does not, nor a select before the where.
const narrowed = SQLite.from(Subs).where(($) => [$.planName.isNotNull()]).select(($) => ({ planName: $.planName })).distinct()
expectTypeOf<RowOf<typeof narrowed>>().toEqualTypeOf<{ readonly planName: string }>()
const narrowedByEq = SQLite.from(Subs, "s").where(($) => [$.planName.eq("pro")]).select(($) => ({ planName: $.planName }))
expectTypeOf<RowOf<typeof narrowedByEq>>().toEqualTypeOf<{ readonly planName: string }>()
const orNot = SQLite.from(Subs).where(($) => [$.planName.isNotNull().or($.id.eq("x"))]).select(($) => ({ planName: $.planName }))
expectTypeOf<RowOf<typeof orNot>>().toEqualTypeOf<{ readonly planName: string | null }>()
const before = SQLite.from(Subs).select(($) => ({ planName: $.planName })).where(($) => [$.planName.isNotNull()])
expectTypeOf<RowOf<typeof before>>().toEqualTypeOf<{ readonly planName: string | null }>()

// selectNoFrom.
const noFrom = SQLite.selectNoFrom(() => ({ day: SQLite.param.string("day"), dau: SQLite.lit(1) }))
expectTypeOf<RowOf<typeof noFrom>>().toEqualTypeOf<{ readonly day: string; readonly dau: number }>()
SQLite.insertInto(Daily).select(noFrom)

// runSync: rows typed, params required, the SQLite dialect checked.
declare const storage: SQLite.SqlStorageLike
expectTypeOf(SQLite.runSync(storage, SQLite.from(Daily).select("day"))).toEqualTypeOf<ReadonlyArray<{ readonly day: string }>>()
expectTypeOf(SQLite.runSync(storage, SQLite.insertInto(Daily).values({ day: "d", dau: 1 }))).toEqualTypeOf<ReadonlyArray<never>>()
// @ts-expect-error -- the param is required
SQLite.runSync(storage, SQLite.from(Daily).select("day").where(($) => [$.day.eq(SQLite.param.string("day"))]))
// @ts-expect-error -- a Postgres function cannot run on SQLite storage
SQLite.runSync(storage, CH.from(Daily).select(($) => ({ n: PG.count() })))

// batch: a tuple of each statement's rows, params checked across the list.
declare const db: Db.DatabaseApi<"sqlite">
const batched = db.batch([SQLite.insertInto(Daily).values({ day: "d", dau: 1 }), SQLite.from(Daily).select("dau").where(($) => [$.day.eq(SQLite.param.string("day"))])], { day: "d" })
expectTypeOf<Effect.Success<typeof batched>>().toEqualTypeOf<[ReadonlyArray<never>, ReadonlyArray<{ readonly dau: number }>]>()
// @ts-expect-error -- the second statement's param is missing
db.batch([SQLite.insertInto(Daily).values({ day: "d", dau: 1 }), SQLite.from(Daily).select("dau").where(($) => [$.day.eq(SQLite.param.string("day"))])])
// @ts-expect-error -- a Postgres function cannot run on a SQLite database
db.batch([CH.from(Daily).select(() => ({ n: PG.count() }))])
