// `generate` for MySQL: the folder it writes, the ALTER TABLE statements, and
// what the runner and `verify` refuse. When EFFECT_ORM_MYSQL_URL /
// EFFECT_ORM_MARIADB_URL are set, the migrations it writes, applied in order,
// must give the same information_schema as creating the final schema fresh.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Layer } from "effect"
import mysql from "mysql2/promise"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { generate, readMigrations, verifySchema, type GenerateOptions, type KitConfig } from "../kit"
import * as Migrate from "../migrate"
import { STATEMENT_BREAKPOINT } from "../migrate/source"
import { makeSnapshot, mysqlEntitiesOf, ORIGIN_ID, renderMysqlSchema, type MysqlSchemaTable } from "../schema"

const src = resolve(import.meta.dirname, "..")
let dir = ""
let version = 0

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "effect-orm-mysql-"))
	version = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const writeModule = (prefix: string, body: string) => {
	const file = `${prefix}${++version}.ts`
	writeFileSync(join(dir, file), `import * as MySQL from "${src}/mysql"\n${body}\n`)
	return file
}

/** Write a schema module (a fresh path each time, so the import cache never hands back an old one) and run generate on it. */
const generateFrom = (body: string, options: GenerateOptions = {}) => {
	const config: KitConfig = { dialect: "mysql", schema: `./${writeModule("schema", body)}`, out: "./migrations" }
	return Effect.runPromise(generate(config, dir, { name: `v${version}`, ...options }))
}

const folders = () =>
	readdirSync(join(dir, "migrations"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
const migrationSql = (folder: string) => readFileSync(join(dir, "migrations", folder, "migration.sql"), "utf8")
/** A migration's statements, split as drizzle's migrator splits them. */
const statementsOf = (folder: string) =>
	migrationSql(folder)
		.split(STATEMENT_BREAKPOINT)
		.map((s) => s.trim())
		.filter((s) => s.replace(/^\s*--.*$/gm, "").trim().length > 0)

const links = (columns: string, rest = "") => `
export const Links = MySQL.table("links", {
	columns: { ${columns} },
	primaryKey: ["id"],
	${rest}
})`

it("writes a first migration as migration.sql plus a mysql snapshot, then nothing for an unchanged schema", async () => {
	const v1 = links(`id: MySQL.bigint, url: MySQL.varchar(200)`, `indexes: [MySQL.index("links_url", ["url"])],`)
	const first = await generateFrom(v1)
	expect(first.plan.map((p) => p.label)).toEqual(["metadata", "metadata"])
	const [folder] = folders()
	expect(folder).toMatch(/^\d{14}_v1$/)
	expect(readdirSync(join(dir, "migrations", folder!)).sort()).toEqual(["migration.sql", "snapshot.json"])
	expect(JSON.parse(readFileSync(join(dir, "migrations", folder!, "snapshot.json"), "utf8")).dialect).toBe("mysql")
	expect(migrationSql(folder!)).toBe(
		[
			"-- metadata\nCREATE TABLE IF NOT EXISTS `links` (\n\t`id` bigint NOT NULL,\n\t`url` varchar(200) NOT NULL,\n\tPRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
			"-- metadata\nCREATE INDEX `links_url` ON `links` (`url`);",
		].join(`\n${STATEMENT_BREAKPOINT}\n`) + "\n",
	)
	expect((await generateFrom(v1)).written).toBeUndefined()
})

it("alters the table in place: ADD COLUMN, MODIFY COLUMN, and a primary key replaced", async () => {
	await generateFrom(links(`id: MySQL.bigint, url: MySQL.varchar(200), note: MySQL.nullable(MySQL.text)`))
	const v2 = `
export const Links = MySQL.table("links", {
	casing: "snake_case",
	columns: {
		id: MySQL.bigint,
		url: MySQL.varchar(200),
		note: MySQL.column(MySQL.text, { default: "" }),
		createdAt: MySQL.column(MySQL.datetime, { defaultExpr: MySQL.dateTimeNow }),
	},
	primaryKey: ["url", "id"],
})`
	const second = await generateFrom(v2)
	expect(second.plan).toEqual([
		{ label: "rewrite", sql: ["ALTER TABLE `links` DROP PRIMARY KEY"] },
		{ label: "metadata", sql: ["ALTER TABLE `links` ADD COLUMN `created_at` datetime(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3))"] },
		{
			label: "rewrite",
			sql: [
				"ALTER TABLE `links` MODIFY COLUMN `note` text DEFAULT ('')",
				"UPDATE `links` SET `note` = ('') WHERE `note` IS NULL",
				"ALTER TABLE `links` MODIFY COLUMN `note` text NOT NULL DEFAULT ('')",
			],
		},
		{ label: "rewrite", sql: ["ALTER TABLE `links` ADD PRIMARY KEY (`url`, `id`)"] },
	])
})

it("drops a column only once the data loss is confirmed, and a type change likewise", async () => {
	await generateFrom(links(`id: MySQL.bigint, url: MySQL.varchar(200), hits: MySQL.int`))
	const v2 = links(`id: MySQL.bigint, url: MySQL.text`)
	const error = await generateFrom(v2).catch((e: unknown) => e)
	expect(error).toMatchObject({ code: "missing_hints" })
	expect(JSON.parse((error as { details: Array<string> }).details[0]!)).toEqual([
		{ type: "confirm_data_loss", kind: "column", entity: "links.url" },
		{ type: "confirm_data_loss", kind: "column", entity: "links.hits" },
	])
	expect(folders()).toHaveLength(1)
	const second = await generateFrom(v2, { hints: JSON.parse((error as { details: Array<string> }).details[0]!) })
	expect(second.plan).toEqual([
		{ label: "rewrite", sql: ["ALTER TABLE `links` MODIFY COLUMN `url` text NOT NULL"] },
		{ label: "destructive", sql: ["ALTER TABLE `links` DROP COLUMN `hits`"] },
	])
})

it("refuses schema problems, --from-drizzle, and running or verifying the folder", async () => {
	await expect(generateFrom(links(`id: MySQL.text`))).rejects.toMatchObject({
		code: "config",
		details: [expect.stringContaining("id is text, which MySQL cannot index without a prefix length")],
	})
	await expect(generateFrom(links(`id: MySQL.bigint`), { baseline: "drizzle" })).rejects.toMatchObject({ code: "config", message: expect.stringContaining("--from-drizzle") })
	await generateFrom(links(`id: MySQL.bigint`))
	const migrations = await Effect.runPromise(readMigrations(join(dir, "migrations")))
	const driver = Effect.provideService(Migrate.MigrationDriver, {} as Migrate.MigrationDriver["Service"])
	for (const attempt of [Migrate.run({ migrations }), Migrate.status(migrations), Migrate.verify(migrations), Migrate.baseline({ migrations, upTo: migrations[0]!.name })]) {
		await expect(Effect.runPromise(driver(attempt as Effect.Effect<unknown, unknown, Migrate.MigrationDriver>))).rejects.toMatchObject({
			message: expect.stringContaining("MySQL migrations are not run by effect-orm yet"),
		})
	}
	const snapshot = await Effect.runPromise(makeSnapshot([], [ORIGIN_ID], "mysql"))
	await expect(Effect.runPromise(driver(Migrate.verifySnapshot(snapshot)))).rejects.toMatchObject({ message: expect.stringMatching(/MySQL databases cannot be verified/) })
	// A driver that would fail to build: the refusal comes first.
	const config: KitConfig = { dialect: "mysql", schema: "./schema1.ts", out: "./migrations", driver: Layer.effectContext(Effect.die("built")) }
	await expect(Effect.runPromise(verifySchema(config, dir))).rejects.toMatchObject({ code: "unsupported", message: expect.stringMatching(/MySQL or MariaDB/) })
})

// Live: every generated migration, applied in order, gives a fresh create's information_schema.
const servers = [
	["mysql", process.env.EFFECT_ORM_MYSQL_URL],
	["mariadb", process.env.EFFECT_ORM_MARIADB_URL],
] as const

const shapeOf = async (connection: mysql.Connection, database: string) => {
	const read = async (sql: string) => [...((await connection.query(sql, [database]))[0] as Array<unknown>)].map((row) => JSON.stringify(row)).sort()
	return {
		columns: await read("SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?"),
		indexes: await read("SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?"),
	}
}

for (const [name, url] of servers) {
	describe.skipIf(url === undefined)(`generated migrations on ${name}`, () => {
		it("applied in order, give the schema a fresh create gives, and keep the rows", async () => {
			const steps = [
				links(`id: MySQL.bigint, url: MySQL.varchar(200), note: MySQL.nullable(MySQL.varchar(40))`, `indexes: [MySQL.index("links_url", ["url"])],`),
				links(
					`id: MySQL.bigint, target: MySQL.varchar(200), note: MySQL.column(MySQL.varchar(40), { default: "none" }), hits: MySQL.column(MySQL.int, { default: 0 }), code: MySQL.column(MySQL.nullable(MySQL.varchar(16)), { unique: true })`,
					`indexes: [MySQL.uniqueIndex("links_url", ["target", "hits"])],`,
				),
			]
			await generateFrom(steps[0]!)
			await generateFrom(steps[1]!, { hints: [{ type: "confirm_rename", kind: "column", entity: "links.url", to: "target" }] })
			const admin = new URL(url!)
			admin.username = "root"
			const connection = await mysql.createConnection({ uri: admin.toString() })
			const [fresh, migrated] = [`kit_fresh_${process.pid}`, `kit_migrated_${process.pid}`]
			try {
				for (const db of [fresh, migrated]) await connection.query(`DROP DATABASE IF EXISTS \`${db}\``).then(() => connection.query(`CREATE DATABASE \`${db}\``))
				await connection.query(`USE \`${migrated}\``)
				const [first, second] = folders()
				for (const sql of statementsOf(first!)) await connection.query(sql)
				await connection.query("INSERT INTO `links` (`id`, `url`, `note`) VALUES (1, 'https://a', NULL), (2, 'https://b', 'b')")
				for (const sql of statementsOf(second!)) await connection.query(sql)
				await connection.query(`USE \`${fresh}\``)
				const module = (await import(join(dir, writeModule("fresh", steps[1]!)))) as Record<string, MysqlSchemaTable<string, any>>
				for (const sql of renderMysqlSchema(await Effect.runPromise(mysqlEntitiesOf(Object.values(module))))) await connection.query(sql)
				expect(await shapeOf(connection, migrated)).toEqual(await shapeOf(connection, fresh))
				const [rows] = await connection.query(`SELECT id, target, note, hits FROM \`${migrated}\`.links ORDER BY id`)
				expect(rows).toEqual([
					{ id: 1, target: "https://a", note: "none", hits: 0 },
					{ id: 2, target: "https://b", note: "b", hits: 0 },
				])
			} finally {
				for (const db of [fresh, migrated]) await connection.query(`DROP DATABASE IF EXISTS \`${db}\``)
				await connection.end()
			}
		})
	})
}
