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
