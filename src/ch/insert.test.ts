import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Exit } from "effect"
import * as CH from "./index"
import * as PG from "../postgres"
import * as CHD from "../clickhouse"
import { QueryBuilderDefect, QueryBuilderError } from "./errors"

const Events = CH.table(
	"events",
	{
		OrgId: CH.string,
		Id: CH.uint64,
		At: CH.dateTime,
		Attrs: CH.map(CH.string, CH.string),
		Note: CH.nullable(CH.string),
		Tags: CH.array(CH.string),
	},
	{ tenantColumn: "OrgId", defaults: ["Id"] },
)

const Keys = CH.table(
	"api_keys",
	{ id: PG.uuid, org_id: PG.text, name: PG.text, created_at: PG.timestamptz, revoked: PG.bool, meta: PG.jsonb() },
	{ defaults: ["created_at", "revoked"] },
)

const failure = (exit: Exit.Exit<unknown, unknown>) =>
	Exit.isFailure(exit) ? exit.cause.reasons.map((r) => ("error" in r ? r.error : "defect" in r ? r.defect : r))[0] : undefined

describe("insertInto", () => {
	it("writes columns in table order whatever the key order, and DEFAULT for a missing key", () => {
		const compiled = CH.compileUnsafe(
			CH.insertInto(Events).values([
				{ Tags: ["x"], Note: null, Attrs: { a: "it's" }, At: new Date(0), OrgId: "o1" },
				{ OrgId: "o1", Id: 5, At: "2026-01-01 00:00:00", Attrs: {}, Note: "n", Tags: [] },
			]),
		)
		expect(compiled.sql).toBe(
			"INSERT INTO events (OrgId, Id, At, Attrs, Note, Tags)\n" +
				"VALUES ('o1', DEFAULT, '1970-01-01 00:00:00', map('a', 'it\\'s'), NULL, ['x']), " +
				"('o1', 5, '2026-01-01 00:00:00', map(), 'n', [])",
		)
		expect(compiled.kind).toBe("insert")
		expect(compiled.parameters).toEqual([])
		expect(compiled.dialect).toBe("clickhouse")
	})

	it("leaves out a column no row gives", () => {
		const compiled = CH.compileUnsafe(
			CH.insertInto(Events).values({ OrgId: "o", At: DateTime.makeUnsafe(0), Attrs: {}, Tags: [] }),
		)
		expect(compiled.sql).toBe("INSERT INTO events (OrgId, At, Attrs, Tags)\nVALUES ('o', '1970-01-01 00:00:00', map(), [])")
	})

	it("binds every value on Postgres, one placeholder per param", () => {
		const compiled = PG.compileUnsafe(
			CH.insertInto(Keys).values([
				{ id: CH.param.string("id"), org_id: CH.param.string("org"), name: "a", meta: { k: 1 } },
				{ id: "b", org_id: CH.param.string("org"), name: "it's", revoked: true, meta: null },
			]),
			{ id: "a", org: "o1" },
		)
		expect(compiled.sql).toBe(
			'INSERT INTO "api_keys" ("id", "org_id", "name", "revoked", "meta")\n' +
				"VALUES ($1, $2, $3, DEFAULT, $4), ($5, $2, $6, $7, $8)",
		)
		expect(compiled.parameters).toEqual(["a", "o1", "a", '{"k":1}', "b", "it's", true, "null"])
		expect(compiled.dialect).toBe("postgres")
	})

	it("writes an expression as SQL", () => {
		const Stamps = CH.table("stamps", { At: CH.dateTime, N: CH.uint64 })
		const compiled = CH.compileUnsafe(
			CH.insertInto(Stamps).values({ At: CH.rawExpr("now()", CH.dateTime), N: CH.toUInt64(CH.lit("7")) }),
		)
		expect(compiled.sql).toBe("INSERT INTO stamps (At, N)\nVALUES (now(), toUInt64('7'))")
	})

	it("is immutable: values replaces, and a later push to the array changes nothing", () => {
		const rows = [{ OrgId: "a", At: new Date(0), Attrs: {}, Tags: [] }]
		const base = CH.insertInto(Events)
		const first = base.values(rows)
		rows.push({ OrgId: "b", At: new Date(0), Attrs: {}, Tags: [] })
		const second = first.values({ OrgId: "c", At: new Date(0), Attrs: {}, Tags: [] })
		expect(CH.compileUnsafe(first).sql).toContain("('a'")
		expect(CH.compileUnsafe(first).sql).not.toContain("'b'")
		expect(CH.compileUnsafe(second).sql).toContain("('c'")
		expect(CH.compileUnsafe(second).sql).not.toContain("'a'")
		expect((base as unknown as CH.CHInsert)._state.rows).toBeUndefined()
	})

	it("a value that could spell a param marker stays a value", () => {
		const Notes = CH.table("notes", { Body: CH.string })
		const compiled = CH.compileUnsafe(CH.insertInto(Notes).values({ Body: "__PARAM_string_x__" }), { x: "boom" })
		expect(compiled.sql).toBe("INSERT INTO notes (Body)\nVALUES ('\\x5F_PARAM_string_x__')")
	})

	describe("returning", () => {
		it.effect("writes RETURNING and derives the row schema from it", () =>
			Effect.gen(function* () {
				const compiled = PG.compileUnsafe(
					CH.insertInto(Keys)
						.values({ id: "a", org_id: "o", name: "n", meta: {} })
						.returning(($) => ({ id: $.id, createdAt: $.created_at })),
				)
				expect(compiled.sql).toBe(
					'INSERT INTO "api_keys" ("id", "org_id", "name", "meta")\nVALUES ($1, $2, $3, $4)\n' +
						'RETURNING "id" AS "id", "created_at" AS "createdAt"',
				)
				expect(compiled.returning).toEqual(["id", "createdAt"])
				expect(compiled.rowSchemaSource).toBe("derived")
				const at = "2026-01-02T03:04:05.000Z"
				const [row] = yield* compiled.decodeRows([{ id: "a", createdAt: at }])
				expect(row!.id).toBe("a")
				expect(DateTime.formatIso(row!.createdAt)).toBe(at)
			}),
		)

		it("with no arguments returns every column, like Drizzle's bare returning()", () => {
			const compiled = PG.compileUnsafe(CH.insertInto(Keys).values({ id: "a", org_id: "o", name: "n", meta: {} }).returning())
			expect(compiled.returning).toEqual(["id", "org_id", "name", "created_at", "revoked", "meta"])
			expect(compiled.rowSchemaSource).toBe("derived")
		})

		it("takes column names, and calling it again replaces the list", () => {
			const insert = CH.insertInto(Keys).values({ id: "a", org_id: "o", name: "n", meta: {} })
			expect(PG.compileUnsafe(insert.returning("id", "revoked")).sql).toMatch(/RETURNING "id" AS "id", "revoked" AS "revoked"$/)
			expect(PG.compileUnsafe(insert.returning("revoked").returning("id")).returning).toEqual(["id"])
			expect(PG.compileUnsafe(insert).returning).toBeUndefined()
		})

		it("an untyped expression leaves the insert undecoded, and names the alias", () => {
			const compiled = PG.compileUnsafe(
				CH.insertInto(Keys)
					.values({ id: "a", org_id: "o", name: "n", meta: {} })
					.returning(() => ({ txid: CH.untypedExpr("pg_current_xact_id()::xid::text") })),
			)
			expect(compiled.sql).toMatch(/RETURNING pg_current_xact_id\(\)::xid::text AS "txid"$/)
			expect(compiled.rowSchemaSource).toBe("none")
			expect(compiled.untypedColumns).toEqual(["txid"])
		})

		it.effect("is a defect on ClickHouse, which has no RETURNING", () =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(
					CH.compile(CH.insertInto(Events).values({ OrgId: "o", At: new Date(0), Attrs: {}, Tags: [] }).returning("Id")),
				)
				expect(failure(exit)).toBeInstanceOf(QueryBuilderDefect)
			}),
		)
	})

	describe("on conflict", () => {
		const Counters = CH.table("counters", { org: PG.text, key: PG.text, count: PG.int8, locked: PG.bool }, { tenantColumn: "org" })
		const row = { org: "o", key: "k", count: 1, locked: false }

		it("DO NOTHING, with and without a target", () => {
			const insert = CH.insertInto(Counters).values(row)
			expect(PG.compileUnsafe(insert.onConflictDoNothing()).sql).toMatch(/\nON CONFLICT DO NOTHING$/)
			expect(PG.compileUnsafe(insert.onConflictDoNothing({ target: ["org", "key"] })).sql).toMatch(
				/\nON CONFLICT \("org", "key"\) DO NOTHING$/,
			)
			expect(PG.compileUnsafe(insert.onConflictDoNothing({ target: { constraint: "counters_pkey" } })).sql).toMatch(
				/\nON CONFLICT ON CONSTRAINT "counters_pkey" DO NOTHING$/,
			)
			expect(
				PG.compileUnsafe(insert.onConflictDoNothing({ target: ["key"], targetWhere: ($) => $.locked.eq(false) })).sql,
			).toMatch(/\nON CONFLICT \("key"\) WHERE "locked" = FALSE DO NOTHING$/)
		})

		it("DO UPDATE with excluded, a qualified existing row, values and a WHERE", () => {
			const compiled = PG.compileUnsafe(
				CH.insertInto(Counters)
					.values(row)
					.onConflictDoUpdate({
						target: ["org", "key"],
						set: ($, excluded) => ({ count: $.count.add(excluded.count), locked: true }),
						where: ($) => $.locked.eq(false),
					})
					.returning("count"),
			)
			expect(compiled.sql).toBe(
				'INSERT INTO "counters" ("org", "key", "count", "locked")\nVALUES ($1, $2, $3, $4)\n' +
					'ON CONFLICT ("org", "key") DO UPDATE SET "count" = "counters"."count" + "excluded"."count", "locked" = $5 ' +
					'WHERE "counters"."locked" = $6\nRETURNING "count" AS "count"',
			)
			expect(compiled.parameters).toEqual(["o", "k", 1, false, true, false])
		})

		it("a SET that writes another tenant makes the insert cross-tenant", () => {
			const insert = CH.insertInto(Counters).values(row)
			const scope = (org: string) =>
				PG.compileUnsafe(insert.onConflictDoUpdate({ target: ["key"], set: { org } })).tenantScope
			expect(scope("o")).toBe("single-tenant")
			expect(scope("p")).toBe("cross-tenant")
		})

		it.effect("a bad SET fails; misuse and ClickHouse are defects", () =>
			Effect.gen(function* () {
				const insert = CH.insertInto(Counters).values(row)
				const empty = yield* Effect.flip(
					PG.compile(insert.onConflictDoUpdate({ target: ["key"], set: { count: undefined } })),
				)
				expect(empty.message).toContain("sets no columns")
				const unknown = yield* Effect.flip(
					PG.compile(insert.onConflictDoUpdate({ target: ["key"], set: { nope: 1 } as any })),
				)
				expect(unknown.code).toBe("InvalidArguments")
				for (const bad of [
					PG.compile(insert.onConflictDoNothing({ target: [] })),
					PG.compile(insert.onConflictDoNothing({ targetWhere: ($) => $.locked.eq(false) })),
					PG.compile(insert.onConflictDoNothing({ target: { constraint: "c" }, targetWhere: ($) => $.locked.eq(false) })),
					CH.compile(insert.onConflictDoNothing()),
				]) {
					expect(failure(yield* Effect.exit(bad))).toBeInstanceOf(QueryBuilderDefect)
				}
			}),
		)
	})

	describe("insert ... select", () => {
		const Spans = CH.table("spans", { OrgId: CH.string, Name: CH.string, Ms: CH.uint64 }, { tenantColumn: "OrgId" })
		const Daily = CH.table("daily", { OrgId: CH.string, Name: CH.string, Total: CH.uint64 }, { tenantColumn: "OrgId" })

		it("names the columns from the selected aliases, in select order", () => {
			const compiled = CH.compileUnsafe(
				CH.insertInto(Daily).select(
					CH.from(Spans)
						.select(($) => ({ Total: CH.sum($.Ms), OrgId: $.OrgId, Name: $.Name }))
						.where(($) => [$.OrgId.eq(CH.param.string("org"))])
						.groupBy("OrgId", "Name"),
				),
				{ org: "o" },
			)
			expect(compiled.sql).toMatch(/^INSERT INTO daily \(Total, OrgId, Name\)\nSELECT\s+sum\(spans\.Ms\) AS Total,\s+spans\.OrgId AS OrgId,/)
			expect(compiled.sql).toMatch(/WHERE spans\.OrgId = 'o'\s+GROUP BY OrgId, Name$/)
			expect(compiled.tenantScope).toBe("single-tenant")
		})

		it("binds the query's params on Postgres, with values and select sharing the numbering", () => {
			const Src = CH.table("src", { org: PG.text, n: PG.int4 })
			const Dst = CH.table("dst", { org: PG.text, n: PG.int4 })
			const compiled = PG.compileUnsafe(
				CH.insertInto(Dst)
					.select(CH.from(Src).select("org", "n").where(($) => [$.org.eq(CH.param.string("org"))]))
					.onConflictDoUpdate({ target: ["org"], set: { n: CH.param.int("n") } }),
				{ org: "o", n: 3 },
			)
			expect(compiled.sql).toMatch(/^INSERT INTO "dst" \("org", "n"\)\nSELECT[\s\S]*WHERE "src"\."org" = \$1\nON CONFLICT \("org"\) DO UPDATE SET "n" = \$2$/)
			expect(compiled.parameters).toEqual(["o", 3])
		})

		it("takes a union", () => {
			const branch = (org: string) =>
				CH.from(Spans).select(($) => ({ OrgId: $.OrgId, Name: $.Name, Total: $.Ms })).where(($) => [$.OrgId.eq(org)])
			const compiled = CH.compileUnsafe(CH.insertInto(Daily).select(CH.unionAll(branch("a"), branch("b"))))
			expect(compiled.sql).toMatch(/^INSERT INTO daily \(OrgId, Name, Total\)\nSELECT[\s\S]*UNION ALL[\s\S]*'b'$/)
			expect(compiled.tenantScope).toBe("cross-tenant")
		})

		it("tenant scope follows the read and where the tenant column comes from", () => {
			const scope = (query: CH.CHQuery<any, any, any, any>, params: Record<string, unknown> = { org: "o" }) =>
				CH.compileUnsafe(CH.insertInto(Daily).select(query as any), params).tenantScope
			const pinned = CH.from(Spans).where(($) => [$.OrgId.eq(CH.param.string("org"))])
			expect(scope(pinned.select(($) => ({ OrgId: $.OrgId, Name: $.Name, Total: $.Ms })))).toBe("single-tenant")
			expect(scope(pinned.select(($) => ({ OrgId: CH.param.string("org"), Name: $.Name, Total: $.Ms })))).toBe("single-tenant")
			// Pinned read, but the rows are written to another tenant.
			expect(scope(pinned.select(($) => ({ OrgId: CH.param.string("other"), Name: $.Name, Total: $.Ms })), { org: "o", other: "p" })).toBe(
				"cross-tenant",
			)
			expect(scope(CH.from(Spans).select(($) => ({ OrgId: $.OrgId, Name: $.Name, Total: $.Ms })))).toBe("cross-tenant")
			// An untenanted target reads with the query's scope.
			const Names = CH.table("names", { Name: CH.string })
			expect(CH.compileUnsafe(CH.insertInto(Names).select(pinned.select("Name")), { org: "o" }).tenantScope).toBe("single-tenant")
			expect(CH.compileUnsafe(CH.insertInto(Names).select(CH.from(Spans).select("Name"))).tenantScope).toBe("cross-tenant")
		})

		it("select and values replace each other", () => {
			const fromQuery = CH.insertInto(Daily).select(CH.from(Daily).select("OrgId", "Name", "Total"))
			expect(CH.compileUnsafe(fromQuery.values({ OrgId: "o", Name: "n", Total: 1 })).sql).toContain("VALUES")
			expect(CH.compileUnsafe(fromQuery.values({ OrgId: "o", Name: "n", Total: 1 }).select(CH.from(Daily).select("OrgId", "Name", "Total"))).sql).toContain(
				"SELECT",
			)
		})
	})

	describe("settings", () => {
		const Notes = CH.table("notes", { Body: CH.string })

		it("writes SETTINGS before VALUES on ClickHouse", () => {
			const compiled = CH.compileUnsafe(
				CH.insertInto(Notes).values({ Body: "x" }).settings({ async_insert: 1, wait_for_async_insert: true, insert_deduplication_token: "t'1" }),
			)
			expect(compiled.sql).toBe(
				"INSERT INTO notes (Body) SETTINGS async_insert = 1, wait_for_async_insert = 1, insert_deduplication_token = 't\\'1'\nVALUES ('x')",
			)
		})

		it.effect("a bad name and Postgres are defects", () =>
			Effect.gen(function* () {
				const insert = CH.insertInto(Notes).values({ Body: "x" })
				expect(failure(yield* Effect.exit(CH.compile(insert.settings({ "a b": 1 }))))).toBeInstanceOf(QueryBuilderDefect)
				expect(failure(yield* Effect.exit(PG.compile(insert.settings({ a: 1 }))))).toBeInstanceOf(QueryBuilderDefect)
				expect(PG.compileUnsafe(insert.settings({})).sql).not.toContain("SETTINGS")
			}),
		)
	})

	describe("tenant scope", () => {
		const scope = (rows: ReadonlyArray<Record<string, unknown>>, params: Record<string, unknown> = {}) =>
			CH.compileUnsafe(CH.insertInto(Events).values(rows as any), params).tenantScope
		const row = { At: new Date(0), Attrs: {}, Tags: [] }

		it("single-tenant when every row gives the same value or param", () => {
			expect(scope([{ ...row, OrgId: "o" }, { ...row, OrgId: "o" }])).toBe("single-tenant")
			expect(scope([{ ...row, OrgId: CH.param.string("org") }], { org: "o" })).toBe("single-tenant")
			// The same tenant as a literal and as a param.
			expect(scope([{ ...row, OrgId: CH.param.string("org") }, { ...row, OrgId: "o" }], { org: "o" })).toBe(
				"single-tenant",
			)
		})

		it("cross-tenant when rows differ or a row cannot be read", () => {
			expect(scope([{ ...row, OrgId: "a" }, { ...row, OrgId: "b" }])).toBe("cross-tenant")
			expect(scope([{ ...row, OrgId: CH.rawExpr("'a'", CH.string) }])).toBe("cross-tenant")
		})

		it("untenanted for a table without a tenant column", () => {
			const Plain = CH.table("plain", { A: CH.string })
			expect(CH.compileUnsafe(CH.insertInto(Plain).values({ A: "x" })).tenantScope).toBe("untenanted")
		})
	})

	describe("failures", () => {
		it.effect("no rows, an unknown column, an empty row, and a bad value fail in the error channel", () =>
			Effect.gen(function* () {
				const Plain = CH.table("plain", { A: CH.uint32, B: CH.nullable(CH.string) })
				const errors = yield* Effect.all(
					[
						// @ts-expect-error -- no rows is a type error too
						CH.compile(CH.insertInto(Plain).values([])),
						CH.compile(CH.insertInto(Plain).values({ A: 1, C: 2 } as any)),
						CH.compile(CH.insertInto(Plain).values([{ B: undefined } as any])),
						CH.compile(CH.insertInto(Plain).values({ A: null as any })),
						// @ts-expect-error -- a missing param is a type error too
						CH.compile(CH.insertInto(Plain).values({ A: CH.param.int("a") })),
					].map(Effect.flip),
				)
				for (const error of errors) expect(error).toBeInstanceOf(QueryBuilderError)
				expect(errors.map((e) => e.code)).toEqual([
					"InvalidArguments",
					"InvalidArguments",
					"InvalidArguments",
					"InvalidLiteral",
					"UnresolvedParam",
				])
				expect(errors[1]!.message).toContain('row 0 has "C"')
				expect(errors[3]!.message).toContain("row 0, column A")
			}),
		)

		// The type refuses it (`CHInsertStart`); this is the runtime guard behind it.
		it.effect("compiling without values is a defect", () =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(CH.compile(CH.insertInto(Events) as unknown as CH.CHInsert))
				expect(failure(exit)).toBeInstanceOf(QueryBuilderDefect)
			}),
		)

		it("a statement over Postgres's parameter limit fails to compile", () => {
			const Wide = CH.table("wide", { A: PG.int4 })
			const rows = Array.from({ length: 65536 }, (_, i) => ({ A: i }))
			expect(() => PG.compileUnsafe(CH.insertInto(Wide).values(rows))).toThrow(/65536 values, over the 65535/)
			expect(PG.compileUnsafe(CH.insertInto(Wide).values(rows.slice(1))).parameters).toHaveLength(65535)
		})
	})

	it.effect("a column table() marks computed cannot be inserted", () =>
		Effect.gen(function* () {
			const Docs = CH.table("docs", { id: PG.int4, body: PG.text, search: PG.text }, { computed: ["search"] })
			expect(Docs.computed).toEqual(["search"])
			const error = yield* Effect.flip(PG.compile(CH.insertInto(Docs).values({ id: 1, body: "b", search: "x" } as any)))
			expect(error.message).toContain("writes search, which the database computes")
			// Still readable, and returned by a bare returning().
			expect(PG.compileUnsafe(CH.insertInto(Docs).values({ id: 1, body: "b" }).returning()).returning).toEqual(["id", "body", "search"])
		}),
	)

	describe("defineTable", () => {
		const Spans = CHD.table("spans", {
			columns: {
				OrgId: CH.string,
				Duration: CHD.column(CH.uint64, { default: 0 }),
				Started: CHD.column(CH.dateTime, { defaultExpr: "now()" }),
				Day: CHD.column(CH.string, { materialized: "toString(toDate(Started))" }),
				Label: CHD.column(CH.string, { comment: "shown in the UI" }),
			},
			engine: CHD.engine.mergeTree(),
			orderBy: ["OrgId"],
		})

		it("records which columns have defaults and which are computed", () => {
			expect(Spans.defaults).toEqual(["Duration", "Started"])
			expect(Spans.computed).toEqual(["Day"])
		})

		it.effect("refuses a computed column at runtime too", () =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(CH.compile(CH.insertInto(Spans).values({ OrgId: "o", Label: "l", Day: "x" } as any)))
				expect(error.message).toContain("writes Day, which the database computes")
			}),
		)
	})
})
