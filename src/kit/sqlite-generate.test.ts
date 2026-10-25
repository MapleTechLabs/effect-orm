// `generate` for SQLite, checked on real SQLite: the migrations it writes,
// applied in order, must give the same PRAGMA results as creating the final
// schema fresh.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

const folders = () =>
	readdirSync(join(dir, "migrations"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
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

it("renames a table and a column when a hint says so, keeping rows and indexes", async () => {
	await generateFrom(links(`id: SQLite.text, url: SQLite.text`, `indexes: [SQLite.index("links_url", ["url"])],`))
	const v2 = `
export const Urls = SQLite.table("urls", {
	columns: { id: SQLite.text, target: SQLite.text },
	primaryKey: ["id"],
	indexes: [SQLite.index("links_url", ["target"])],
})`
	// Unconfirmed, a rename is a drop plus a create.
	await expect(generateFrom(v2)).rejects.toMatchObject({ code: "missing_hints" })
	const second = await generateFrom(v2, {
		hints: [
			{ type: "confirm_rename", kind: "table", entity: "links", to: "urls" },
			{ type: "confirm_rename", kind: "column", entity: "urls.url", to: "target" },
		],
	})
	expect(second.plan).toEqual([
		{ label: "metadata", sql: ['ALTER TABLE "links" RENAME TO "urls"'] },
		{ label: "metadata", sql: ['ALTER TABLE "urls" RENAME COLUMN "url" TO "target"'] },
	])
	await expectMigratedToEqualFresh(v2)
	expect(await rowsAfter(allStatements(seedLinks), 'SELECT "target" FROM "urls" ORDER BY "id"')).toEqual([{ target: "https://a" }, { target: "https://b" }])
})

// The tables of __fixtures__/drizzle-sqlite/schema.ts.txt, declared with effect-orm.
const drizzleEquivalent = `
const named = <T extends Parameters<typeof SQLite.column>[0]>(type: T, name: string) => SQLite.column(type, { name })
const optionalText = (name: string) => named(SQLite.nullable(SQLite.text), name)
export const ShortLink = SQLite.table("short_link", {
	columns: {
		id: SQLite.text, code: SQLite.text, targetUrl: named(SQLite.text, "target_url"), targetHash: named(SQLite.text, "target_hash"),
		orgId: optionalText("org_id"), createdBy: optionalText("created_by"), subjectType: named(SQLite.text, "subject_type"),
		subjectId: named(SQLite.text, "subject_id"), purpose: SQLite.text, prospectId: optionalText("prospect_id"),
		clickCount: named(SQLite.integer, "click_count"), firstAccessedAt: optionalText("first_accessed_at"),
		lastAccessedAt: optionalText("last_accessed_at"), createdAt: named(SQLite.text, "created_at"), updatedAt: named(SQLite.text, "updated_at"),
	},
	primaryKey: ["id"],
	indexes: [SQLite.uniqueIndex("short_link_code", ["code"]), SQLite.index("short_link_org", ["orgId"])],
})
export const Membership = SQLite.table("membership", {
	columns: {
		orgId: named(SQLite.text, "org_id"), userId: named(SQLite.text, "user_id"),
		role: SQLite.column(SQLite.text, { default: "member" }), weight: SQLite.column(SQLite.real, { default: 1.5 }),
		active: SQLite.column(SQLite.boolean, { default: true }), avatar: SQLite.nullable(SQLite.blob),
		amount: SQLite.nullable(SQLite.custom("numeric", SQLite.real.schema)),
		email: SQLite.column(SQLite.nullable(SQLite.text), { unique: true }),
		createdAt: SQLite.column(SQLite.text, { name: "created_at", defaultExpr: "(CURRENT_TIMESTAMP)" }),
	},
	primaryKey: ["orgId", "userId"],
	indexes: [SQLite.index("membership_user_role", ["userId", "role"])],
})`

it("adopts a drizzle-kit 1.0 folder: a baseline from its snapshot, then no change for the same tables", async () => {
	cpSync(join(import.meta.dirname, "__fixtures__", "drizzle-sqlite"), join(dir, "migrations"), { recursive: true })
	await expect(generateFrom(drizzleEquivalent)).rejects.toMatchObject({ code: "config", message: expect.stringContaining("--baseline") })
	const baseline = await generateFrom(drizzleEquivalent, { baseline: "drizzle" })
	expect(baseline.plan).toEqual([])
	const [, adopted] = folders()
	expect(migrationSql(adopted!)).toMatch(/^-- Baseline/)
	expect(JSON.parse(readFileSync(join(dir, "migrations", adopted!, "snapshot.json"), "utf8")).dialect).toBe("sqlite")
	expect(await generateFrom(drizzleEquivalent)).toEqual({ written: undefined, plan: [] })
	// The comparison is live: one difference from the drizzle tables is a change.
	const changed = await generateFrom(drizzleEquivalent.replace('"short_link_org", ["orgId"]', '"short_link_org", ["orgId", "purpose"]'))
	expect(changed.plan.flatMap((p) => p.sql)).toEqual([
		'DROP INDEX IF EXISTS "short_link_org"',
		'CREATE INDEX IF NOT EXISTS "short_link_org" ON "short_link" ("org_id", "purpose")',
	])
	// The folder drizzle-kit wrote, applied as it is, holds the same tables apart from the NOT NULL
	// drizzle-kit drops from a text primary key.
	expect(Object.keys(await shapeAfter(allStatements()))).toEqual(["membership", "short_link"])
})
