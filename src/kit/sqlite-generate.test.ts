// `generate` for SQLite, checked on real SQLite: the migrations it writes,
// applied in order, must give the same PRAGMA results as creating the final
// schema fresh.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { afterEach, beforeEach, expect, it } from "vitest"
import { generate, type GenerateOptions, type KitConfig } from "../kit"
import { STATEMENT_BREAKPOINT } from "../migrate/source"
import { renderSqliteSchema, sqliteEntitiesOf, type SqliteSchemaTable } from "../schema"
import { rowsAfter, shapeAfter } from "../sqlite/shape.test-support"

const src = resolve(import.meta.dirname, "..")
let dir = ""
let version = 0

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "effect-orm-sqlite-"))
	version = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Write a schema module (a fresh path each time, so the import cache never hands back an old one) and run generate on it. */
const generateFrom = (body: string, options: GenerateOptions = {}) => {
	const file = `schema${++version}.ts`
	writeFileSync(join(dir, file), `import * as SQLite from "${src}/sqlite"\n${body}\n`)
	const config: KitConfig = { dialect: "sqlite", schema: `./${file}`, out: "./migrations" }
	return Effect.runPromise(generate(config, dir, { name: `v${version}`, ...options }))
}

const folders = () => readdirSync(join(dir, "migrations")).sort()
const migrationSql = (folder: string) => readFileSync(join(dir, "migrations", folder, "migration.sql"), "utf8")

/** Every statement of every migration, in folder order, split as Alchemy and drizzle split them. */
const allStatements = (seed: ReadonlyArray<string> = []) =>
	folders().flatMap((folder, i) => [...(i === 1 ? seed : []), ...statementsOf(folder)])

const statementsOf = (folder: string) => (

		migrationSql(folder)
			.split(STATEMENT_BREAKPOINT)
			.map((s) => s.trim())
			.filter((s) => s.replace(/^\s*--.*$/gm, "").trim().length > 0)
)

/** The schema module's tables, created fresh. */
const freshShape = async (body: string) => {
	const file = `fresh${++version}.ts`
	writeFileSync(join(dir, file), `import * as SQLite from "${src}/sqlite"\n${body}\n`)
	const module = (await import(join(dir, file))) as Record<string, SqliteSchemaTable<string, any>>
	return shapeAfter(await Effect.runPromise(Effect.map(sqliteEntitiesOf(Object.values(module)), renderSqliteSchema)))
}

const expectMigratedToEqualFresh = async (body: string) => expect(await shapeAfter(allStatements())).toEqual(await freshShape(body))

const links = (columns: string, rest = "") => `
export const Links = SQLite.table("links", {
	columns: { ${columns} },
	primaryKey: ["id"],
	${rest}
})`

it("writes a first migration as migration.sql plus a sqlite snapshot, then nothing for an unchanged schema", async () => {
	const v1 = links(`id: SQLite.text, url: SQLite.text`)
	const first = await generateFrom(v1)
	expect(first.plan.map((p) => p.label)).toEqual(["metadata"])
	const [folder] = folders()
	expect(folder).toMatch(/^\d{14}_v1$/)
	expect(readdirSync(join(dir, "migrations", folder!)).sort()).toEqual(["migration.sql", "snapshot.json"])
	expect(JSON.parse(readFileSync(join(dir, "migrations", folder!, "snapshot.json"), "utf8")).dialect).toBe("sqlite")
	expect(migrationSql(folder!)).toContain('CREATE TABLE IF NOT EXISTS "links"')
	await expectMigratedToEqualFresh(v1)
	expect((await generateFrom(v1)).written).toBeUndefined()
})

it("adds a nullable column, and a NOT NULL one with a literal default, with ALTER TABLE ADD COLUMN", async () => {
	await generateFrom(links(`id: SQLite.text, url: SQLite.text`))
	const v2 = links(`id: SQLite.text, url: SQLite.text, note: SQLite.nullable(SQLite.text), hits: SQLite.column(SQLite.integer, { default: 0 })`)
	const second = await generateFrom(v2)
	expect(second.plan.flatMap((p) => p.sql)).toEqual([
		'ALTER TABLE "links" ADD COLUMN "note" text',
		'ALTER TABLE "links" ADD COLUMN "hits" integer NOT NULL DEFAULT 0',
	])
	await expectMigratedToEqualFresh(v2)
})

const seedLinks = [`INSERT INTO "links" ("id", "url") VALUES ('a', 'https://a'), ('b', 'https://b')`]

it("drops a column only once the data loss is confirmed, and keeps the other columns' rows", async () => {
	await generateFrom(links(`id: SQLite.text, url: SQLite.text, note: SQLite.nullable(SQLite.text)`))
	const v2 = links(`id: SQLite.text, url: SQLite.text`)
	await expect(generateFrom(v2)).rejects.toMatchObject({ code: "missing_hints" })
	expect(folders()).toHaveLength(1)
	const second = await generateFrom(v2, { hints: [{ type: "confirm_data_loss", kind: "column", entity: "links.note" }] })
	expect(second.plan).toEqual([{ label: "destructive", sql: ['ALTER TABLE "links" DROP COLUMN "note"'] }])
	await expectMigratedToEqualFresh(v2)
	expect(await rowsAfter(allStatements(seedLinks), 'SELECT * FROM "links" ORDER BY "id"')).toEqual([
		{ id: "a", url: "https://a" },
		{ id: "b", url: "https://b" },
	])
})

const rebuilds: ReadonlyArray<readonly [string, string, string]> = [
	["a column type", `id: SQLite.text, url: SQLite.text, hits: SQLite.nullable(SQLite.text)`, `id: SQLite.text, url: SQLite.text, hits: SQLite.nullable(SQLite.integer)`],
	["nullability", `id: SQLite.text, url: SQLite.nullable(SQLite.text)`, `id: SQLite.text, url: SQLite.text`],
	["a default", `id: SQLite.text, url: SQLite.text`, `id: SQLite.text, url: SQLite.column(SQLite.text, { default: "none" })`],
	["a UNIQUE column", `id: SQLite.text, url: SQLite.text`, `id: SQLite.text, url: SQLite.column(SQLite.text, { unique: true })`],
	["a NOT NULL column with an expression default", `id: SQLite.text, url: SQLite.text`, `id: SQLite.text, url: SQLite.text, at: SQLite.column(SQLite.text, { defaultExpr: "(CURRENT_TIMESTAMP)" })`],
]

it.each(rebuilds)("rebuilds the table for %s, keeps its rows and recreates its indexes", async (_, before, after) => {
	const index = `indexes: [SQLite.index("links_url", ["url"])],`
	await generateFrom(links(before, index))
	const v2 = links(after, index)
	const second = await generateFrom(v2)
	expect(second.plan.map((p) => p.label)).toEqual(["rebuild", "metadata"])
	expect(second.plan[0]!.sql).toEqual([
		"PRAGMA foreign_keys=OFF",
		expect.stringMatching(/^CREATE TABLE "__new_links" \(/),
		expect.stringMatching(/^INSERT INTO "__new_links"\("id", "url"(, "hits")?\) SELECT "id", "url"(, "hits")? FROM "links"$/),
		'DROP TABLE "links"',
		'ALTER TABLE "__new_links" RENAME TO "links"',
		"PRAGMA foreign_keys=ON",
	])
	expect(second.plan[1]!.sql).toEqual(['CREATE INDEX IF NOT EXISTS "links_url" ON "links" ("url")'])
	await expectMigratedToEqualFresh(v2)
	const rows = await rowsAfter(allStatements(seedLinks), 'SELECT "id", "url" FROM "links" ORDER BY "id"')
	expect(rows).toEqual([{ id: "a", url: "https://a" }, { id: "b", url: "https://b" }])
})

it("rebuilds the table for a primary key change", async () => {
	await generateFrom(links(`id: SQLite.text, url: SQLite.text`))
	const v2 = `
export const Links = SQLite.table("links", {
	columns: { id: SQLite.text, url: SQLite.text },
	primaryKey: ["id", "url"],
})`
	const second = await generateFrom(v2)
	expect(second.plan.map((p) => p.label)).toEqual(["rebuild"])
	await expectMigratedToEqualFresh(v2)
	expect(await rowsAfter(allStatements(seedLinks), 'SELECT count(*) AS n FROM "links"')).toEqual([{ n: 2 }])
})

it("creates and drops indexes without touching the table", async () => {
	await generateFrom(links(`id: SQLite.text, url: SQLite.text, org: SQLite.text`, `indexes: [SQLite.index("links_url", ["url"])],`))
	const v2 = links(`id: SQLite.text, url: SQLite.text, org: SQLite.text`, `indexes: [SQLite.uniqueIndex("links_org_url", ["org", "url"])],`)
	const second = await generateFrom(v2)
	expect(second.plan).toEqual([
		{ label: "metadata", sql: ['DROP INDEX IF EXISTS "links_url"'] },
		{ label: "metadata", sql: ['CREATE UNIQUE INDEX IF NOT EXISTS "links_org_url" ON "links" ("org", "url")'] },
	])
	await expectMigratedToEqualFresh(v2)
})

it("asks to confirm a column a rebuild leaves behind", async () => {
	await generateFrom(links(`id: SQLite.text, url: SQLite.text, note: SQLite.nullable(SQLite.text)`))
	const v2 = links(`id: SQLite.text, url: SQLite.integer`)
	await expect(generateFrom(v2)).rejects.toMatchObject({ code: "missing_hints", details: [expect.stringContaining("links.note")] })
	const second = await generateFrom(v2, { hints: [{ type: "confirm_data_loss", kind: "column", entity: "links.note" }] })
	expect(second.plan.map((p) => p.label)).toEqual(["rebuild"])
	expect(second.plan[0]!.sql[2]).toBe('INSERT INTO "__new_links"("id", "url") SELECT "id", "url" FROM "links"')
	await expectMigratedToEqualFresh(v2)
})

it("drops a table only once the data loss is confirmed", async () => {
	await generateFrom(`${links(`id: SQLite.text, url: SQLite.text`)}\nexport const Old = SQLite.table("old", { columns: { id: SQLite.text }, indexes: [SQLite.index("old_id", ["id"])] })`)
	const v2 = links(`id: SQLite.text, url: SQLite.text`)
	await expect(generateFrom(v2)).rejects.toMatchObject({ code: "missing_hints" })
	const second = await generateFrom(v2, { hints: [{ type: "confirm_data_loss", kind: "table", entity: "old" }] })
	expect(second.plan).toEqual([{ label: "destructive", sql: ['DROP TABLE IF EXISTS "old"'] }])
	await expectMigratedToEqualFresh(v2)
})
