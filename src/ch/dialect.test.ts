import { describe, expect, it } from "@effect/vitest"
import { compile as compileFragment, str } from "../sql/sql-fragment"
import { compileCHUnsafe, compileUnionUnsafe } from "./compile"
import type { Dialect } from "./dialect"
import * as CH from "./index"

const numbered: Dialect = {
	...CH.clickhouseDialect,
	name: "numbered",
	params: { _tag: "bind", placeholder: (index) => `$${index}`, reuse: true },
}

const positional: Dialect = {
	...CH.clickhouseDialect,
	name: "positional",
	params: { _tag: "bind", placeholder: () => "?", reuse: false },
}

// Standard SQL strings: a quote is doubled, a backslash is literal text.
const standardQuote = (value: string) => `'${value.replace(/'/g, "''")}'`
const literalDialect = (name: string, quoteString: (value: string) => string): Dialect => ({
	...CH.clickhouseDialect,
	name,
	quoteString,
	literal: (value, context) => {
		if (typeof value === "string") return quoteString(value)
		if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
		return CH.clickhouseDialect.literal(value, context)
	},
	params: { _tag: "inline" },
})

// Splits the marker across two concatenated literals so no value spells it.
const standard = literalDialect("standard", (value) =>
	standardQuote(value).replace(/__PARAM_/g, "_' || '_PARAM_"),
)

// Quotes correctly but never escapes the param marker.
const naive = literalDialect("naive", standardQuote)

const events = CH.table(
	"events",
	{ OrgId: CH.string, Service: CH.string, Count: CH.uint64, Timestamp: CH.dateTime64 },
	{ tenantColumn: "OrgId" },
)

const byService = CH.from(events)
	.select(($) => ({ count: $.Count }))
	.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Service.eq(CH.param.string("service"))])

describe("dialect params", () => {
	it("ClickHouse writes params as literals and binds nothing", () => {
		const compiled = compileCHUnsafe(byService, { orgId: "org_1", service: "api" })
		expect(compiled.sql).toContain("OrgId = 'org_1'")
		expect(compiled.parameters).toEqual([])
		// Passing the default explicitly is the same compile.
		expect(compileCHUnsafe(byService, { orgId: "org_1", service: "api" }, { dialect: CH.clickhouseDialect }).sql).toBe(
			compiled.sql,
		)
	})

	it("a binding dialect leaves placeholders and returns values in order", () => {
		const compiled = compileCHUnsafe(byService, { orgId: "org_1", service: "api" }, { dialect: numbered })
		expect(compiled.sql).toContain("OrgId = $1")
		expect(compiled.sql).toContain("Service = $2")
		expect(compiled.sql).not.toContain("org_1")
		expect(compiled.parameters).toEqual(["org_1", "api"])
	})

	// The value is the column codec's wire form, the same thing an inline
	// literal is written from, not the JS value the caller passed.
	it("binds the encoded wire value", () => {
		const query = CH.from(events)
			.select(($) => ({ count: $.Count }))
			.where(($) => [$.OrgId.eq("org"), $.Timestamp.gte(CH.param.dateTime("start"))])
		const compiled = compileCHUnsafe(query, { start: new Date("2026-01-01T00:00:00.250Z") }, { dialect: numbered })
		// The compared literal is bound too, as its wire value.
		expect(compiled.parameters).toEqual(["org", "2026-01-01 00:00:00.250"])
	})

	it("numbered placeholders reuse one slot for a repeated param; positional ones bind it again", () => {
		const twice = CH.from(events)
			.select(($) => ({ count: $.Count }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Service.neq(CH.param.string("orgId"))])
		const params = { orgId: "org_1" }

		const reused = compileCHUnsafe(twice, params, { dialect: numbered })
		expect(reused.sql).toContain("OrgId = $1")
		expect(reused.sql).toContain("Service != $1")
		expect(reused.parameters).toEqual(["org_1"])

		const repeated = compileCHUnsafe(twice, params, { dialect: positional })
		expect(repeated.parameters).toEqual(["org_1", "org_1"])
	})

	// Nested queries are spliced in as text, so placeholders have to be numbered
	// once across the whole statement, not restarted in each branch.
	it("numbers placeholders across union branches and subqueries", () => {
		const branch = (service: string) =>
			CH.from(events)
				.select(($) => ({ count: $.Count }))
				.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Service.eq(CH.param.string(service))])

		const union = compileUnionUnsafe(
			CH.unionAll(branch("a"), branch("b")),
			{ orgId: "org_1", a: "api", b: "web" },
			{ dialect: numbered },
		)
		expect(union.parameters).toEqual(["org_1", "api", "web"])
		expect(union.sql.match(/\$\d/g)).toEqual(["$1", "$2", "$1", "$3"])

		const outer = compileCHUnsafe(
			CH.fromQuery(byService, "i")
				.select(($) => ({ total: CH.sum($.count) }))
				.where(($) => [$.count.gt(CH.param.int("min"))]),
			{ orgId: "org_1", service: "api", min: 5 },
			{ dialect: numbered },
		)
		expect(outer.parameters).toEqual(["org_1", "api", 5])
		expect(outer.tenantScope).toBe("single-tenant")
	})

	it("still fails a missing or ill-typed param at compile time", () => {
		// @ts-expect-error -- a missing param is a type error too
		expect(() => compileCHUnsafe(byService, { orgId: "org_1" }, { dialect: numbered })).toThrow(
			/no value given for param 'service'/,
		)
		// @ts-expect-error -- a mistyped param is a type error too
		expect(() => compileCHUnsafe(byService, { orgId: 1, service: "api" }, { dialect: numbered })).toThrow(
			/param 'orgId'/,
		)
	})
})

describe("dialect literal syntax", () => {
	it("writes column literals, string fragments and inline params in the dialect's syntax", () => {
		const query = CH.from(events)
			.select(($) => ({ count: $.Count }))
			.where(($) => [
				$.OrgId.eq(CH.param.string("orgId")),
				$.Service.eq("O'Reilly\\"),
				$.Service.like("%it's%"),
			])
		const compiled = compileCHUnsafe(query, { orgId: "a'b" }, { dialect: standard })
		expect(compiled.sql).toContain("OrgId = 'a''b'")
		expect(compiled.sql).toContain("Service = 'O''Reilly\\'")
		expect(compiled.sql).toContain("Service LIKE '%it''s%'")

		// The same query for ClickHouse keeps its backslash escapes.
		const clickhouse = compileCHUnsafe(query, { orgId: "a'b" })
		expect(clickhouse.sql).toContain("OrgId = 'a\\'b'")
		expect(clickhouse.sql).toContain("Service = 'O\\'Reilly\\\\'")
	})

	it("reaches union branches and subqueries", () => {
		const branch = CH.from(events)
			.select(($) => ({ count: $.Count }))
			.where(($) => [$.OrgId.eq("it's")])
		const union = compileUnionUnsafe(CH.unionAll(branch, branch), {}, { dialect: standard })
		expect(union.sql.match(/'it''s'/g)).toHaveLength(2)

		const outer = compileCHUnsafe(
			CH.fromQuery(branch, "i").select(($) => ({ total: CH.sum($.count) })),
			{},
			{ dialect: standard },
		)
		expect(outer.sql).toContain("OrgId = 'it''s'")
	})

	it("is only installed for the compile", () => {
		compileCHUnsafe(byService, { orgId: "o", service: "s" }, { dialect: standard })
		expect(compileFragment(str("it's"))).toBe("'it\\'s'")
	})

	// Params are resolved by rewriting the finished SQL, so a literal that spells
	// a placeholder would be rewritten too. A dialect that fails to escape the
	// marker is refused instead of trusted.
	it("refuses a literal that spells the param marker", () => {
		const smuggle = CH.from(events)
			.select(($) => ({ count: $.Count }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Service.eq("__PARAM_string_orgId__")])

		expect(() => compileCHUnsafe(smuggle, { orgId: "o" }, { dialect: naive })).toThrow(/reserved param marker/)
		expect(compileCHUnsafe(smuggle, { orgId: "o" }, { dialect: standard }).sql).toContain(
			"Service = '_' || '_PARAM_string_orgId__'",
		)
	})
})

describe("dialect identifiers and clauses", () => {
	const quoted: Dialect = {
		...CH.clickhouseDialect,
		name: "quoted",
		quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
		clauses: { format: false, derivedTableAlias: true, groupByAlias: true, parenthesizeUnionBranches: false },
	}
	const services = CH.table("db.services", { OrgId: CH.string, Service: CH.string }, { tenantColumn: "OrgId" })

	it("quotes columns, qualifiers, tables, aliases, group and order keys", () => {
		const query = CH.from(events)
			.innerJoin(services, "s", (main, s) => main.Service.eq(s.Service))
			.select(($) => ({ service: $.s.Service, count: CH.count() }))
			.where(($) => [$.OrgId.eq("o")])
			.groupBy("service")
			.orderBy(["count", "desc"])
		const { sql } = compileCHUnsafe(query, {}, { dialect: quoted })
		expect(sql).toContain(`"s"."Service" AS "service"`)
		expect(sql).toContain(`INNER JOIN "db"."services" AS "s" ON "events"."Service" = "s"."Service"`)
		expect(sql).toContain(`FROM "events"`)
		expect(sql).toContain(`WHERE "events"."OrgId" = 'o'`)
		expect(sql).toContain(`GROUP BY "service"`)
		expect(sql).toContain(`ORDER BY "count" DESC`)
	})

	it("aliases a wrapped union and refuses FORMAT where the dialect has neither", () => {
		const branch = CH.from(events)
			.select(($) => ({ count: $.Count }))
			.where(($) => [$.OrgId.eq("o")])
		const union = compileUnionUnsafe(CH.unionAll(branch, branch).orderBy(["count", "asc"]), {}, { dialect: quoted })
		expect(union.sql).toContain(`) AS "__union"\nORDER BY "count" ASC`)

		expect(() => compileCHUnsafe(branch.format("JSON"), {}, { dialect: quoted })).toThrow(/no FORMAT clause/)
		expect(compileCHUnsafe(branch.format("JSON"), {}).sql).toMatch(/FORMAT JSON$/)
	})
})
