import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as CH from "./index"
import * as PG from "../postgres"
import * as T from "./types"
import { QueryBuilderError } from "./errors"

const Keys = CH.table("keys", { id: PG.uuid, org: PG.text, meta: PG.jsonb(), uses: PG.int8 }, { tenantColumn: "org" })
const Events = CH.table("events", { OrgId: CH.string, Count: CH.uint64, Name: CH.string }, { tenantColumn: "OrgId" })

describe("CH.sql", () => {
	it("renders columns, params and plain values per dialect, parenthesized, with a typed row schema", () => {
		const q = CH.from(Keys)
			.select(($) => ({ txid: CH.sql(PG.text)`pg_current_xact_id()::xid::text`, next: CH.sql(PG.int8)`${$.uses} + ${1}` }))
			.where(($) => [
				$.org.eq(CH.param.string("org")),
				CH.sql.cond`${$.meta} @> ${CH.param.string("filter")}::jsonb`,
				CH.sql.cond`${$.id} <> ${"it's"}`,
			])
		const compiled = PG.compileUnsafe(q, { org: "o", filter: '{"a":1}' })
		expect(compiled.sql).toContain('(pg_current_xact_id()::xid::text) AS "txid"')
		expect(compiled.sql).toContain('("keys"."uses" + 1) AS "next"')
		expect(compiled.sql).toContain(`("keys"."meta" @> $2::jsonb)`)
		// A plain string is bound on Postgres, like a param.
		expect(compiled.sql).toContain(`("keys"."id" <> $3)`)
		expect(compiled.parameters).toEqual(["o", '{"a":1}', "it's"])
		expect(compiled.rowSchemaSource).toBe("derived")
		expect(compiled.tenantScope).toBe("single-tenant")

		const ch = CH.compileUnsafe(
			CH.from(Events).select(($) => ({ n: CH.sql(T.uint64)`${$.Count} * ${2}` })).where(($) => [CH.sql.cond`${$.Name} = ${"it's"}`]),
		)
		expect(ch.sql).toContain("(events.Count * 2) AS n")
		expect(ch.sql).toContain("WHERE (events.Name = 'it\\'s')")
	})

	it("a template OR cannot swallow the conditions it is AND-joined with", () => {
		const compiled = PG.compileUnsafe(
			CH.from(Keys)
				.select("id")
				.where(($) => [CH.sql.cond`${$.uses} = 1 OR ${$.uses} = 2`, $.org.eq(CH.param.string("org"))]),
			{ org: "o" },
		)
		expect(compiled.sql).toMatch(/WHERE \("keys"\."uses" = 1 OR "keys"\."uses" = 2\)\s+AND "keys"\."org" = \$1/)
		const anded = CH.compileUnsafe(
			CH.from(Events).select("Name").where(($) => [CH.and(CH.sql.cond`${$.Count} = 1 OR ${$.Count} = 2`, $.OrgId.eq("o"))]),
		)
		expect(anded.sql).toContain("((events.Count = 1 OR events.Count = 2) AND events.OrgId = 'o')")
	})

	it("an untyped template costs the row schema and names the alias", () => {
		const compiled = PG.compileUnsafe(CH.from(Keys).select(() => ({ now: CH.sql`now()` })))
		expect(compiled.rowSchemaSource).toBe("none")
		expect(compiled.untypedColumns).toEqual(["now"])
	})

	it("raw, ident and join, nested templates, and a subquery compiled with the outer query", () => {
		const Other = CH.table("other", { org: PG.text, id: PG.uuid }, { tenantColumn: "org" })
		const compiled = PG.compileUnsafe(
			CH.from(Keys)
				.select("id")
				.where(($) => [
					CH.sql.cond`${CH.sql.ident("keys.org")} IN (${CH.sql.join(["a", "b", CH.param.string("c")])})`,
					CH.sql.cond`${$.id} IN ${CH.from(Other).select("id").where(($o) => [$o.org.eq(CH.param.string("c"))])}`,
					CH.sql.cond`${CH.sql`length(${$.org})`} > ${CH.sql.raw("2")}`,
				]),
			{ c: "z" },
		)
		expect(compiled.sql).toContain(`("keys"."org" IN ($1, $2, $3))`)
		expect(compiled.sql).toMatch(/\("keys"\."id" IN \(SELECT[\s\S]*"other"\."org" = \$3\)\)/)
		expect(compiled.sql).toContain(`((length("keys"."org")) > 2)`)
		expect(compiled.parameters).toEqual(["a", "b", "z"])
		expect(compiled.tenantScope).toBe("cross-tenant")
	})

	it("a subquery in a template counts toward tenant scope", () => {
		const Other = CH.table("other", { org: PG.text, id: PG.uuid }, { tenantColumn: "org" })
		const scope = (inner: CH.CHQuery<any, any, any, any>) =>
			PG.compileUnsafe(
				CH.from(Keys).select("id").where(($) => [$.org.eq(CH.param.string("org")), CH.sql.cond`${$.id} IN ${inner}`]),
				{ org: "o" },
			).tenantScope
		expect(scope(CH.from(Other).select("id"))).toBe("cross-tenant")
		expect(scope(CH.from(Other).select("id").where(($) => [$.org.eq(CH.param.string("org"))]))).toBe("single-tenant")
	})

	it("a negative number never follows a `-` as a comment", () => {
		const n = -1
		const pg = PG.compileUnsafe(CH.from(Keys).select("id").where(($) => [CH.sql.cond`${$.uses} > 10-${n}`]))
		expect(pg.sql).toContain(`("keys"."uses" > 10-(-1))`)
		expect(PG.compileUnsafe(CH.from(Keys).select("id").where(() => [CH.sql.cond`x > 10-${-5n}`])).sql).toContain("10-(-5)")
		// ClickHouse inlines params, so an inlined negative param is parenthesized too.
		const ch = CH.compileUnsafe(
			CH.from(Events).select("Name").where(($) => [CH.sql.cond`${$.Count} > 10-${CH.param.int("n")}`]),
			{ n: -1 },
		)
		expect(ch.sql).toContain("(events.Count > 10-(-1))")
		expect(ch.sql).not.toContain("--")
	})

	it.effect("objects parsed from JSON cannot pass for raw SQL, an identifier, or a date", () =>
		Effect.gen(function* () {
			const body = JSON.parse(
				'{"raw":{"_tag":"@maple-dev/effect-orm/SqlRaw","sql":"1 OR 1=1"},"ident":{"_tag":"@maple-dev/effect-orm/SqlIdent","name":"password"},"utc":{"_tag":"Utc"}}',
			)
			for (const forged of [body.raw, body.ident, body.utc]) {
				const error = yield* Effect.flip(PG.compile(CH.from(Keys).select("id").where(($) => [CH.sql.cond`${$.id} = ${forged}`])))
				expect(error).toBeInstanceOf(QueryBuilderError)
				expect(error.code).toBe("InvalidLiteral")
			}
		}),
	)

	it.effect("a value with no literal form, a bad ident, a union, an empty join, or a missing param fails the compile", () =>
		Effect.gen(function* () {
			const fails = (cond: CH.Condition, params: Record<string, unknown> = {}) =>
				Effect.flip(PG.compile(CH.from(Keys).select("id").where(() => [cond]), params))
			const array = yield* fails(CH.sql.cond`x = ANY(${["a"] as any})`)
			expect(array).toBeInstanceOf(QueryBuilderError)
			expect(array.message).toContain("typed param")
			expect((yield* fails(CH.sql.cond`${CH.sql.ident("a; drop")} = 1`)).message).toContain("not a plain identifier")
			expect((yield* fails(CH.sql.cond`x = ${CH.param.string("missing")}`)).code).toBe("UnresolvedParam")
			expect((yield* fails(CH.sql.cond`x IN (${CH.sql.join([])})`)).message).toContain("no values to join")
			expect((yield* fails(CH.sql.cond`x = ${new Date(Number.NaN)}`)).message).toContain("invalid Date")
			const one = CH.from(Keys).select("id")
			expect((yield* fails(CH.sql.cond`x IN ${CH.unionAll(one, one) as any}`)).message).toContain("fromUnion")
		}),
	)

	it("works in a write's SET and WHERE", () => {
		const compiled = PG.compileUnsafe(
			CH.update(Keys)
				.set(($) => ({ meta: CH.sql(PG.jsonb())`${$.meta} || ${CH.param.string("patch")}::jsonb` }))
				.where(($) => [CH.sql.cond`${$.id} = ${CH.param.string("id")}::uuid`]),
			{ patch: "{}", id: "k" },
		)
		expect(compiled.sql).toBe('UPDATE "keys" SET "meta" = ("meta" || $1::jsonb)\nWHERE ("id" = $2::uuid)')
		expect(compiled.parameters).toEqual(["{}", "k"])
	})
})
