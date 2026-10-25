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
import { shapeAfter } from "../sqlite/shape.test-support"

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
const allStatements = () =>
	folders().flatMap((folder) =>
		migrationSql(folder)
			.split(STATEMENT_BREAKPOINT)
			.map((s) => s.trim())
			.filter((s) => s.replace(/^\s*--.*$/gm, "").trim().length > 0),
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
