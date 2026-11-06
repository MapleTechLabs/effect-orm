import { Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { diffMysqlSchemas, mysqlEntitiesOf, renderMysqlOp, renderMysqlSchema, sqliteEntitiesOf, type MysqlSchemaTable } from "../schema"
import * as Db from "../database"
import * as MySQL from "../mysql"
import * as SQLite from "../sqlite"

const Tours = MySQL.table("tours", {
	casing: "snake_case",
	columns: {
		id: MySQL.bigint,
		orgId: MySQL.varchar(36),
		title: MySQL.column(MySQL.text, { default: "it's \\ new" }),
		tags: MySQL.column(MySQL.json(Schema.Array(Schema.String)), { default: [] }),
		seats: MySQL.column(MySQL.int, { default: 10 }),
		price: MySQL.column(MySQL.decimal(10, 2), { default: "0.00" }),
		active: MySQL.column(MySQL.boolean, { default: true }),
		code: MySQL.column(MySQL.varchar(16), { unique: true }),
		note: MySQL.nullable(MySQL.varchar(200)),
		startsAt: MySQL.column(MySQL.datetime, { defaultExpr: MySQL.dateTimeNow }),
	},
	primaryKey: ["id"],
	indexes: [MySQL.index("tours_org_starts", ["orgId", "startsAt"]), MySQL.uniqueIndex("tours_org_title", ["orgId", "note"])],
	tenantColumn: "orgId",
})

const entities = (tables: ReadonlyArray<MysqlSchemaTable<string, any>>) => Effect.runSync(mysqlEntitiesOf(tables))
const problemsOf = (tables: ReadonlyArray<MysqlSchemaTable<string, any>>) => {
	const exit = Effect.runSyncExit(mysqlEntitiesOf(tables))
	return Exit.isFailure(exit) ? String(exit.cause) : ""
}

describe("MySQL.table DDL", () => {
	it("writes CREATE TABLE with InnoDB and utf8mb4, the key and UNIQUE inside it, and indexes after", () => {
		expect(renderMysqlSchema(entities([Tours]))).toEqual([
			`CREATE TABLE IF NOT EXISTS \`tours\` (
	\`id\` bigint NOT NULL,
	\`org_id\` varchar(36) NOT NULL,
	\`title\` text NOT NULL DEFAULT ('it\\'s \\\\ new'),
	\`tags\` json NOT NULL DEFAULT ('[]'),
	\`seats\` int NOT NULL DEFAULT 10,
	\`price\` decimal(10,2) NOT NULL DEFAULT '0.00',
	\`active\` boolean NOT NULL DEFAULT TRUE,
	\`code\` varchar(16) NOT NULL,
	\`note\` varchar(200),
	\`starts_at\` datetime(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
	PRIMARY KEY (\`id\`),
	CONSTRAINT \`tours_code_unique\` UNIQUE (\`code\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
			"CREATE INDEX `tours_org_starts` ON `tours` (`org_id`, `starts_at`)",
			"CREATE UNIQUE INDEX `tours_org_title` ON `tours` (`org_id`, `note`)",
		])
	})

	it("is a query Table: defaulted columns may be left out of an insert", () => {
		expect(Tours.defaults).toEqual(["title", "tags", "seats", "price", "active", "startsAt"])
		const compiled = MySQL.compileUnsafe(MySQL.insertInto(Tours).values({ id: 1, orgId: "o", code: "c", note: null }))
		expect(compiled.sql).toContain("INSERT INTO `tours` (`id`, `org_id`, `code`, `note`)")
	})

	it("writes a DSL defaultExpr in parentheses, and refuses one that reads a column", () => {
		const T = MySQL.table("t", { columns: { a: MySQL.int, b: MySQL.column(MySQL.int, { defaultExpr: () => MySQL.lit(2) }) } })
		expect(T.ddl.columns[1]!.default).toBe("(2)")
		const reads = MySQL.table("t", { columns: { a: MySQL.int, b: MySQL.column(MySQL.int, { defaultExpr: ($) => $.a }) } })
		expect(problemsOf([reads])).toMatch(/defaultExpr reads a; a default must be constant/)
	})

	it("writes a literal default on a BLOB or JSON column as an expression, and binary as hex", () => {
		const T = MySQL.table("t", {
			columns: {
				id: MySQL.int,
				raw: MySQL.column(MySQL.blob, { default: new Uint8Array([1, 255]) }),
				bin: MySQL.column(MySQL.varbinary(4), { default: new Uint8Array([1]) }),
				doc: MySQL.column(MySQL.json(Schema.Struct({ a: Schema.String })), { default: { a: "x'y" } }),
				day: MySQL.column(MySQL.date, { default: "2024-02-29" }),
			},
		})
		expect(T.ddl.columns.map((c) => c.default)).toEqual([null, "(X'01ff')", "X'01'", `('{"a":"x\\'y"}')`, "'2024-02-29'"])
	})

	describe("records a problem, and mysqlEntitiesOf fails, for", () => {
		const cases: ReadonlyArray<readonly [string, MysqlSchemaTable<string, any>, RegExp]> = [
			["a TEXT primary key", MySQL.table("t", { columns: { id: MySQL.text }, primaryKey: ["id"] }), /id is text, which MySQL cannot index without a prefix length/],
			["a JSON index", MySQL.table("t", { columns: { id: MySQL.int, doc: MySQL.json(Schema.Unknown) }, indexes: [MySQL.index("t_doc", ["doc"])] }), /doc is json/],
			["a UNIQUE TEXT column", MySQL.table("t", { columns: { id: MySQL.column(MySQL.longtext, { unique: true }) } }), /id is longtext/],
			["a nullable primary key column", MySQL.table("t", { columns: { id: MySQL.nullable(MySQL.int) }, primaryKey: ["id"] }), /cannot be nullable/],
			["a key past InnoDB's 3072 bytes", MySQL.table("t", { columns: { a: MySQL.varchar(500), b: MySQL.varchar(400) }, indexes: [MySQL.index("t_ab", ["a", "b"])] }), /3600 bytes; InnoDB allows 3072/],
			["a name past 64 characters", MySQL.table("t", { columns: { id: MySQL.column(MySQL.int, { unique: true, name: "a".repeat(60) }) } }), /_unique" is 69 characters; MySQL allows 64/],
			["an index named PRIMARY", MySQL.table("t", { columns: { id: MySQL.int }, indexes: [MySQL.index("primary", ["id"])] }), /PRIMARY names the primary key/],
			["an index and a UNIQUE with one name", MySQL.table("t", { columns: { id: MySQL.column(MySQL.int, { unique: "t_id" }) }, indexes: [MySQL.index("T_ID", ["id"])] }), /share one namespace/],
			["two columns that differ in case", MySQL.table("t", { columns: { id: MySQL.int, Id: MySQL.int } }), /names compare without case/],
			["both default and defaultExpr", MySQL.table("t", { columns: { id: MySQL.column(MySQL.int, { default: 1, defaultExpr: "(2)" }) } }), /one of default, defaultExpr/],
			["an index on no column", MySQL.table("t", { columns: { id: MySQL.int }, indexes: [MySQL.index("t_none", [])] }), /an index needs columns/],
		]
		for (const [name, table, message] of cases) it(name, () => expect(problemsOf([table])).toMatch(message))

		it("two tables whose names differ only in case, and a table of another dialect", () => {
			const a = MySQL.table("Tours", { columns: { id: MySQL.int } })
			expect(problemsOf([Tours, a])).toMatch(/names the same table as tours/)
			const sqlite = SQLite.table("s", { columns: { id: SQLite.integer } })
			expect(problemsOf([sqlite as never])).toMatch(/is not a MySQL table with DDL/)
			expect(String(Effect.runSyncExit(sqliteEntitiesOf([Tours as never])))).toMatch(/is not a SQLite table/)
		})
	})

	it("accepts external tables and the bare columns form as query schemas with no DDL", () => {
		const External = MySQL.table("ext", { external: true, columns: { id: MySQL.int, at: MySQL.column(MySQL.datetime, { defaultExpr: MySQL.dateTimeNow }) } })
		expect("ddl" in External).toBe(false)
		expect(External.defaults).toEqual(["at"])
		const Bare = MySQL.table("bare", { id: MySQL.int })
		expect("ddl" in Bare).toBe(false)
	})
})

const v = (columns: Record<string, MySQL.ColumnInput>, indexes: ReadonlyArray<MySQL.IndexSpec<any>> = []) =>
	entities([MySQL.table("links", { columns: { id: MySQL.bigint, ...columns }, primaryKey: ["id"], indexes })])
const sqlOf = (ops: ReturnType<typeof diffMysqlSchemas>["ops"]) => ops.flatMap(renderMysqlOp)

describe("diffMysqlSchemas", () => {
	it("adds a column with ADD COLUMN and drops one only once the loss is confirmed", () => {
		const before = v({ url: MySQL.varchar(200) })
		const after = v({ url: MySQL.varchar(200), hits: MySQL.column(MySQL.int, { default: 0 }) })
		expect(sqlOf(diffMysqlSchemas(before, after).ops)).toEqual(["ALTER TABLE `links` ADD COLUMN `hits` int NOT NULL DEFAULT 0"])
		const dropped = diffMysqlSchemas(after, before)
		expect(dropped.ops).toEqual([])
		expect(dropped.missingHints).toEqual([{ type: "confirm_data_loss", kind: "column", entity: "links.hits" }])
		expect(sqlOf(diffMysqlSchemas(after, before, dropped.missingHints).ops)).toEqual(["ALTER TABLE `links` DROP COLUMN `hits`"])
	})

	it("changes a column in place with MODIFY COLUMN, filling NULLs with the default when it becomes NOT NULL", () => {
		const before = v({ note: MySQL.nullable(MySQL.varchar(20)) })
		const after = v({ note: MySQL.column(MySQL.varchar(20), { default: "none" }) })
		expect(sqlOf(diffMysqlSchemas(before, after).ops)).toEqual([
			"ALTER TABLE `links` MODIFY COLUMN `note` varchar(20) DEFAULT 'none'",
			"UPDATE `links` SET `note` = 'none' WHERE `note` IS NULL",
			"ALTER TABLE `links` MODIFY COLUMN `note` varchar(20) NOT NULL DEFAULT 'none'",
		])
		expect(sqlOf(diffMysqlSchemas(after, before).ops)).toEqual(["ALTER TABLE `links` MODIFY COLUMN `note` varchar(20)"])
	})

	it("asks before a type change converts a column's values", () => {
		const retyped = diffMysqlSchemas(v({ n: MySQL.varchar(20) }), v({ n: MySQL.int }))
		expect(retyped.missingHints).toEqual([{ type: "confirm_data_loss", kind: "column", entity: "links.n" }])
	})

	it("replaces the primary key, around the column changes it depends on", () => {
		const before = entities([MySQL.table("links", { columns: { id: MySQL.bigint, org: MySQL.nullable(MySQL.varchar(36)) }, primaryKey: ["id"] })])
		const after = entities([MySQL.table("links", { columns: { id: MySQL.bigint, org: MySQL.varchar(36) }, primaryKey: ["org", "id"] })])
		expect(sqlOf(diffMysqlSchemas(before, after).ops)).toEqual([
			"ALTER TABLE `links` DROP PRIMARY KEY",
			"ALTER TABLE `links` MODIFY COLUMN `org` varchar(36) NOT NULL",
			"ALTER TABLE `links` ADD PRIMARY KEY (`org`, `id`)",
		])
	})

	it("drops indexes and UNIQUE constraints before the columns change, and adds them after", () => {
		const before = v({ code: MySQL.column(MySQL.varchar(16), { unique: true }) }, [MySQL.index("links_code", ["code"])])
		const after = v({ code: MySQL.text })
		expect(sqlOf(diffMysqlSchemas(before, after, [{ type: "confirm_data_loss", kind: "column", entity: "links.code" }]).ops)).toEqual([
			"DROP INDEX `links_code` ON `links`",
			"DROP INDEX `links_code_unique` ON `links`",
			"ALTER TABLE `links` MODIFY COLUMN `code` text NOT NULL",
		])
		expect(sqlOf(diffMysqlSchemas(v({ code: MySQL.varchar(16) }), before).ops)).toEqual([
			"ALTER TABLE `links` ADD CONSTRAINT `links_code_unique` UNIQUE (`code`)",
			"CREATE INDEX `links_code` ON `links` (`code`)",
		])
	})

	it("renames a table and a column on a hint, keeping their indexes, and a column renamed by case with none", () => {
		const before = entities([MySQL.table("links", { columns: { id: MySQL.bigint, url: MySQL.varchar(200) }, primaryKey: ["id"], indexes: [MySQL.index("links_url", ["url"])] })])
		const after = entities([MySQL.table("urls", { columns: { id: MySQL.bigint, target: MySQL.varchar(200) }, primaryKey: ["id"], indexes: [MySQL.index("links_url", ["target"])] })])
		const hints = [
			{ type: "confirm_rename", kind: "table", entity: "links", to: "urls" },
			{ type: "confirm_rename", kind: "column", entity: "urls.url", to: "target" },
		] as const
		expect(sqlOf(diffMysqlSchemas(before, after, hints).ops)).toEqual(["RENAME TABLE `links` TO `urls`", "ALTER TABLE `urls` CHANGE COLUMN `url` `target` varchar(200) NOT NULL"])
		const cased = entities([MySQL.table("links", { columns: { id: MySQL.bigint, URL: MySQL.varchar(200) }, primaryKey: ["id"], indexes: [MySQL.index("links_url", ["URL"])] })])
		expect(sqlOf(diffMysqlSchemas(before, cased).ops)).toEqual(["ALTER TABLE `links` CHANGE COLUMN `url` `URL` varchar(200) NOT NULL"])
	})

	it("creates a new table with its UNIQUE constraints inside, and drops a table only once confirmed", () => {
		const created = diffMysqlSchemas([], v({ code: MySQL.column(MySQL.varchar(16), { unique: true }) }))
		expect(created.ops.map((op) => op.op)).toEqual(["create_table"])
		expect(diffMysqlSchemas(v({}), []).missingHints).toEqual([{ type: "confirm_data_loss", kind: "table", entity: "links" }])
	})
})

// The table type-checks as a Database query too.
export const insertTour = (db: Db.DatabaseApi<"mysql">) => db.run(MySQL.insertInto(Tours).values({ id: 1, orgId: "o", code: "c", note: null }))
