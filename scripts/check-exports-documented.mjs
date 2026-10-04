#!/usr/bin/env node
// Every export of the two dialect entries is named in docs/reference.md, whose
// first line claims to be the catalog. A claim like that decays the moment
// anything is added, so it is checked rather than promised.
//
// Reads the BUILT types, not the source: what a consumer can import is what
// `dist/<entry>.d.mts` says, and the barrel's re-export chains are already
// resolved there.
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const entries = ["clickhouse", "postgres"]

const exportsOf = (entry) => {
	const dts = join(root, `dist/${entry}.d.mts`)
	if (!existsSync(dts)) {
		console.error(`dist/${entry}.d.mts missing — run \`bun run build\` first.`)
		process.exit(1)
	}
	// The final `export { … }` statement of the bundle is the whole public surface.
	const source = readFileSync(dts, "utf8")
	const last = [...source.matchAll(/export \{([^}]*)\};/g)].at(-1)
	if (!last) {
		console.error(`No \`export { … }\` statement found in dist/${entry}.d.mts.`)
		process.exit(1)
	}
	return (
		last[1]
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean)
			// `type Foo`, `bar as baz` — the importable name is what follows `as`, and
			// the `type` marker is not part of it.
			.map((entry) => {
				const aliased = entry.split(/\s+as\s+/)
				return (aliased.at(-1) ?? entry).replace(/^type\s+/, "").trim()
			})
			.filter((name) => name !== "default")
	)
}

const reference = readFileSync(join(root, "docs/reference.md"), "utf8")
let failed = false
for (const entry of entries) {
	const names = exportsOf(entry)
	const missing = names.filter((name) => !new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(reference))
	if (missing.length > 0) {
		failed = true
		console.error(
			`docs/reference.md claims to be the export catalog but does not mention ${missing.length} /${entry} export${
				missing.length > 1 ? "s" : ""
			}:\n  ` + missing.join("\n  "),
		)
	} else console.log(`export catalog ok (${names.length} /${entry} exports)`)
}
if (failed) process.exit(1)
