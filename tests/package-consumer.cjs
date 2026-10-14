// Copied into an isolated directory by check-package.ts and run with Node.
// A CommonJS consumer: every public entry must load through `require()`, which
// Node (20.19+, 22.12+) satisfies with `require(esm)` once the export map offers
// a condition other than `import`. Nothing here may resolve dependencies or
// source files from Maple's workspace.
const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const { dirname, join } = require("node:path")

// The package does not export its own package.json, so read the installed copy
// through an entry it does export. Driving the list from `exports` covers every
// entry added later without touching this file.
const root = dirname(dirname(require.resolve("@maple-dev/effect-orm/clickhouse")))
const { exports: exportMap } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const entries = Object.keys(exportMap)
assert.ok(entries.length > 0, "the package exports no entries")
for (const entry of entries) {
	const specifier = `@maple-dev/effect-orm${entry.slice(1)}`
	const loaded = require(specifier)
	assert.ok(Object.keys(loaded).length > 0, `${specifier} loaded with no exports`)
}

// And it works, not just loads: compile and decode with the same Effect a CJS
// host resolves, so the library and its caller share one Effect instance.
const { Effect } = require("effect")
const CH = require("@maple-dev/effect-orm/clickhouse")
const events = CH.table("events", { external: true, columns: { id: CH.uint64, name: CH.string } })
const query = CH.from(events)
	.select(($) => ({ id: CH.toString($.id), name: $.name }))
	.where(($) => [$.name.eq(CH.param.string("name"))])
const compiled = Effect.runSync(CH.compile(query, { name: "maple" }))
assert.match(compiled.sql, /FROM events/)
assert.deepEqual(Effect.runSync(compiled.decodeRows([{ id: "18446744073709551615", name: "maple" }])), [
	{ id: "18446744073709551615", name: "maple" },
])
console.log(`CommonJS consumer ok (${entries.length} entries)`)
