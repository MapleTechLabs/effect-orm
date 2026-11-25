// `contains`, `startsWith` and `endsWith` match text, not a pattern: `%`, `_`
// and the escape character in the value are escaped, on every dialect. Live
// runs on every dialect are the `text-match` core cases.

import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import * as CH from "../clickhouse"
import * as PG from "../postgres"
import * as SQLite from "../sqlite"

const Events = CH.table("events", {
	columns: { Id: CH.string, Name: CH.string, Note: CH.nullable(CH.string) },
	engine: CH.engine.mergeTree(),
	orderBy: ["Id"],
})
const Users = PG.table("users", { columns: { id: PG.text, name: PG.text }, primaryKey: ["id"] })

describe("text match", () => {
	it("contains escapes LIKE wildcards in a ClickHouse value", () => {
		const compiled = CH.compileUnsafe(CH.from(Events).select("Id").where(($) => [$.Name.contains("50%_off\\")]))
		expect(compiled.sql).toContain(String.raw`Name LIKE '%50\\%\\_off\\\\%'`)
	})

	// `%%` means the same, but ClickHouse 26.2 turns a LEFT JOIN filtered by it on the joined table into an inner one.
	it("contains of an empty string is one wildcard, on every dialect", () => {
		expect(CH.compileUnsafe(CH.from(Events).select("Id").where(($) => [$.Name.contains("")])).sql).toContain("Name LIKE '%'")
		expect(CH.compileUnsafe(CH.from(Events).select("Id").where(($) => [$.Name.contains("", { insensitive: true })])).sql).toContain("Name ILIKE '%'")
		const pg = PG.compileUnsafe(PG.from(Users).select("id").where(($) => [$.name.contains("")]))
		expect(pg.parameters).toEqual(["%"])
	})

	// ClickHouse 26.2 refuses a constant matched against a pattern computed per row, and folds '' LIKE '%%' to false.
	it("a literal matched against an expression is materialized on ClickHouse, and only there", () => {
		const prefixOf = CH.compileUnsafe(CH.from(Events).select("Id").where(($) => [CH.lit("/a/b").startsWith($.Name)]))
		expect(prefixOf.sql).toContain(String.raw`materialize('/a/b') LIKE (replace(replace(replace(events.Name, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')`)
		const insensitive = CH.compileUnsafe(CH.from(Events).select("Id").where(($) => [CH.lit("x").contains($.Name, { insensitive: true })]))
		expect(insensitive.sql).toContain("materialize('x') ILIKE (")
		for (const pattern of ["like", "notLike", "ilike"] as const) {
			const compiled = CH.compileUnsafe(CH.from(Events).select("Id").where(($) => [CH.lit("abc")[pattern]($.Name)]))
			expect(compiled.sql, pattern).toContain("materialize('abc') ")
		}
		// A column on the left, or a pattern that is a string, is written as before.
		const column = CH.compileUnsafe(CH.from(Events).select("Id").where(($) => [$.Name.contains($.Id), CH.lit("abc").like("a%"), CH.lit("abc").contains("b")]))
		expect(column.sql).not.toContain("materialize")
		const pg = PG.compileUnsafe(PG.from(Users).select("id").where(($) => [PG.lit("abc").startsWith($.name)]))
		expect(pg.sql).not.toContain("materialize")
		const sqlite = SQLite.compileUnsafe(SQLite.from(SQLite.table("t", { columns: { id: SQLite.text, name: SQLite.text }, primaryKey: ["id"] })).select("id").where(($) => [SQLite.lit("abc").startsWith($.name)]))
		expect(sqlite.sql).not.toContain("materialize")
	})

	it("startsWith and endsWith put the wildcard on one side, also on a nullable column", () => {
		const compiled = CH.compileUnsafe(
			CH.from(Events).select("Id").where(($) => [$.Name.startsWith("a_"), $.Note.endsWith("%z")]),
		)
		expect(compiled.sql).toContain(String.raw`Name LIKE 'a\\_%'`)
		expect(compiled.sql).toContain(String.raw`Note LIKE '%\\%z'`)
	})

	it("insensitive is ILIKE", () => {
		const compiled = CH.compileUnsafe(CH.from(Events).select("Id").where(($) => [$.Name.contains("Ab", { insensitive: true })]))
		expect(compiled.sql).toContain(`Name ILIKE '%Ab%'`)
	})

	it("binds the escaped value on Postgres, whose LIKE escapes with a backslash already", () => {
		const compiled = PG.compileUnsafe(
			PG.from(Users).select("id").where(($) => [$.name.contains("50%_", { insensitive: true }), $.name.startsWith("x")]),
		)
		expect(compiled.sql).toContain(`"name" ILIKE $1\n`)
		expect(compiled.sql).toMatch(/"name" LIKE \$2$/)
		expect(compiled.parameters).toEqual([String.raw`%50\%\_%`, "x%"])
	})

	it("escapes a param in SQL, since its value is known only at run time", () => {
		const query = PG.from(Users).select("id").where(($) => [$.name.endsWith(PG.param.string("q"))])
		const compiled = PG.compileUnsafe(query, { q: "a%" })
		expect(compiled.sql).toContain(
			String.raw`"name" LIKE ('%' || replace(replace(replace($1, '\', '\\'), '%', '\%'), '_', '\_'))`,
		)
		expect(compiled.parameters).toEqual(["a%"])
	})

	it("on SQLite, whose LIKE ignores ASCII case, a sensitive match is a GLOB and an insensitive one lowers both sides", () => {
		const Items = SQLite.table("items", { id: SQLite.integer, name: SQLite.text })
		const compiled = SQLite.compileUnsafe(
			SQLite.from(Items).select("id").where(($) => [$.name.contains("a*[?_"), $.name.startsWith("50%", { insensitive: true })]),
		)
		expect(compiled.sql).toContain(`"items"."name" GLOB ?\n`)
		expect(compiled.sql).toContain(String.raw`lower("items"."name") LIKE lower(?) ESCAPE '\'`)
		expect(compiled.parameters).toEqual(["*a[*][[][?]_*", String.raw`50\%%`])
		const param = SQLite.compileUnsafe(
			SQLite.from(Items).select("id").where(($) => [$.name.endsWith(SQLite.param.string("q"))]),
			{ q: "x" },
		)
		expect(param.sql).toContain(`GLOB ('*' || replace(replace(replace(?, '[', '[[]'), '*', '[*]'), '?', '[?]'))`)
	})

	it("escapeLike escapes the escape character first", () => {
		expect(CH.escapeLike(String.raw`\%_x`)).toBe(String.raw`\\\%\_x`)
	})

	it.each([[1], [{}], [null]])("a value of %o fails as QueryBuilderError", (value) => {
		const exit = Effect.runSyncExit(CH.compile(CH.from(Events).select("Id").where(($) => [$.Name.contains(value as never)])))
		expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toMatch(/contains value must be a string/)
	})
})
