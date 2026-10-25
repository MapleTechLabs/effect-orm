// Every dialect the package defines is fuzzed.
//
// A dialect that compiles SQL but is missing from `dialects/index.ts` would pass
// every suite by never being run. This finds each `Dialect` value in src/ and
// fails until the registry has a `FuzzDialect` of the same name.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { dialects } from "./dialects"

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
