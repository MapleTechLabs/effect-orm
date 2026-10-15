import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runCli } from "../kit"
import { engineSpecOf, entitiesFromCatalog, keyParts, splitEngineFull, type ClickHouseCatalog } from "../migrate/introspect"
import { entitiesOf, isSchemaObject, type SchemaObject } from "../schema/snapshot"
import { renderClickHouseSchema, typeCode } from "./codegen"

const src = resolve(import.meta.dirname, "..")
const fixtures = resolve(import.meta.dirname, "__fixtures__")
// Read from a ClickHouse 26.2 server: the tables the live test creates, as `system.*` returned them.
const catalog = JSON.parse(readFileSync(join(fixtures, "clickhouse-catalog.json"), "utf8")) as ClickHouseCatalog

describe("introspection", () => {
	const schema = entitiesFromCatalog(catalog)
	const table = (name: string) => schema.entities.find((e) => e.kind === "table" && e.name === name)

	it("reads keys as declared, not as the server extends them", () => {
		expect(table("t")).toMatchObject({
			engine: { family: "ReplacingMergeTree", params: ["Ts"] },
			orderBy: "(OrgId, H, toStartOfHour(Ts), Name)",
			primaryKey: "(OrgId, H)",
			partitionBy: "toDate(Ts)",
			ttl: "toDate(Ts) + toIntervalDay(30)",
			settings: { index_granularity: "4096", storage_policy: "'default'" },
			comment: "events table",
		})
		// sorting_key is `K, Ver`: the server appends the version.
		expect(table("coll")).toMatchObject({ orderBy: "K", primaryKey: null, settings: {} })
		expect(table("notuple")).toMatchObject({ orderBy: "tuple()" })
		expect(table("sink")).toMatchObject({ engine: { family: "Null", params: [] }, orderBy: null })
	})

	it("keeps views, dictionaries and the ledger out of the managed tables", () => {
		const names = schema.entities.flatMap((e) => (e.kind === "table" ? [e.name] : []))
		expect(names).toEqual(["coll", "mem", "notuple", "sink", "t", "totals"])
		expect(schema.external.map((t) => [t.name, t.engine])).toEqual([
			["dist", "Distributed"],
			["plain", "MergeTree"],
			["v", "View"],
		])
		expect(schema.notes).toEqual([
			'plain: generated as external; table definitions take plain identifiers only, not "my-col"',
			"plain.Eph: EPHEMERAL columns are not modeled; left out",
			"t: SAMPLE BY H is not modeled; generated without it",
			"totals_mv: materialized view not generated; write it with CH.materializedView. Its body: SELECT OrgId, Name, count() AS C FROM t GROUP BY OrgId, Name",
		])
	})

	it("only the tables asked for", () => {
		const some = entitiesFromCatalog(catalog, { tables: ["totals", "nope"] })
		expect(some.entities.filter((e) => e.kind === "table").map((e) => e.name)).toEqual(["totals"])
		expect(some.notes).toEqual(["nope: no such table in probe"])
	})

	it("splits engine_full at its clauses, not inside expressions", () => {
		expect(splitEngineFull("MergeTree PARTITION BY f(' ORDER BY ') ORDER BY (a, b) TTL d + toIntervalDay(1) SETTINGS x = 1")).toEqual({
			engine: "MergeTree",
			clauses: { "PARTITION BY": "f(' ORDER BY ')", "ORDER BY": "(a, b)", TTL: "d + toIntervalDay(1)", SETTINGS: "x = 1" },
		})
		expect(keyParts("(a, f(b, c))")).toEqual(["a", "f(b, c)"])
		expect(keyParts("(a + b) * c")).toEqual(["(a + b) * c"])
	})

	it("drops the replication prefix and Keeper arguments", () => {
		expect(engineSpecOf("ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/t', '{replica}', Ver)")).toEqual({
			family: "ReplacingMergeTree",
			params: ["Ver"],
		})
		expect(engineSpecOf("SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')")).toEqual({ family: "MergeTree", params: [] })
		expect(engineSpecOf("ReplicatedMergeTree")).toEqual({ family: "MergeTree", params: [] })
	})
})

describe("codegen", () => {
	it.each([
		["LowCardinality(Nullable(String))", "CH.lowCardinality(CH.nullable(CH.string))"],
		["Map(String, Array(Float64))", "CH.map(CH.string, CH.array(CH.float64))"],
		["Nullable(DateTime64(3))", "CH.nullable(CH.precision(CH.dateTime64, 3))"],
		["DateTime64(3, 'UTC')", 'CH.custom("DateTime64(3, \'UTC\')", Schema.String)'],
		["Enum8('it\\'s' = 1, 'b' = 2)", 'CH.custom("Enum8(\'it\\\\\'s\' = 1, \'b\' = 2)", Schema.Literals(["it\'s", "b"]))'],
		["AggregateFunction(quantiles(0.5, 0.9), UInt64)", 'CH.aggregateState("quantiles(0.5, 0.9)", "UInt64")'],
		["SimpleAggregateFunction(sum, UInt64)", 'CH.simpleAggregateFunction("sum", CH.uint64)'],
		["Decimal(18, 4)", 'CH.custom("Decimal(18, 4)", CH.CHNumber)'],
		["Map(UInt64, String)", 'CH.untyped("Map(UInt64, String)")'],
		["Tuple(a String, b UInt8)", 'CH.untyped("Tuple(a String, b UInt8)")'],
	])("%s", (sql, code) => {
		expect(typeCode(sql)).toMatchObject({ code, sql })
	})

	it("writes a module that yields back the entities it was written from", async () => {
		const schema = entitiesFromCatalog(catalog)
		const { source } = renderClickHouseSchema(schema, { importPath: "../../clickhouse" })
		// Committed, so `tsc` checks generated code too.
		await expect(source).toMatchFileSnapshot(join(fixtures, "pulled-clickhouse.ts"))
		const module = (await import(join(fixtures, "pulled-clickhouse.ts"))) as Record<string, unknown>
		const objects = Object.values(module).filter(isSchemaObject) as Array<SchemaObject>
		expect(await Effect.runPromise(entitiesOf(objects))).toEqual(schema.entities)
		expect(Object.keys(module).sort()).toEqual(["Coll", "Dist", "Mem", "Notuple", "Plain", "Sink", "T", "Totals", "V"])
	})
})

describe("effect-orm pull", () => {
	let dir = ""
	let lines: Array<string> = []
	const cli = (...args: Array<string>) => {
		const cwd = process.cwd()
		process.chdir(dir)
		return runCli(args, (line) => lines.push(line)).finally(() => process.chdir(cwd))
	}

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "effect-orm-pull-")))
		lines = []
		// A driver answering the catalog queries from the fixture.
		writeFileSync(
			join(dir, "effect-orm.config.ts"),
			`import { readFileSync } from "node:fs"
import { Effect, Layer } from "effect"
import { MigrationDriver } from "${src}/migrate"
const catalog = JSON.parse(readFileSync(${JSON.stringify(join(fixtures, "clickhouse-catalog.json"))}, "utf8"))
const driver = Layer.succeed(MigrationDriver, {
	execute: () => Effect.void,
	query: (sql: string) =>
		Effect.succeed(
			sql.includes("currentDatabase() AS db") ? [{ db: catalog.database }]
			: sql.includes("system.tables") ? catalog.tables
			: sql.includes("system.columns") ? catalog.columns
			: sql.includes("system.data_skipping_indices") ? catalog.indexes
			: [],
		),
})
export default { schema: "./db/schema.ts", out: "./migrations", driver }
`,
		)
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it("writes the config's schema module, which generate --baseline then adopts unchanged", async () => {
		expect(await cli("pull")).toBe(0)
		expect(lines[0]).toBe(`Wrote ${join(dir, "db/schema.ts")}: 6 tables, 3 external (dist, plain, v).`)
		expect(lines).toContain("  t: SAMPLE BY H is not modeled; generated without it")
		expect(lines).toContain("  plain.B: Map(UInt64, String) has no built-in type; rows hold it undecoded")

		// The package import, pointed at the source for this test.
		const path = join(dir, "db/schema.ts")
		writeFileSync(path, readFileSync(path, "utf8").replace('"@maple-dev/effect-orm/clickhouse"', JSON.stringify(`${src}/clickhouse`)))
		expect(await cli("generate", "--baseline", "--name", "baseline")).toBe(0)
		expect(await cli("generate")).toBe(0)
		expect(lines.at(-1)).toBe("No schema changes, nothing to write.")
		expect(readdirSync(join(dir, "migrations"))).toHaveLength(1)
	})

	it("refuses to overwrite without --force, and writes only the tables asked for", async () => {
		writeFileSync(join(dir, "mine.ts"), "// mine\n")
		expect(await cli("pull", "--out", "mine.ts")).toBe(1)
		expect(readFileSync(join(dir, "mine.ts"), "utf8")).toBe("// mine\n")
		expect(await cli("pull", "--out", "mine.ts", "--tables", "totals", "--force", "--json")).toBe(0)
		expect(JSON.parse(lines.at(-1)!)).toMatchObject({ tables: ["totals"], external: [], review: [] })
		expect(readFileSync(join(dir, "mine.ts"), "utf8")).toContain('export const Totals = CH.table("totals", {')
	})
})
