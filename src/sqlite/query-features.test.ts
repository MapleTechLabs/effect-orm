// Window functions, table-valued sources, UPDATE ... FROM, the SQLite scalar
// functions and FTS5, each compiled by the builder and run on real SQLite
// (node:sqlite through @effect/sql-sqlite-node). The SQL each test runs is the
// shape of a hand-written statement it replaces.

import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { DatabaseSync } from "node:sqlite"
import { DateTime, Effect, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Db from "../database"
import * as SQLite from "../sqlite"

const Activity = SQLite.table("customer_activity_daily", {
	external: true,
	columns: { contactId: SQLite.text, accountId: SQLite.text, day: SQLite.text },
})
const Contacts = SQLite.table("customer_contacts", {
	external: true,
	columns: { id: SQLite.text, email: SQLite.nullable(SQLite.text), deletedAt: SQLite.nullable(SQLite.text) },
})
const Accounts = SQLite.table("customer_accounts", {
	external: true,
	columns: {
		id: SQLite.text,
		domains: SQLite.json(Schema.Array(Schema.String)),
		blockedBy: SQLite.json(Schema.Array(Schema.String)),
		deletedAt: SQLite.nullable(SQLite.text),
		createdAt: SQLite.text,
	},
})
const OrgDaily = SQLite.table("customer_org_daily", {
	external: true,
	columns: { day: SQLite.text, dau: SQLite.integer, mrrMinor: SQLite.integer, payingAccounts: SQLite.integer },
})
const Bots = SQLite.table("bots", { external: true, columns: { id: SQLite.text, userId: SQLite.text, installCount: SQLite.integer } })
const Members = SQLite.table("membership_index", {
	external: true,
	columns: { userId: SQLite.text, orgId: SQLite.text, deletedAt: SQLite.nullable(SQLite.text) },
})

const schema = `
	CREATE TABLE customer_activity_daily ("contactId" TEXT NOT NULL, "accountId" TEXT NOT NULL, "day" TEXT NOT NULL);
	CREATE TABLE customer_contacts ("id" TEXT PRIMARY KEY, "email" TEXT, "deletedAt" TEXT);
	CREATE TABLE customer_accounts ("id" TEXT PRIMARY KEY, "domains" TEXT NOT NULL, "blockedBy" TEXT NOT NULL, "deletedAt" TEXT, "createdAt" TEXT NOT NULL);
	CREATE TABLE customer_org_daily ("day" TEXT PRIMARY KEY, "dau" INTEGER NOT NULL, "mrrMinor" INTEGER NOT NULL, "payingAccounts" INTEGER NOT NULL);
	CREATE TABLE bots ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "installCount" INTEGER NOT NULL);
	CREATE TABLE membership_index ("userId" TEXT NOT NULL, "orgId" TEXT NOT NULL, "deletedAt" TEXT);
	INSERT INTO customer_activity_daily VALUES
		('c1', 'a1', '2026-01-01'), ('c1', 'a1', '2026-01-03'), ('c1', 'a1', '2026-01-10'),
		('c2', 'a1', '2026-01-02'), ('c2', 'a2', '2026-01-05'), ('c3', 'a2', '2026-01-06');
	INSERT INTO customer_contacts VALUES ('c1', ' Ada@Example.com ', NULL), ('c2', '', NULL), ('c3', 'x@y.z', '2026-01-01');
	INSERT INTO customer_accounts VALUES
		('a1', '["acme.com","acme.io"]', '["u1"]', NULL, '2026-01-02'),
		('a2', '["globex.com"]', '[]', NULL, '2026-01-01'),
		('a3', '["acme.com"]', '[]', '2026-01-05', '2026-01-03');
	INSERT INTO bots VALUES ('b1', 'u1', 0), ('b2', 'u2', 0);
	INSERT INTO membership_index VALUES ('u1', 'o1', NULL), ('u1', 'o2', NULL), ('u1', 'o3', '2026-01-01'), ('u2', 'o1', NULL);
`

const withDatabase = <A, E>(body: (db: Db.DatabaseApi<"sqlite">) => Effect.Effect<A, E>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: SQLite.sqliteDialect })
			for (const statement of schema.split(";").map((s) => s.trim()).filter(Boolean)) yield* db.execute({ sql: statement })
			return yield* body(db)
		}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
	)

describe("window functions", () => {
	it("runs lead, lag and the ranking functions over a window, lead decoding NULL past the partition", async () => {
		const window = (contact: SQLite.Expr<string>, day: SQLite.Expr<string>) =>
			SQLite.windowSpec({ partitionBy: [contact], orderBy: [[day, "asc"]] })
		const rows = await withDatabase((db) =>
			db.run(
				SQLite.from(Activity)
					.select(($) => ({
						contactId: $.contactId,
						day: $.day,
						next: SQLite.over(SQLite.lead($.day), window($.contactId, $.day)),
						previous: SQLite.over(SQLite.lag($.day, 1, "none"), window($.contactId, $.day)),
						position: SQLite.over(SQLite.rowNumber(), window($.contactId, $.day)),
						rank: SQLite.over(SQLite.rank(), SQLite.windowSpec({ orderBy: [[$.accountId, "asc"]] })),
						dense: SQLite.over(SQLite.denseRank(), SQLite.windowSpec({ orderBy: [[$.accountId, "asc"]] })),
						first: SQLite.over(SQLite.firstValue($.day), window($.contactId, $.day)),
						last: SQLite.over(
							SQLite.lastValue($.day),
							SQLite.windowSpec({
								partitionBy: [$.contactId],
								orderBy: [[$.day, "asc"]],
								frame: SQLite.rowsBetween(SQLite.unboundedPreceding, SQLite.unboundedFollowing),
							}),
						),
						running: SQLite.over(
							SQLite.count(),
							SQLite.windowSpec({ orderBy: [[$.day, "asc"]], frame: SQLite.rangeBetween(SQLite.unboundedPreceding, SQLite.currentRow) }),
						),
					}))
					.where(($) => [$.contactId.eq("c1")])
					.orderBy(["day", "asc"]),
			),
		)
		expect(rows).toEqual([
			{ contactId: "c1", day: "2026-01-01", next: "2026-01-03", previous: "none", position: 1, rank: 1, dense: 1, first: "2026-01-01", last: "2026-01-10", running: 1 },
			{ contactId: "c1", day: "2026-01-03", next: "2026-01-10", previous: "2026-01-01", position: 2, rank: 1, dense: 1, first: "2026-01-01", last: "2026-01-10", running: 2 },
			{ contactId: "c1", day: "2026-01-10", next: null, previous: "2026-01-03", position: 3, rank: 1, dense: 1, first: "2026-01-01", last: "2026-01-10", running: 3 },
		])
	})

	it("groups a window's result by an expression in an outer query: gaps between active days, capped at 30", async () => {
		const inner = SQLite.from(Activity).select(($) => ({
			day: $.day,
			next: SQLite.over(SQLite.lead($.day), SQLite.windowSpec({ partitionBy: [$.contactId], orderBy: [[$.day, "asc"]] })),
		}))
		const query = SQLite.fromQuery(inner, "g")
			.select(($) => ({
				gap: SQLite.least(SQLite.coalesce(SQLite.cast(SQLite.julianday($.next).sub(SQLite.julianday($.day)), SQLite.integer), 30), 30),
				n: SQLite.count(),
			}))
			.groupBy("gap")
			.orderBy(["gap", "asc"])
		const compiled = SQLite.compileUnsafe(query)
		expect(compiled.sql).toContain(`min(coalesce(CAST(julianday("g"."next") - julianday("g"."day") AS integer), 30), 30)`)
		expect(compiled.rowSchemaSource).toBe("derived")
		const rows = await withDatabase((db) => db.run(query))
		expect(rows).toEqual([{ gap: 2, n: 1 }, { gap: 3, n: 1 }, { gap: 7, n: 1 }, { gap: 30, n: 3 }])
	})
})

describe("table-valued sources", () => {
	it("passes an id list as one bound JSON parameter to IN (SELECT value FROM json_each(?))", async () => {
		const ids = Array.from({ length: 150 }, (_, i) => `a${i}`)
		const query = SQLite.from(Activity)
			.select("contactId")
			.where(($) => [SQLite.inSubquery($.accountId, SQLite.from(SQLite.jsonEach(ids, { value: SQLite.text })).select(($) => ({ value: $.value })))])
			.distinct()
			.orderBy(["contactId", "asc"])
		// One parameter for 150 ids: D1 and Durable Object storage allow 100 per statement.
		expect(SQLite.compileUnsafe(query, {}, { dialect: SQLite.d1Dialect }).parameters).toHaveLength(1)
		expect(await withDatabase((db) => db.run(query))).toEqual([{ contactId: "c1" }, { contactId: "c2" }, { contactId: "c3" }])
	})

	it("cross-joins json_each of a JSON column, filters its values and keeps the accounts' order", async () => {
		const query = SQLite.from(Accounts, "a")
			.crossJoin(($) => SQLite.jsonEach($.domains, { value: SQLite.text }), "d")
			.where(($) => [$.deletedAt.isNull(), $.d.value.in_("acme.com", "globex.com")])
			.select(($) => ({ id: $.id }))
			.distinct()
			.orderBy(($) => [[$.createdAt, "asc"]])
		expect(SQLite.compileUnsafe(query).sql).toContain(`CROSS JOIN json_each("a"."domains") AS "d"`)
		expect(await withDatabase((db) => db.run(query))).toEqual([{ id: "a2" }, { id: "a1" }])
	})

	it("joins tables on json_each's key and value, and chains json_each of a json_extract", async () => {
		const after = SQLite.param.of(SQLite.json(Schema.Record(Schema.String, Schema.String)), "after")
		const counts = SQLite.from(SQLite.jsonEach(after, { key: SQLite.text, value: SQLite.text }), "j")
			.innerJoin(Activity, "a", (j, a) => a.accountId.eq(j.key).and(a.day.gt(j.value)))
			.select(($) => ({ accountId: $.a.accountId, contacts: SQLite.countDistinct($.a.contactId) }))
			.groupBy("accountId")
			.orderBy(["accountId", "asc"])

		const groups = [
			{ accounts: ["a1"], after: "2026-01-02" },
			{ accounts: ["a2", "a1"], after: "2026-01-05" },
		]
		const grouped = SQLite.from(SQLite.jsonEach(groups), "g")
			.innerJoin(($) => SQLite.jsonEach(SQLite.jsonExtract($.value, "$.accounts", SQLite.text), { value: SQLite.text }), "m", () => SQLite.rawCond("1"))
			.innerJoin(Activity, "a", (g, a) => a.accountId.eq(g.m.value).and(a.day.gt(SQLite.jsonExtract(g.value, "$.after", SQLite.text))))
			.leftJoin(Contacts, "c", (g, c) => c.id.eq(g.a.contactId))
			.select(($) => ({ group: $.key, accountId: $.a.accountId, contactId: $.a.contactId, email: $.c.email }))
			.orderBy(($) => [[$.key, "asc"], [$.a.day, "asc"]])
		const sql = SQLite.compileUnsafe(grouped).sql
		expect(sql).toContain(`INNER JOIN json_each(json_extract("g"."value", '$.accounts')) AS "m"`)

		const result = await withDatabase((db) =>
			Effect.all({ counts: db.run(counts, { after: { a1: "2026-01-01", a2: "2026-01-05" } }), grouped: db.run(grouped) }),
		)
		expect(result.counts).toEqual([{ accountId: "a1", contacts: 2 }, { accountId: "a2", contacts: 1 }])
		expect(result.grouped).toEqual([
			{ group: 0, accountId: "a1", contactId: "c1", email: " Ada@Example.com " },
			{ group: 0, accountId: "a1", contactId: "c1", email: " Ada@Example.com " },
			{ group: 1, accountId: "a2", contactId: "c3", email: "x@y.z" },
			{ group: 1, accountId: "a1", contactId: "c1", email: " Ada@Example.com " },
		])
	})

	it("reads json_each of an outer JSON column in a correlated EXISTS", async () => {
		const query = SQLite.from(Accounts)
			.select(($) => ({ id: $.id }))
			.where(($) => [
				SQLite.exists(
					SQLite.from(SQLite.jsonEach($.blockedBy, { value: SQLite.text }))
						.select(() => ({ one: SQLite.lit(1) }))
						.where((j) => [j.value.eq(SQLite.param.string("userId"))]),
				),
			])
		expect(await withDatabase((db) => db.run(query, { userId: "u1" }))).toEqual([{ id: "a1" }])
	})

	it("inserts the rows of a JS array with jsonRows, and upserts with a condition on the existing row and excluded", async () => {
		const days = [
			{ day: "2026-01-01", dau: 3, mrrMinor: 500, payingAccounts: 1 },
			{ day: "2026-01-02", dau: 4, mrrMinor: 700, payingAccounts: 2 },
		]
		const upsert = (rows: ReadonlyArray<typeof days[number]>) =>
			SQLite.insertInto(OrgDaily)
				.select(SQLite.jsonRows(rows, { day: SQLite.text, dau: SQLite.integer, mrrMinor: SQLite.integer, payingAccounts: SQLite.integer }))
				.onConflictDoUpdate({
					target: ["day"],
					set: ($, excluded) => ({
						dau: excluded.dau,
						// Keep a recorded MRR; fill it only where none was recorded yet.
						mrrMinor: SQLite.iif($.mrrMinor.eq(0).and($.payingAccounts.eq(0)), excluded.mrrMinor, $.mrrMinor),
					}),
				})
		const compiled = SQLite.compileUnsafe(upsert(days))
		// Every row in one parameter; the two zeros are bound as comparison values are.
		expect(compiled.parameters).toEqual([JSON.stringify(days), 0, 0])
		expect(compiled.sql).toContain(`json_extract("json_each"."value", '$.mrrMinor') AS "mrrMinor"`)
		expect(compiled.sql).toContain(
			`"mrrMinor" = iif(("customer_org_daily"."mrrMinor" = ? AND "customer_org_daily"."payingAccounts" = ?), "excluded"."mrrMinor", "customer_org_daily"."mrrMinor")`,
		)
		const rows = await withDatabase((db) =>
			Effect.gen(function* () {
				yield* db.run(SQLite.insertInto(OrgDaily).values({ day: "2026-01-01", dau: 1, mrrMinor: 0, payingAccounts: 0 }))
				yield* db.run(SQLite.insertInto(OrgDaily).values({ day: "2026-01-02", dau: 1, mrrMinor: 100, payingAccounts: 1 }))
				yield* db.run(upsert(days))
				return yield* db.run(SQLite.from(OrgDaily).select().orderBy(["day", "asc"]))
			}),
		)
		expect(rows).toEqual([
			{ day: "2026-01-01", dau: 3, mrrMinor: 500, payingAccounts: 0 },
			{ day: "2026-01-02", dau: 4, mrrMinor: 100, payingAccounts: 1 },
		])
	})
})

describe("UPDATE ... FROM", () => {
	it("updates from json_each and from jsonRows, reading the source in SET and WHERE", async () => {
		const fromEach = SQLite.update(OrgDaily)
			.from(SQLite.jsonEach([{ day: "2026-01-01", dau: 9 }]), "j")
			.set(($) => ({ dau: SQLite.jsonExtract($.j.value, "$.dau", SQLite.integer) }))
			.where(($) => [$.day.eq(SQLite.jsonExtract($.j.value, "$.day", SQLite.text))])
		expect(SQLite.compileUnsafe(fromEach).sql).toBe(
			`UPDATE "customer_org_daily" SET "dau" = json_extract("j"."value", '$.dau')\nFROM json_each(?) AS "j"\nWHERE "customer_org_daily"."day" = json_extract("j"."value", '$.day')`,
		)
		const fromRows = SQLite.update(OrgDaily)
			.from(SQLite.jsonRows([{ day: "2026-01-02", dau: 7 }], { day: SQLite.text, dau: SQLite.integer }), "r")
			.set(($) => ({ dau: $.r.dau }))
			.where(($) => [$.day.eq($.r.day)])
			.returning("day", "dau")
		const rows = await withDatabase((db) =>
			Effect.gen(function* () {
				yield* db.execute({ sql: `INSERT INTO customer_org_daily VALUES ('2026-01-01', 1, 0, 0), ('2026-01-02', 1, 0, 0), ('2026-01-03', 1, 0, 0)` })
				yield* db.run(fromEach)
				const returned = yield* db.run(fromRows)
				return { returned, all: yield* db.run(SQLite.from(OrgDaily).select("day", "dau").orderBy(["day", "asc"])) }
			}),
		)
		expect(rows.returned).toEqual([{ day: "2026-01-02", dau: 7 }])
		expect(rows.all).toEqual([{ day: "2026-01-01", dau: 9 }, { day: "2026-01-02", dau: 7 }, { day: "2026-01-03", dau: 1 }])
	})

	it("updates from another table, refused on a dialect without UPDATE ... FROM", () => {
		const update = SQLite.update(Bots)
			.from(Members, "m")
			.set(() => ({ installCount: 1 }))
			.where(($) => [$.userId.eq($.m.userId)])
		expect(SQLite.compileUnsafe(update).sql).toContain(`FROM "membership_index" AS "m"\nWHERE "bots"."userId" = "m"."userId"`)
		const mysqlish: SQLite.Dialect<"sqlite"> = { ...SQLite.sqliteDialect, clauses: { ...SQLite.sqliteDialect.clauses, updateFrom: false } }
		expect(() => SQLite.compileUnsafe(update, {}, { dialect: mysqlish })).toThrow(/UPDATE \.\.\. FROM has no meaning/)
	})

	it("sets a column from a correlated scalar subquery that reads the target's column, qualified", async () => {
		const update = SQLite.update(Bots)
			.set(($) => ({
				installCount: SQLite.coalesce(
					SQLite.scalar(
						SQLite.from(Members, "mi")
							.select(() => ({ count: SQLite.count() }))
							.where((mi) => [mi.userId.eq($.userId), mi.deletedAt.isNull()]),
					),
					0,
				),
			}))
			.where(($) => [$.id.eq("b1")])
		const compiled = SQLite.compileUnsafe(update)
		// Bare, `"userId"` would read the subquery's own column and count every live membership.
		expect(compiled.sql).toContain(`WHERE "mi"."userId" = "bots"."userId"`)
		expect(compiled.sql).toContain(`WHERE "id" = ?`)
		// The same with subqueryExpr, the hand-wrapped form.
		const wrapped = SQLite.update(Bots)
			.set(($) => ({
				installCount: SQLite.subqueryExpr(
					SQLite.from(Members, "mi").select(() => ({ count: SQLite.count() })).where((mi) => [mi.userId.eq($.userId), mi.deletedAt.isNull()]),
					SQLite.integer,
				),
			}))
			.where(($) => [$.id.eq("b2")])
		const deleted = SQLite.deleteFrom(Members)
			.where(($) => [SQLite.exists(SQLite.from(Bots, "b").select(() => ({ one: SQLite.lit(1) })).where((b) => [b.userId.eq($.userId), b.id.eq("b2")]))])
			.returning("orgId")
		const rows = await withDatabase((db) =>
			Effect.gen(function* () {
				yield* db.run(update)
				yield* db.run(wrapped)
				const bots = yield* db.run(SQLite.from(Bots).select("id", "installCount").orderBy(["id", "asc"]))
				return { bots, deleted: yield* db.run(deleted) }
			}),
		)
		expect(rows.bots).toEqual([{ id: "b1", installCount: 2 }, { id: "b2", installCount: 1 }])
		expect(rows.deleted).toEqual([{ orgId: "o1" }])
	})
})

describe("SQLite functions", () => {
	it("runs the JSON aggregates and functions, CASE and the text functions as one statement", async () => {
		const Via = SQLite.table("via", { external: true, columns: { viaAccounts: SQLite.json(Schema.Record(Schema.String, Schema.Unknown)) } })
		const marked = SQLite.from(Via)
			.innerJoin(($) => SQLite.jsonEach($.viaAccounts), "e", () => SQLite.rawCond("1"))
			.select(($) => ({
				accounts: SQLite.jsonGroupObject(
					$.e.key as SQLite.Expr<string>,
					SQLite.caseWhen(
						[[
							SQLite.jsonExtract($.e.value, "$.leftAt", SQLite.nullable(SQLite.text)).isNull().and(
								SQLite.jsonExtract($.e.value, "$.seenAt", SQLite.text).lt(SQLite.param.string("cutoff")),
							),
							SQLite.jsonSet($.e.value, "$.leftAt", SQLite.param.string("now")),
						]],
						SQLite.json_($.e.value),
					),
					SQLite.json(Schema.Record(Schema.String, Schema.Struct({ seenAt: Schema.String, leftAt: Schema.optional(Schema.String) }))),
				),
			}))
		const people = SQLite.from(Activity, "a")
			.leftJoin(Contacts, "c", (a, c) => c.id.eq(a.contactId))
			.select(($) => ({
				people: SQLite.countDistinct(
					SQLite.caseWhen(
						[[$.c.deletedAt.isNull().and(SQLite.trim(SQLite.coalesce($.c.email, "")).neq("")), SQLite.lower(SQLite.trim($.c.email))]],
						$.contactId,
					),
				),
				days: SQLite.jsonGroupArray($.day),
			}))
		const result = await withDatabase((db) =>
			Effect.gen(function* () {
				yield* db.execute({ sql: `CREATE TABLE via ("viaAccounts" TEXT NOT NULL)` })
				yield* db.execute({ sql: `INSERT INTO via VALUES ('{"a1":{"seenAt":"2026-01-01"},"a2":{"seenAt":"2026-02-01"}}')` })
				return { marked: yield* db.run(marked, { cutoff: "2026-01-15", now: "2026-01-20" }), people: yield* db.run(people) }
			}),
		)
		expect(result.marked).toEqual([{ accounts: { a1: { seenAt: "2026-01-01", leftAt: "2026-01-20" }, a2: { seenAt: "2026-02-01" } } }])
		// c1 by its email, c2 (blank email) and c3 (deleted) by contact id.
		expect(result.people[0]?.people).toBe(3)
		expect([...(result.people[0]?.days ?? [])].sort()).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-05", "2026-01-06", "2026-01-10"])
	})

	it("decodes the scalar functions, NULL where an argument is NULL", async () => {
		const query = SQLite.from(Contacts)
			.select(($) => ({
				id: $.id,
				trimmed: SQLite.trim($.email),
				left: SQLite.ltrim($.email),
				right: SQLite.rtrim($.email, " m"),
				sub: SQLite.substr($.id, 2),
				replaced: SQLite.replace($.id, "c", "contact-"),
				at: SQLite.instr($.email, "@"),
				gone: SQLite.nullif($.id, "c2"),
				fallback: SQLite.ifnull($.deletedAt, "live"),
				deleted: SQLite.iif($.deletedAt.isNull(), false, true),
				key: SQLite.concat($.id, ":", SQLite.coalesce($.email, "")),
				bigger: SQLite.greatest(SQLite.length($.id), 2),
				abs: SQLite.abs(SQLite.lit(-2.5)),
				round: SQLite.round(SQLite.lit(2.567), 2),
				asText: SQLite.cast(SQLite.lit(12), SQLite.text),
				date: SQLite.date("2026-01-05 10:00:00", "+1 day"),
				datetime: SQLite.datetime("2026-01-05 10:00:00"),
				strftime: SQLite.strftime("%Y", "2026-01-05"),
				epoch: SQLite.unixepoch("2026-01-01 00:00:00"),
			}))
			.where(($) => [SQLite.concat($.id, ":x").in_("c1:x", "c3:x")])
			.orderBy(["id", "asc"])
		expect(await withDatabase((db) => db.run(query))).toEqual([
			{
				id: "c1", trimmed: "Ada@Example.com", left: "Ada@Example.com ", right: " Ada@Example.co", sub: "1", replaced: "contact-1", at: 5,
				gone: "c1", fallback: "live", deleted: false, key: "c1: Ada@Example.com ", bigger: 2, abs: 2.5, round: 2.57, asText: "12",
				date: "2026-01-06", datetime: "2026-01-05 10:00:00", strftime: "2026", epoch: 1767225600,
			},
			{
				id: "c3", trimmed: "x@y.z", left: "x@y.z", right: "x@y.z", sub: "3", replaced: "contact-3", at: 2,
				gone: "c3", fallback: "2026-01-01", deleted: true, key: "c3:x@y.z", bigger: 2, abs: 2.5, round: 2.57, asText: "12",
				date: "2026-01-06", datetime: "2026-01-05 10:00:00", strftime: "2026", epoch: 1767225600,
			},
		])
	})

	it("matches text inside a JSON column after casting it to text", async () => {
		const Messages = SQLite.table("messages", { external: true, columns: { id: SQLite.integer, embeds: SQLite.json(Schema.Array(Schema.Struct({ url: Schema.String }))) } })
		const rows = await withDatabase((db) =>
			Effect.gen(function* () {
				yield* db.execute({ sql: `CREATE TABLE messages ("id" INTEGER, "embeds" TEXT NOT NULL)` })
				yield* db.run(SQLite.insertInto(Messages).values([{ id: 1, embeds: [{ url: "https://x.dev/a" }] }, { id: 2, embeds: [] }]))
				return yield* db.run(SQLite.from(Messages).select("id").where(($) => [SQLite.cast($.embeds, SQLite.text).contains("x.dev")]))
			}),
		)
		expect(rows).toEqual([{ id: 1 }])
	})
})

describe("FTS5 and rowid", () => {
	const Fts = SQLite.fts5Table("message_search_fts", { content: SQLite.text })
	const Search = SQLite.table("message_search", {
		external: true,
		columns: { id: SQLite.integer, messageId: SQLite.text, channelId: SQLite.text, createdAt: SQLite.text },
	})
	const Access = SQLite.table("channel_access", { external: true, columns: { channelId: SQLite.text, userId: SQLite.text } })

	it("searches an FTS5 table joined to its content table, with snippet, highlight and bm25, and keyset pagination", async () => {
		const cursor = { createdAt: "2026-01-03", messageId: "m3" }
		const query = SQLite.from(Fts)
			.innerJoin(Search, "s", (f, s) => s.id.eq(f.rowid))
			.select(($) => ({
				messageId: $.s.messageId,
				snippet: SQLite.fts5.snippet($, "content", "\u0002", "\u0003", "…", 24),
				marked: SQLite.fts5.highlight($, 0, "[", "]"),
				score: SQLite.fts5.bm25($),
			}))
			.where(($) => [
				SQLite.fts5.match($, SQLite.param.string("q")),
				SQLite.inSubquery($.s.channelId, SQLite.from(Access).select("channelId").where((a) => [a.userId.eq(SQLite.param.string("userId"))])),
				$.s.createdAt.lt(cursor.createdAt).or($.s.createdAt.eq(cursor.createdAt).and($.s.messageId.lt(cursor.messageId))),
			])
			.orderBy(($) => [[$.s.createdAt, "desc"], [$.s.messageId, "desc"]])
			.limit(10)
		const compiled = SQLite.compileUnsafe(query, { q: "hello", userId: "u1" })
		expect(compiled.sql).toContain(`snippet("message_search_fts"."message_search_fts", 0, '\u0002', '\u0003', '…', 24) AS "snippet"`)
		expect(compiled.sql).toContain(`WHERE "message_search_fts"."message_search_fts" MATCH ?`)
		const rows = await withDatabase((db) =>
			Effect.gen(function* () {
				yield* db.execute({ sql: `CREATE VIRTUAL TABLE message_search_fts USING fts5(content)` })
				yield* db.execute({ sql: `CREATE TABLE message_search ("id" INTEGER PRIMARY KEY, "messageId" TEXT, "channelId" TEXT, "createdAt" TEXT)` })
				yield* db.execute({ sql: `CREATE TABLE channel_access ("channelId" TEXT, "userId" TEXT)` })
				yield* db.execute({ sql: `INSERT INTO channel_access VALUES ('ch1', 'u1')` })
				const messages = [
					[1, "m1", "ch1", "2026-01-01", "hello world"],
					[2, "m2", "ch1", "2026-01-02", "say hello again"],
					[3, "m3", "ch1", "2026-01-03", "hello later"],
					[4, "m4", "ch2", "2026-01-01", "hello elsewhere"],
					[5, "m5", "ch1", "2026-01-01", "nothing here"],
				] as const
				for (const [id, messageId, channelId, createdAt, content] of messages) {
					yield* db.run(SQLite.insertInto(Search).values({ id, messageId, channelId, createdAt }))
					yield* db.run(SQLite.insertInto(Fts).values({ rowid: id, content }))
				}
				return yield* db.run(query, { q: "hello", userId: "u1" })
			}),
		)
		expect(rows.map(({ messageId, snippet, marked }) => ({ messageId, snippet, marked }))).toEqual([
			{ messageId: "m2", snippet: "say \u0002hello\u0003 again", marked: "say [hello] again" },
			{ messageId: "m1", snippet: "\u0002hello\u0003 world", marked: "[hello] world" },
		])
		expect(rows.every((row) => typeof row.score === "number" && row.score < 0)).toBe(true)
	})

	it("reads an external table's implicit rowid, grouped in a subquery joined back on it", async () => {
		const Outbox = SQLite.table("outbox", { external: true, columns: { rowid: SQLite.integer, key: SQLite.text, payload: SQLite.text } })
		const heads = SQLite.from(Outbox).select(($) => ({ key: $.key, head: SQLite.min($.rowid) })).groupBy("key")
		const query = SQLite.from(Outbox, "o")
			.innerJoinQuery(heads, "h", (o, h) => o.rowid.eq(h.head))
			.select(($) => ({ rowid: $.rowid, key: $.key, payload: $.payload }))
			.orderBy(["rowid", "asc"])
		const rows = await withDatabase((db) =>
			Effect.gen(function* () {
				yield* db.execute({ sql: `CREATE TABLE outbox ("key" TEXT, "payload" TEXT)` })
				yield* db.execute({ sql: `INSERT INTO outbox VALUES ('a', '1'), ('b', '2'), ('a', '3')` })
				return yield* db.run(query)
			}),
		)
		expect(rows).toEqual([{ rowid: 1, key: "a", payload: "1" }, { rowid: 2, key: "b", payload: "2" }])
	})
})

describe("other statement shapes", () => {
	it("deletes outside a NOT IN subquery with ORDER BY and LIMIT, and returns the keys an ON CONFLICT DO NOTHING inserted", async () => {
		const keep = SQLite.deleteFrom(Activity).where(($) => [SQLite.notInSubquery($.day, SQLite.from(Activity).select("day").orderBy(["day", "desc"]).limit(2))])
		const result = await withDatabase((db) =>
			Effect.gen(function* () {
				yield* db.run(keep)
				const left = yield* db.run(SQLite.from(Activity).select("day").orderBy(["day", "asc"]))
				const inserted = yield* db.run(
					SQLite.insertInto(Bots).values([{ id: "b1", userId: "x", installCount: 0 }, { id: "b3", userId: "x", installCount: 0 }]).onConflictDoNothing().returning("id"),
				)
				return { left, inserted }
			}),
		)
		expect(result.left).toEqual([{ day: "2026-01-06" }, { day: "2026-01-10" }])
		expect(result.inserted).toEqual([{ id: "b3" }])
	})

	it("filters groups on a select alias in HAVING and sums a condition", async () => {
		const query = SQLite.from(Activity)
			.select(($) => ({ accountId: $.accountId, days: SQLite.count(), late: SQLite.sum(SQLite.iif($.day.gt("2026-01-04"), 1, 0)) }))
			.groupBy("accountId")
			.having(() => [SQLite.dynamicColumn("days", SQLite.integer).gt(2)])
		expect(await withDatabase((db) => db.run(query))).toEqual([{ accountId: "a1", days: 4, late: 1 }])
	})

	it("inserts one row of values only when a condition holds: INSERT ... SELECT with no FROM", async () => {
		const grant = SQLite.insertInto(Bots).select(
			SQLite.selectNoFrom(() => ({ id: SQLite.param.string("id"), userId: SQLite.param.string("userId"), installCount: SQLite.lit(1) })).where(() => [
				SQLite.exists(SQLite.from(Members).select(() => ({ one: SQLite.lit(1) })).where(($) => [$.userId.eq(SQLite.param.string("userId"))])),
				SQLite.not(SQLite.exists(SQLite.from(Bots).select(() => ({ one: SQLite.lit(1) })).where(($) => [$.userId.eq(SQLite.param.string("userId"))]))),
			]),
		)
		expect(SQLite.compileUnsafe(grant, { id: "b9", userId: "u3" }).sql).toMatch(/^INSERT INTO "bots" \("id", "userId", "installCount"\)\nSELECT\s+\? AS "id",\s+\? AS "userId",\s+1 AS "installCount"\s+WHERE EXISTS/)
		const rows = await withDatabase((db) =>
			Effect.gen(function* () {
				yield* db.execute({ sql: `INSERT INTO membership_index VALUES ('u3', 'o1', NULL)` })
				yield* db.run(grant, { id: "b9", userId: "u3" })
				yield* db.run(grant, { id: "b10", userId: "u3" })
				yield* db.run(grant, { id: "b11", userId: "nobody" })
				return yield* db.run(SQLite.from(Bots).select("id").where(($) => [$.id.in_("b9", "b10", "b11")]))
			}),
		)
		expect(rows).toEqual([{ id: "b9" }])
	})

	it("narrows a FROM column a where proves not NULL, in the type and in the row schema", async () => {
		const query = SQLite.from(Contacts)
			.where(($) => [$.email.isNotNull()])
			.select(($) => ({ email: $.email }))
			.distinct()
		const rows = await withDatabase((db) => db.run(query))
		expect(rows.map((row) => row.email).sort()).toEqual(["", " Ada@Example.com ", "x@y.z"])
		const compiled = SQLite.compileUnsafe(query)
		await expect(Effect.runPromise(compiled.decodeRows([{ email: null }]))).rejects.toThrow()
	})
})

describe("runSync on synchronous storage", () => {
	const storage = () => {
		const db = new DatabaseSync(":memory:")
		for (const statement of schema.split(";").map((s) => s.trim()).filter(Boolean)) db.exec(statement)
		// Eager, as workerd's `exec` is: the statement runs on the call, `toArray` reads its rows.
		const sql: SQLite.SqlStorageLike = {
			exec: (text, ...bindings) => {
				const rows = db.prepare(text).all(...(bindings as Array<never>)) as Array<Record<string, unknown>>
				return { toArray: () => rows }
			},
		}
		return sql
	}

	it("runs and decodes queries and writes without an Effect, and throws a compile failure", () => {
		const sql = storage()
		const inserted = SQLite.runSync(sql, SQLite.insertInto(Bots).values({ id: "b5", userId: "u5", installCount: 2 }).returning("id", "installCount"))
		expect(inserted).toEqual([{ id: "b5", installCount: 2 }])
		expect(SQLite.runSync(sql, SQLite.update(Bots).set({ installCount: 3 }).where(($) => [$.id.eq("b5")]))).toEqual([])
		const rows = SQLite.runSync(sql, SQLite.from(Bots).select("id", "installCount").where(($) => [$.userId.eq(SQLite.param.string("user"))]), { user: "u5" })
		expect(rows).toEqual([{ id: "b5", installCount: 3 }])
		expect(() => SQLite.runSync(sql, SQLite.from(Bots).select("id").limit(-1 as number))).toThrow(/limit\(-1\)/)
	})

	it("runs a write's synchronous client defaults", () => {
		const Jobs = SQLite.table("jobs", {
			columns: { id: SQLite.column(SQLite.text, { defaultFn: Effect.succeed("job_1") }), at: SQLite.timestamp },
			primaryKey: ["id"],
		})
		const sql = storage()
		sql.exec(`CREATE TABLE jobs ("id" TEXT PRIMARY KEY, "at" TEXT NOT NULL)`)
		const at = DateTime.makeUnsafe("2026-01-01T00:00:00Z")
		expect(SQLite.runSync(sql, SQLite.insertInto(Jobs).values({ at }).returning("id"))).toEqual([{ id: "job_1" }])
	})
})

describe("batch", () => {
	it("runs a list of statements in one transaction on SQLite and returns each one's rows; a failure rolls every one back", async () => {
		const result = await withDatabase((db) =>
			Effect.gen(function* () {
				const [inserted, none, bots] = yield* db.batch([
					SQLite.insertInto(Bots).values({ id: "b7", userId: "u7", installCount: 0 }).returning("id"),
					SQLite.update(Bots).set({ installCount: 1 }).where(($) => [$.id.eq("b7")]),
					SQLite.from(Bots).select("id", "installCount").where(($) => [$.userId.eq(SQLite.param.string("user"))]),
				], { user: "u7" })
				const failed = yield* Effect.exit(
					db.batch([
						SQLite.insertInto(Bots).values({ id: "b8", userId: "u8", installCount: 0 }),
						SQLite.insertInto(Bots).values({ id: "b8", userId: "u8", installCount: 0 }),
					]),
				)
				const after = yield* db.run(SQLite.from(Bots).select("id").where(($) => [$.id.eq("b8")]))
				return { inserted, none, bots, failed: failed._tag, after }
			}),
		)
		expect(result).toEqual({ inserted: [{ id: "b7" }], none: [], bots: [{ id: "b7", installCount: 1 }], failed: "Failure", after: [] })
	})
})

describe("review fixes", () => {
	const Numbers = SQLite.table("numbers", {
		external: true,
		columns: { id: SQLite.integer, n: SQLite.integer, x: SQLite.real, maybe: SQLite.nullable(SQLite.integer), at: SQLite.timestamp, label: SQLite.text },
	})
	const setup = `CREATE TABLE numbers ("id" INTEGER, "n" INTEGER NOT NULL, "x" REAL NOT NULL, "maybe" INTEGER, "at" TEXT NOT NULL, "label" TEXT NOT NULL)`
	const rows = `INSERT INTO numbers VALUES (1, 1, 1.5, NULL, '2026-01-01 00:00:00.000', ' a '), (2, 2, 2.5, 7, '2026-01-02 00:00:00.000', ' b ')`
	const withNumbers = <A, E>(body: (db: Db.DatabaseApi<"sqlite">) => Effect.Effect<A, E>) =>
		withDatabase((db) => Effect.gen(function* () {
			yield* db.execute({ sql: setup })
			yield* db.execute({ sql: rows })
			return yield* body(db)
		}))

	it("decodes lead/lag with an expression fallback by both codecs, and first/last_value of an empty frame as NULL", async () => {
		const spec = (id: SQLite.Expr<number>) => SQLite.windowSpec({ orderBy: [[id, "asc"]] })
		const empty = (id: SQLite.Expr<number>) =>
			SQLite.windowSpec({ orderBy: [[id, "asc"]], frame: SQLite.rowsBetween(SQLite.preceding(1), SQLite.preceding(1)) })
		const result = await withNumbers((db) =>
			db.run(
				SQLite.from(Numbers)
					.select(($) => ({
						id: $.id,
						// The integer column's last row falls back to the real column: 2.5 must decode.
						next: SQLite.over(SQLite.lead($.n, 1, $.x), spec($.id)),
						// A nullable fallback keeps its NULL.
						previous: SQLite.over(SQLite.lag($.n, 1, $.maybe), spec($.id)),
						first: SQLite.over(SQLite.firstValue($.n), empty($.id)),
						last: SQLite.over(SQLite.lastValue($.n), empty($.id)),
					}))
					.orderBy(["id", "asc"]),
			),
		)
		expect(result).toEqual([
			{ id: 1, next: 2, previous: null, first: null, last: null },
			{ id: 2, next: 2.5, previous: 1, first: 1, last: 1 },
		])
	})

	it("keeps a non-null first argument's codec in coalesce and ifnull, and merges an expression fallback's", async () => {
		const result = await withNumbers((db) =>
			db.run(
				SQLite.from(Numbers)
					.select(($) => ({
						at: SQLite.coalesce($.at, "2026-01-05 00:00:00.000"),
						atToo: SQLite.ifnull($.at, "2026-01-05 00:00:00.000"),
						mixed: SQLite.coalesce($.maybe, $.x),
					}))
					.orderBy(($) => [[$.id, "asc"]]),
			),
		)
		expect(result.map((row) => DateTime.formatIso(row.at))).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"])
		expect(result.map((row) => DateTime.formatIso(row.atToo))).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"])
		// `maybe` is an integer, the fallback a real: 1.5 must decode.
		expect(result.map((row) => row.mixed)).toEqual([1.5, 7])
	})

	it("decodes substr and trim as NULL when a bound or the character set is NULL", async () => {
		const result = await withNumbers((db) =>
			db.run(
				SQLite.from(Numbers)
					.select(($) => ({
						sub: SQLite.substr($.label, $.maybe),
						subLength: SQLite.substr($.label, 1, $.maybe),
						trimmed: SQLite.trim($.label, SQLite.nullif($.label, " a ")),
					}))
					.orderBy(($) => [[$.id, "asc"]]),
			),
		)
		expect(result).toEqual([
			{ sub: null, subLength: null, trimmed: null },
			{ sub: "", subLength: " b ", trimmed: "" },
		])
	})

	it("scopes an UPDATE ... FROM a tenant table by the WHERE that ties both tenants", () => {
		const Target = SQLite.table("target", { org: SQLite.text, id: SQLite.text, n: SQLite.integer }, { tenantColumn: "org" })
		const Source = SQLite.table("source", { org: SQLite.text, id: SQLite.text, n: SQLite.integer }, { tenantColumn: "org" })
		const update = (tie: boolean) =>
			SQLite.update(Target)
				.from(Source, "s")
				.set(($) => ({ n: $.s.n }))
				.where(($) => [$.org.eq("a"), $.id.eq($.s.id), tie ? $.s.org.eq($.org) : undefined])
		expect(SQLite.compileUnsafe(update(true)).tenantScope).toBe("single-tenant")
		expect(SQLite.compileUnsafe(update(false)).tenantScope).toBe("cross-tenant")
		// An untenanted target still reads the FROM table's tenants.
		const Plain = SQLite.table("plain", { id: SQLite.text, n: SQLite.integer })
		const fromScoped = (pinned: boolean) =>
			SQLite.update(Plain).from(Source, "s").set(($) => ({ n: $.s.n })).where(($) => [$.id.eq($.s.id), pinned ? $.s.org.eq("a") : undefined])
		expect(SQLite.compileUnsafe(fromScoped(true)).tenantScope).toBe("single-tenant")
		expect(SQLite.compileUnsafe(fromScoped(false)).tenantScope).toBe("cross-tenant")
	})

	it("refuses a second from() on an update, and joins a table function in the pipe API", () => {
		const Daily = SQLite.table("daily", { external: true, columns: { day: SQLite.text, dau: SQLite.integer } })
		const twice = (SQLite.update(Daily).from(Daily, "a") as any).from(Daily, "b").set(() => ({ dau: 1 })).allRows()
		expect(() => SQLite.compileUnsafe(twice)).toThrow(/from\(\) was called twice/)
		const piped = SQLite.from(Daily, "d").pipe(
			SQLite.Query.crossJoin(SQLite.jsonEach(["x"], { value: SQLite.text }), "j"),
			SQLite.Query.innerJoin(($) => SQLite.jsonEach(SQLite.jsonExtract($.j.value, "$", SQLite.text)), "k", () => SQLite.rawCond("1")),
			SQLite.Query.select(($) => ({ day: $.day, value: $.j.value })),
		)
		const sql = SQLite.compileUnsafe(piped).sql.replace(/\s+/g, " ")
		expect(sql).toContain(`CROSS JOIN json_each(?) AS "j" INNER JOIN json_each(json_extract("j"."value", '$')) AS "k" ON 1`)
	})
})

describe("runSync observability", () => {
	it("reports each statement to observeExit, with its rows or its failure, before throwing", () => {
		const db = new DatabaseSync(":memory:")
		db.exec(`CREATE TABLE bots ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "installCount" INTEGER NOT NULL)`)
		const storage: SQLite.SqlStorageLike = {
			exec: (text, ...bindings) => {
				const rows = db.prepare(text).all(...(bindings as Array<never>)) as Array<Record<string, unknown>>
				return { toArray: () => rows }
			},
		}
		const seen: Array<Db.StatementObservation> = []
		const options = { observeExit: (observation: Db.StatementObservation) => Effect.sync(() => void seen.push(observation)) }
		SQLite.runSync(storage, SQLite.insertInto(Bots).values({ id: "b1", userId: "u", installCount: 0 }), {}, options)
		expect(SQLite.runSync(storage, SQLite.from(Bots).select("id"), {}, options)).toEqual([{ id: "b1" }])
		expect(() => SQLite.runSync(storage, SQLite.insertInto(Bots).values({ id: "b1", userId: "u", installCount: 0 }), {}, options)).toThrow(/UNIQUE/)
		expect(seen.map(({ operation, collection, rows, errorType }) => ({ operation, collection, rows, failed: errorType !== undefined }))).toEqual([
			{ operation: "INSERT", collection: "bots", rows: 0, failed: false },
			{ operation: "SELECT", collection: "bots", rows: 1, failed: false },
			{ operation: "INSERT", collection: "bots", rows: undefined, failed: true },
		])
	})
})
