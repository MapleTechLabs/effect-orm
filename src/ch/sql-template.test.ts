import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as CH from "./index"
import * as PG from "../postgres"
import * as T from "./types"
import { QueryBuilderError } from "./errors"

const Keys = CH.table("keys", { id: PG.uuid, org: PG.text, meta: PG.jsonb(), uses: PG.int8 }, { tenantColumn: "org" })
const Events = CH.table("events", { OrgId: CH.string, Count: CH.uint64, Name: CH.string }, { tenantColumn: "OrgId" })

describe("CH.sql", () => {
	it("renders columns, params and plain values per dialect, with a typed row schema", () => {
		const q = CH.from(Keys)
			.select(($) => ({ txid: CH.sql(PG.text)`pg_current_xact_id()::xid::text`, next: CH.sql(PG.int8)`${$.uses} + ${1}` }))
			.where(($) => [
				$.org.eq(CH.param.string("org")),
				CH.sql.cond`${$.meta} @> ${CH.param.string("filter")}::jsonb`,
				CH.sql.cond`${$.id} <> ${"it's"}`,
			])
		const compiled = PG.compileUnsafe(q, { org: "o", filter: '{"a":1}' })
		expect(compiled.sql).toContain('pg_current_xact_id()::xid::text AS "txid"')
		expect(compiled.sql).toContain('"keys"."uses" + 1 AS "next"')
		expect(compiled.sql).toContain(`"keys"."meta" @> $2::jsonb`)
		expect(compiled.sql).toContain(`"keys"."id" <> 'it''s'`)
		expect(compiled.parameters).toEqual(["o", '{"a":1}'])
		expect(compiled.rowSchemaSource).toBe("derived")
		expect(compiled.tenantScope).toBe("single-tenant")

		const ch = CH.compileUnsafe(
			CH.from(Events).select(($) => ({ n: CH.sql(T.uint64)`${$.Count} * ${2}` })).where(($) => [CH.sql.cond`${$.Name} = ${"it's"}`]),
		)
		expect(ch.sql).toContain("events.Count * 2 AS n")
		expect(ch.sql).toContain("WHERE events.Name = 'it\\'s'")
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
		expect(compiled.sql).toContain(`"keys"."org" IN ('a', 'b', $1)`)
		expect(compiled.sql).toMatch(/"keys"\."id" IN \(SELECT[\s\S]*"other"\."org" = \$1\)/)
		expect(compiled.sql).toContain(`length("keys"."org") > 2`)
		expect(compiled.parameters).toEqual(["z"])
		// The subquery reads `other` pinned to the same param, and the outer query is unpinned.
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

	it.effect("a value with no literal form, a bad ident, or a missing param fails the compile", () =>
		Effect.gen(function* () {
			const fails = (cond: CH.Condition, params: Record<string, unknown> = {}) =>
				Effect.flip(PG.compile(CH.from(Keys).select("id").where(() => [cond]), params))
			const array = yield* fails(CH.sql.cond`x = ANY(${["a"] as any})`)
			expect(array).toBeInstanceOf(QueryBuilderError)
			expect(array.message).toContain("typed param")
			expect((yield* fails(CH.sql.cond`${CH.sql.ident("a; drop")} = 1`)).message).toContain("not a plain identifier")
			expect((yield* fails(CH.sql.cond`x = ${CH.param.string("missing")}`)).code).toBe("UnresolvedParam")
		}),
	)

	it("works in a write's SET and WHERE", () => {
		const compiled = PG.compileUnsafe(
			CH.update(Keys)
				.set(($) => ({ meta: CH.sql(PG.jsonb())`${$.meta} || ${CH.param.string("patch")}::jsonb` }))
				.where(($) => [CH.sql.cond`${$.id} = ${CH.param.string("id")}::uuid`]),
			{ patch: "{}", id: "k" },
		)
		expect(compiled.sql).toBe('UPDATE "keys" SET "meta" = "meta" || $1::jsonb\nWHERE "id" = $2::uuid')
		expect(compiled.parameters).toEqual(["{}", "k"])
	})
})
