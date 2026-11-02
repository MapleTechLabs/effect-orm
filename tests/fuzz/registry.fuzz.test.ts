// Every dialect the package defines is fuzzed.
//
// A dialect that compiles SQL but is missing from `dialects/index.ts` would pass
// every suite by never being run. This finds each `Dialect` value in src/ and
// fails until the registry has a `FuzzDialect` of the same name.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { dialects } from "./dialects"
import * as ClickHouseTypes from "../../src/ch/types"
import * as PostgresTypes from "../../src/pg/types"
import * as SqliteTypes from "../../src/sqlite/types"
import * as ClickHouse from "@maple-dev/effect-orm/clickhouse"
import * as Postgres from "@maple-dev/effect-orm/postgres"
import * as Sqlite from "@maple-dev/effect-orm/sqlite"
import { literalCoverage, literalExemptions } from "./literal-inventory"

const sourceFiles = (dir: string): Array<string> =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name)
		return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") && !entry.name.includes(".test") ? [path] : []
	})

const defined = sourceFiles(join(import.meta.dirname, "../../src")).flatMap((file) =>
	[...readFileSync(file, "utf8").matchAll(/export const \w+: Dialect = \{[\s\S]*?\bname: "([^"]+)"/g)].map((m) => m[1]!),
)

it("every dialect in src/ is registered with the fuzzer", () => {
	expect(defined.length).toBeGreaterThan(0)
	expect(new Set(dialects.map((d) => d.name))).toEqual(new Set(defined))
})

// Inspect the type modules themselves, so a new descriptor cannot be forgotten
// merely because the existing catalog still passes its own examples.
for (const [name, types, entry] of [
	["clickhouse", ClickHouseTypes, ClickHouse],
	["postgres", PostgresTypes, Postgres],
	["sqlite", SqliteTypes, Sqlite],
] as const) {
	it(`every ${name} type export has a literal property or a reason`, () => {
		const covered = literalCoverage[name]
		const exempt = literalExemptions[name]
		const publicNames = Object.keys(types).filter((key) => key in entry)
		expect([...Object.keys(covered), ...Object.keys(exempt)].sort()).toEqual(publicNames.sort())
		expect(Object.keys(covered).filter((key) => key in exempt)).toEqual([])
		for (const reason of Object.values(exempt)) expect(reason.trim().length).toBeGreaterThan(0)
		for (const dialect of dialects.filter((d) => d.name === name || (name === "sqlite" && d.name === "d1"))) {
			const ids = dialect.literals.map((literal) => literal.id)
			expect(new Set(ids).size).toBe(ids.length)
			for (const id of Object.values(covered)) expect(ids).toContain(`${dialect.name}:${id}`)
		}
	})
}
