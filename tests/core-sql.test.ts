// The exact SQL and bound parameters each core case compiles to, per dialect.
// The live suites prove the SQL runs; these pin it, so a change in output is a
// reviewed snapshot diff rather than a surprise. Fixture CTE bodies are elided.
import { describe, expect, it } from "vitest"
import { contexts, coreCases, fixtureSql, type DialectName } from "./core-cases"

const elideFixtures = (dialect: DialectName, sql: string) =>
	sql
		.replaceAll(fixtureSql(dialect, "orders"), "<orders fixture>")
		.replaceAll(fixtureSql(dialect, "customers"), "<customers fixture>")

for (const dialect of ["clickhouse", "postgres", "sqlite", "d1"] as const) {
	describe(`core SQL (${dialect})`, () => {
		for (const fixture of coreCases) {
			it(fixture.id, () => {
				const rejects = fixture.rejects?.[dialect]
				if (rejects) {
					expect(() => fixture.build(contexts[dialect])).toThrow(rejects)
					return
				}
				const compiled = fixture.build(contexts[dialect])
				expect({ sql: elideFixtures(dialect, compiled.sql), parameters: compiled.parameters }).toMatchSnapshot()
			})
		}
	})
}
