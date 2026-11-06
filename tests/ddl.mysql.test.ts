// MySQL.table DDL on MySQL 8.4 and MariaDB 11.4, live when EFFECT_ORM_MYSQL_URL /
// EFFECT_ORM_MARIADB_URL are set: the rendered CREATE statements run, the
// catalog reports what the entities say, and an insert that leaves the
// defaulted columns out reads back their defaults through the builder.
import { afterAll, describe, expect, it } from "vitest"
import { DateTime, Effect, Schema } from "effect"
import * as MySQL from "@maple-dev/effect-orm/mysql"
import { mysqlEntitiesOf, renderMysqlSchema } from "@maple-dev/effect-orm/schema"
import { mariadbServer, mysqlServer, scratchDatabase, type ScratchDatabase } from "./mysql-support"

const Tours = MySQL.table("tours", {
	casing: "snake_case",
	columns: {
		id: MySQL.bigint,
		orgId: MySQL.varchar(36),
		title: MySQL.column(MySQL.text, { default: "it's \\ new" }),
		tags: MySQL.column(MySQL.json(Schema.Array(Schema.String)), { default: ["a", "b'c"] }),
		seats: MySQL.column(MySQL.int, { default: 10 }),
		price: MySQL.column(MySQL.decimal(10, 2), { default: "1.50" }),
		ratio: MySQL.column(MySQL.double, { default: 0.25 }),
		active: MySQL.column(MySQL.boolean, { default: true }),
		day: MySQL.column(MySQL.date, { default: "2024-02-29" }),
		opensAt: MySQL.column(MySQL.datetime, { default: DateTime.makeUnsafe("2024-01-02T03:04:05.678Z") }),
		raw: MySQL.column(MySQL.blob, { default: new Uint8Array([0, 255]) }),
		code: MySQL.column(MySQL.varchar(16), { unique: true }),
		note: MySQL.nullable(MySQL.varchar(200)),
		createdAt: MySQL.column(MySQL.datetime, { defaultExpr: MySQL.dateTimeNow }),
	},
	primaryKey: ["orgId", "id"],
	indexes: [MySQL.index("tours_created", ["createdAt"]), MySQL.uniqueIndex("tours_org_note", ["orgId", "note"])],
	tenantColumn: "orgId",
})

const opened: Array<ScratchDatabase> = []
afterAll(() => Promise.all(opened.map((db) => db.close())))

for (const [server, dialect] of [[mysqlServer, MySQL.mysqlDialect], [mariadbServer, MySQL.mariadbDialect]] as const) {
	describe.skipIf(server.url === undefined)(`MySQL.table DDL on ${server.name}`, () => {
		it("creates the table, its keys and indexes, and fills every default", async () => {
			const db = await scratchDatabase(server, "ddl")
			opened.push(db)
			const statements = renderMysqlSchema(await Effect.runPromise(mysqlEntitiesOf([Tours])))
			for (const sql of statements) await db.query(sql, [])
			// Applying the schema twice is harmless for the table (IF NOT EXISTS).
			await db.query(statements[0]!, [])

			const columns = await db.query(`SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tours' ORDER BY ORDINAL_POSITION`, [db.name])
			expect(columns.map((c) => [c.COLUMN_NAME, c.IS_NULLABLE])).toEqual(Tours.ddl.columns.map((c) => [c.name, c.notNull ? "NO" : "YES"]))
			const keys = await db.query(`SELECT INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tours' GROUP BY INDEX_NAME, NON_UNIQUE ORDER BY INDEX_NAME`, [db.name])
			expect(keys.map((k) => [k.INDEX_NAME, Number(k.NON_UNIQUE), k.cols])).toEqual([
				["PRIMARY", 0, "org_id,id"],
				["tours_code_unique", 0, "code"],
				["tours_created", 1, "created_at"],
				["tours_org_note", 0, "org_id,note"],
			])
			const [{ engine }] = (await db.query(`SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tours'`, [db.name])) as [{ engine: string }]
			expect(engine).toBe("InnoDB")

			const insert = MySQL.compileUnsafe(MySQL.insertInto(Tours).values({ id: 1, orgId: "org_1", code: "c1", note: null }), undefined, { dialect })
			await db.query(insert.sql, insert.parameters)
			const before = Date.now()
			const select = MySQL.compileUnsafe(MySQL.from(Tours).select().where(($) => [$.orgId.eq("org_1")]), undefined, { dialect })
			const [row] = await Effect.runPromise(select.decodeRows(await db.query(select.sql, select.parameters)))
			expect({ ...row!, createdAt: undefined }).toEqual({
				id: 1,
				orgId: "org_1",
				title: "it's \\ new",
				tags: ["a", "b'c"],
				seats: 10,
				price: "1.50",
				ratio: 0.25,
				active: true,
				day: "2024-02-29",
				opensAt: DateTime.makeUnsafe("2024-01-02T03:04:05.678Z"),
				raw: new Uint8Array([0, 255]),
				code: "c1",
				note: null,
				createdAt: undefined,
			})
			// UTC_TIMESTAMP(3), read as UTC: within a minute of now whatever the server's time zone.
			expect(Math.abs(DateTime.toEpochMillis(row!.createdAt) - before)).toBeLessThan(60_000)
		})

		it("refuses a duplicate in a UNIQUE column, and a NULL key part", async () => {
			const db = await scratchDatabase(server, "ddl")
			opened.push(db)
			for (const sql of renderMysqlSchema(await Effect.runPromise(mysqlEntitiesOf([Tours])))) await db.query(sql, [])
			await db.query("INSERT INTO `tours` (`id`, `org_id`, `code`) VALUES (1, 'o', 'c')", [])
			await expect(db.query("INSERT INTO `tours` (`id`, `org_id`, `code`) VALUES (2, 'o', 'c')", [])).rejects.toThrow(/Duplicate entry/)
			await expect(db.query("INSERT INTO `tours` (`id`, `org_id`, `code`) VALUES (3, NULL, 'd')", [])).rejects.toThrow(/cannot be null/)
		})
	})
}
