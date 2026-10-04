import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as PG from "@maple-dev/effect-orm/postgres"
import { coreCases, coreSkips } from "./core-cases"
import { dialectCases, typeCases } from "./dialect-cases"
import { postgresCases } from "./dialect-cases.postgres"

// Discover methods and descriptors from built exports; canonical function names
// come from the explicit barrel (the root gives some of these friendly aliases).
const barrel = readFileSync(new URL("../src/ch/functions/index.ts", import.meta.url), "utf8")
const exports = [...barrel.matchAll(/export \{([\s\S]*?)\} from "[^"\n]+"/g)]
const functions = exports.flatMap((match) =>
	match[1]!
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name && !name.startsWith("type "))
		.map((name) => `function:${name}`),
)
const methods = (object: CH.CHQuery<any, any, any> | CH.CHUnionQuery<any>, prefix: string) =>
	Object.entries(object)
		.filter(([, value]) => typeof value === "function")
		.map(([name]) => `${prefix}:${name}`)
const one = CH.from(CH.table("system.one", { external: true, columns: {} })).select(() => ({ n: CH.lit(1) }))
// The column type constructors on `/clickhouse`, which also carries functions and the builder.
const typeConstructors = [
	"CHNumber",
	"aggregateState",
	"array",
	"bool",
	"brand",
	"custom",
	"dateTime",
	"dateTime64",
	"dateTime64String",
	"dateTimeString",
	"float64",
	"int32",
	"int64",
	"map",
	"nullable",
	"string",
	"uint8",
	"uint16",
	"uint32",
	"uint64",
	"untyped",
] as const satisfies ReadonlyArray<keyof typeof CH>
const types = typeConstructors.map((name) => `type:${name}`)

const exemptions = {
	"type:CHNumber": "Wire codec, exercised by all numeric descriptor fixtures in both quote64 modes.",
	"type:custom":
		"Caller-defined SQL types and codecs; no finite dialect contract. Public tarball smoke exercises the factory.",
	"type:untyped":
		"Explicitly unvalidated escape hatch; no decoding guarantee. Public tarball smoke exercises the factory.",
	"query:forUpdate": "Postgres row lock; ClickHouse refuses it at compile (core case `locking`), so there is no live ClickHouse run.",
	"query:forNoKeyUpdate": "Postgres row lock; ClickHouse refuses it at compile (core case `locking`), so there is no live ClickHouse run.",
	"query:forShare": "Postgres row lock; ClickHouse refuses it at compile (core case `locking`), so there is no live ClickHouse run.",
	"query:forKeyShare": "Postgres row lock; ClickHouse refuses it at compile (core case `locking`), so there is no live ClickHouse run.",
}

export const dialectInventory = [
	...new Set([
		...functions,
		...types,
		...methods(one, "query"),
		...methods(CH.unionAll(one, one), "union"),
	]),
].sort()

describe("dialect coverage manifest", () => {
	it("covers every function, query/union method and type, or records a reason", () => {
		expect(exports.length, "function barrel changed syntax; update inventory extraction").toBe(
			(barrel.match(/^export /gm) ?? []).length,
		)
		expect(functions.length).toBeGreaterThan(0)
		const cases = [...dialectCases, ...typeCases]
		const covered = new Set(cases.flatMap((fixture) => fixture.covers))
		expect(cases.length).toBeGreaterThan(0)
		expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
		expect(
			dialectInventory.filter((name) => !covered.has(name) && !Object.hasOwn(exemptions, name)),
			"missing live coverage",
		).toEqual([])
		expect(
			[...covered, ...Object.keys(exemptions)].filter((name) => !dialectInventory.includes(name)),
			"stale manifest entries",
		).toEqual([])
		expect(
			Object.keys(exemptions).filter((name) => covered.has(name)),
			"remove exemptions once covered",
		).toEqual([])
		for (const reason of Object.values(exemptions)) expect(reason.length).toBeGreaterThan(20)
	})
})

/** Fails on what is neither covered nor exempt, on stale entries, and on exemptions a case now covers. */
const expectManifest = (
	inventory: readonly string[],
	cases: ReadonlyArray<{ readonly id: string; readonly covers: readonly string[] }>,
	exempt: Record<string, string>,
) => {
	const covered = new Set(cases.flatMap((fixture) => fixture.covers))
	expect(new Set(cases.map((c) => c.id)).size, "duplicate case ids").toBe(cases.length)
	expect(
		inventory.filter((name) => !covered.has(name) && !Object.hasOwn(exempt, name)),
		"missing coverage",
	).toEqual([])
	expect(
		[...covered, ...Object.keys(exempt)].filter((name) => !inventory.includes(name)),
		"stale manifest entries",
	).toEqual([])
	expect(
		Object.keys(exempt).filter((name) => covered.has(name)),
		"remove exemptions once covered",
	).toEqual([])
	for (const reason of Object.values(exempt)) expect(reason.length).toBeGreaterThan(20)
}

const functionsOf = (object: object, prefix: string) =>
	Object.entries(object)
		.filter(([name, value]) => typeof value === "function" && name !== "toFragment" && name !== "schema")
		.map(([name]) => `${prefix}:${name}`)

// The builder surface every dialect shares: query and union methods, the
// operators on an expression and a condition, param kinds, and the root
// functions that build a query rather than an expression.
export const coreInventory = [
	...new Set([
		...methods(one, "query"),
		...methods(CH.unionAll(one, one), "union"),
		...functionsOf(CH.lit(1), "expr"),
		...functionsOf(CH.lit(1).eq(1), "condition"),
		...Object.keys(CH.param).map((name) => `param:${name}`),
		...["from", "fromQuery", "unionAll", "lit", "not", "and", "or"].map((name) => `function:${name}`),
	]),
].sort()

const coreExemptions = {
	"param:dateTimeString":
		"Typed for string-decoded timestamp columns, which the shared fixture does not declare. Live on ClickHouse in deep-codecs; on Postgres in the typed-literals fixture.",
	"param:dateTimeSeconds":
		"Typed for string-decoded timestamp columns, which the shared fixture does not declare. Live on ClickHouse in deep-codecs; on Postgres in the typed-literals fixture.",
}

describe("core coverage manifest", () => {
	it("runs every shared builder method on every dialect, or records why not", () => {
		expectManifest(coreInventory, coreCases, coreExemptions)
		for (const [dialect, skips] of Object.entries(coreSkips)) {
			for (const [id, reason] of Object.entries(skips)) {
				expect(coreCases.some((fixture) => fixture.id === id), `${dialect} skips unknown case ${id}`).toBe(true)
				expect(reason.length).toBeGreaterThan(20)
			}
		}
	})
})

// Every runtime export of the ./postgres entry that is its own. The shared
// builder it re-exports is the same value on /clickhouse, covered above;
// `brand` and `custom` are shared too, but are Postgres column types here.
const sharedPgTypes = new Set(["brand", "custom"])
export const postgresInventory = Object.keys(PG)
	.filter(
		(name) =>
			sharedPgTypes.has(name) || (PG as Record<string, unknown>)[name] !== (CH as Record<string, unknown>)[name],
	)
	.map((name) => `pg:${name}`)
	.sort()

const ddl =
	"DDL definition, not a query: rendered and diffed in src/schema/pg-schema.test.ts and applied to PGlite in src/migrate/pg-migrate.test.ts."

const postgresExemptions = {
	"pg:PgNumber": "Wire codec behind every numeric type; the types fixture decodes it from number, bigint and string.",
	"pg:timestampLiteral":
		"Factory for timestamp literal codecs; its instances (PgTimestampLiteral, dateTimeSeconds) are exercised.",
	"pg:table": ddl,
	"pg:column": ddl,
	"pg:index": ddl,
	"pg:uniqueIndex": ddl,
	"pg:foreignKey": ddl,
	"pg:defaultForeignKeyName": ddl,
}

describe("postgres coverage manifest", () => {
	it("runs every export of the postgres entry, or records why not", () => {
		expect(postgresInventory.length).toBeGreaterThan(0)
		expectManifest(postgresInventory, postgresCases, postgresExemptions)
	})
})
