import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runCli } from "../kit"

const src = resolve(import.meta.dirname, "..")

const schemaModule = (extra: { column?: boolean; dropName?: boolean } = {}) => `
import * as CH from "${src}/ch/index"
import * as S from "${src}/schema"

export const Events = S.defineTable("events", {
	columns: {
		OrgId: CH.string,
		Timestamp: CH.dateTime64,
		${extra.dropName === true ? "" : "Name: CH.string,"}
		${extra.column === true ? 'Env: S.column(CH.string, { default: "" }),' : ""}
	},
	engine: S.engine.mergeTree(),
	orderBy: ["OrgId", "Timestamp"],
})
`

describe("effect-orm CLI", () => {
	let dir = ""
	let lines: Array<string> = []
	const cli = (...args: Array<string>) => {
		const cwd = process.cwd()
		process.chdir(dir)
		return runCli(args, (line) => lines.push(line)).finally(() => process.chdir(cwd))
	}
	const folders = () => readdirSync(join(dir, "migrations")).sort()

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "effect-orm-kit-"))
		lines = []
		writeFileSync(join(dir, "effect-orm.config.ts"), `export default { schema: "./schema.ts", out: "./migrations" }\n`)
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it("generates a first migration, then nothing for an unchanged schema", async () => {
		writeFileSync(join(dir, "schema.ts"), schemaModule())
		expect(await cli("generate", "--name", "init")).toBe(0)
		const [first] = folders()
		expect(first).toMatch(/^\d{14}_init$/)
		const file = JSON.parse(readFileSync(join(dir, "migrations", first!, "migration.json"), "utf8"))
		expect(file.ops.map((op: { op: string }) => op.op)).toEqual(["create_table"])

		expect(await cli("generate")).toBe(0)
		expect(lines.at(-1)).toBe("No schema changes, nothing to write.")
		expect(folders()).toHaveLength(1)
		expect(await cli("check")).toBe(0)
	})

	it("chains snapshots and never reuses a timestamp", async () => {
		writeFileSync(join(dir, "schema.ts"), schemaModule())
		await cli("generate", "--name", "init")
		writeFileSync(join(dir, "schema.ts"), `${schemaModule({ column: true })}\n// v2\n`)
		// A fresh module path, so the import cache does not hand back v1.
		renameSync(join(dir, "schema.ts"), join(dir, "schema2.ts"))
		writeFileSync(join(dir, "v2.config.ts"), `export default { schema: "./schema2.ts", out: "./migrations" }\n`)
		expect(await cli("generate", "--name", "env", "--config", "v2.config.ts")).toBe(0)
		const [a, b] = folders()
		expect(a!.slice(0, 14)).not.toBe(b!.slice(0, 14))
		const s1 = JSON.parse(readFileSync(join(dir, "migrations", a!, "snapshot.json"), "utf8"))
		const s2 = JSON.parse(readFileSync(join(dir, "migrations", b!, "snapshot.json"), "utf8"))
		expect(s2.prevIds).toEqual([s1.id])
		expect(lines.join("\n")).toContain("ADD COLUMN IF NOT EXISTS Env String DEFAULT '' AFTER Name")
	})

	it("exits 2 on data loss until it is confirmed with hints", async () => {
		writeFileSync(join(dir, "schema.ts"), schemaModule())
		await cli("generate", "--name", "init")
		writeFileSync(join(dir, "schema3.ts"), schemaModule({ dropName: true }))
		writeFileSync(join(dir, "v3.config.ts"), `export default { schema: "./schema3.ts", out: "./migrations" }\n`)
		expect(await cli("generate", "--json", "--config", "v3.config.ts")).toBe(2)
		expect(folders()).toHaveLength(1)
		const hints = JSON.stringify([{ type: "confirm_data_loss", kind: "column", entity: "events.Name" }])
		expect(await cli("generate", "--json", "--config", "v3.config.ts", "--hints", hints)).toBe(0)
		expect(folders()).toHaveLength(2)
	})

	it("skips a staging folder a crashed generate left behind", async () => {
		writeFileSync(join(dir, "schema.ts"), schemaModule())
		await cli("generate", "--name", "init")
		const leftover = join(dir, "migrations", "20990101000000_half.tmp-4242")
		mkdirSync(leftover)
		writeFileSync(join(leftover, "migration.json"), '{"version":"1","ops":[]}')
		expect(await cli("check")).toBe(0)
		expect(lines.at(-1)).toBe("1 migrations, ok.")
	})

	it("check fails when a snapshot was edited by hand", async () => {
		writeFileSync(join(dir, "schema.ts"), schemaModule())
		await cli("generate", "--name", "init")
		const path = join(dir, "migrations", folders()[0]!, "snapshot.json")
		writeFileSync(path, readFileSync(path, "utf8").replace('"String"', '"UInt8"'))
		expect(await cli("check")).toBe(1)
	})
})
