import { Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { diffMysqlSchemas, labelOfMysql, mysqlEntitiesOf, renderMysqlOp, renderMysqlSchema, sqliteEntitiesOf, type MysqlSchemaTable } from "../schema"
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

	describe("generated columns", () => {
		const Orders = MySQL.table("orders", {
			casing: "snake_case",
			columns: {
				id: MySQL.bigint,
				qty: MySQL.int,
				unitPrice: MySQL.int,
				total: MySQL.column(MySQL.int, { generated: { as: ($) => $.qty.mul($.unitPrice), stored: true } }),
				email: MySQL.varchar(200),
				emailLower: MySQL.column(MySQL.nullable(MySQL.varchar(200)), { generated: { as: "LOWER(`email`)" }, unique: true }),
				note: MySQL.column(MySQL.text, { default: "" }),
			},
			primaryKey: ["id"],
		})

		it("writes GENERATED ALWAYS AS (...) STORED or VIRTUAL, with no NOT NULL or DEFAULT", () => {
			expect(renderMysqlSchema(entities([Orders]))).toEqual([
				`CREATE TABLE IF NOT EXISTS \`orders\` (
	\`id\` bigint NOT NULL,
	\`qty\` int NOT NULL,
	\`unit_price\` int NOT NULL,
	\`total\` int GENERATED ALWAYS AS (\`qty\` * \`unit_price\`) STORED,
	\`email\` varchar(200) NOT NULL,
	\`email_lower\` varchar(200) GENERATED ALWAYS AS (LOWER(\`email\`)) VIRTUAL,
	\`note\` text NOT NULL DEFAULT (''),
	PRIMARY KEY (\`id\`),
	CONSTRAINT \`orders_email_lower_unique\` UNIQUE (\`email_lower\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
			])
			// A column that is not generated carries no generated key, so earlier snapshots keep their ids.
			expect("generated" in Orders.ddl.columns[0]!).toBe(false)
		})

		it("are computed: left out of inserts and update SETs, refused there at runtime, and selectable", () => {
			expect(Orders.computed).toEqual(["total", "emailLower"])
			expect(Orders.defaults).toEqual(["note"])
			const insert = MySQL.insertInto(Orders).values({ id: 1, qty: 2, unitPrice: 3, email: "A@x" })
			expect(MySQL.compileUnsafe(insert).sql).toBe("INSERT INTO `orders` (`id`, `qty`, `unit_price`, `email`)\nVALUES (?, ?, ?, ?)")
			expect(() => MySQL.compileUnsafe(MySQL.insertInto(Orders).values({ id: 1, qty: 2, unitPrice: 3, email: "a", total: 6 } as never))).toThrow(
				/row 0 writes total, which the database computes/,
			)
			expect(() => MySQL.compileUnsafe(MySQL.update(Orders).set({ total: 1 } as never).allRows())).toThrow(/not an insertable column/)
			// excludedAll copies the written columns, never a generated one.
			expect(MySQL.compileUnsafe(insert.onDuplicateKeyUpdate({ set: MySQL.excludedAll() })).sql.split("\n").at(-1)).toBe(
				"ON DUPLICATE KEY UPDATE `qty` = `excluded`.`qty`, `unit_price` = `excluded`.`unit_price`, `email` = `excluded`.`email`",
			)
			expect(MySQL.compileUnsafe(MySQL.from(Orders).select("total", "emailLower")).sql).toMatch(/`orders`\.`total` AS `total`,\s+`orders`\.`email_lower` AS `emailLower`/)
			const schemas = MySQL.tableSchemas(Orders)
			expect(Object.keys(schemas.insert.fields)).toEqual(["id", "qty", "unitPrice", "email", "note"])
			expect(Object.keys(schemas.update.fields)).toEqual(["id", "qty", "unitPrice", "email", "note"])
			expect(Object.keys(schemas.select.fields)).toContain("total")
		})

		it("on an external table: computed, with no DDL and no client default", () => {
			const External = MySQL.table("orders", {
				external: true,
				columns: {
					id: MySQL.bigint,
					total: MySQL.column(MySQL.int, { name: "total_cents", generated: { as: "qty * price", stored: true } }),
					at: MySQL.column(MySQL.datetime, { defaultExpr: MySQL.dateTimeNow }),
				},
			})
			expect("ddl" in External).toBe(false)
			expect(External.computed).toEqual(["total"])
			expect(External.defaults).toEqual(["at"])
			expect(External.clientDefaults).toBeUndefined()
			expect(MySQL.compileUnsafe(MySQL.insertInto(External).values({ id: 1 })).sql).toBe("INSERT INTO `orders` (`id`)\nVALUES (?)")
		})

		const cases: ReadonlyArray<readonly [string, MysqlSchemaTable<string, any>, RegExp]> = [
			["a default", MySQL.table("t", { columns: { a: MySQL.int, b: MySQL.column(MySQL.int, { generated: { as: "a + 1" }, default: 1 } as never) } }), /a generated column takes no default; the database computes it/],
			["a defaultFn and an onUpdate", MySQL.table("t", { columns: { a: MySQL.int, b: MySQL.column(MySQL.int, { generated: { as: "a + 1" }, defaultFn: Effect.succeed(1), onUpdate: Effect.succeed(1) } as never) } }), /takes no defaultFn, onUpdate/],
			["reading itself", MySQL.table("t", { columns: { a: MySQL.int, b: MySQL.column(MySQL.int, { generated: { as: ($) => $.b!.add(1) } }) } }), /cannot read itself/],
			[
				"reading a generated column declared after it",
				MySQL.table("t", {
					columns: {
						a: MySQL.int,
						b: MySQL.column(MySQL.int, { generated: { as: ($) => $.c!.add(1) } }),
						c: MySQL.column(MySQL.int, { generated: { as: ($) => $.a!.add(1) } }),
					},
				}),
				/generated reads c, generated after it/,
			],
			["an empty expression", MySQL.table("t", { columns: { a: MySQL.int, b: MySQL.column(MySQL.int, { generated: { as: " " } }) } }), /generated takes an expression in as/],
			["a generated tenant column", MySQL.table("t", { columns: { a: MySQL.int, b: MySQL.column(MySQL.int, { generated: { as: "a" } }) }, tenantColumn: "b" }), /the tenant column cannot be generated/],
			[
				"a non-nullable column computed from a nullable one",
				MySQL.table("t", { columns: { a: MySQL.nullable(MySQL.int), b: MySQL.column(MySQL.int, { generated: { as: ($) => $.a!.add(1) } }) } }),
				/generated reads a, which can be NULL; declare the column MySQL.nullable/,
			],
			["a generated primary key column", MySQL.table("t", { columns: { a: MySQL.int, id: MySQL.column(MySQL.int, { generated: { as: "a", stored: true } }) }, primaryKey: ["id"] }), /cannot be in the primary key/],
		]
		for (const [name, table, message] of cases) it(`refuses ${name}`, () => expect(problemsOf([table])).toMatch(message))

		it("may read base columns in any order, and generated ones declared before it", () => {
			const T = MySQL.table("t", {
				columns: {
					b: MySQL.column(MySQL.int, { generated: { as: ($) => $.a!.add(1) } }),
					c: MySQL.column(MySQL.int, { generated: { as: ($) => $.b!.add(1) } }),
					a: MySQL.int,
				},
			})
			expect(problemsOf([T])).toBe("")
		})
	})

	describe("records a problem, and mysqlEntitiesOf fails, for", () => {
		const cases: ReadonlyArray<readonly [string, MysqlSchemaTable<string, any>, RegExp]> = [
			["a TEXT primary key", MySQL.table("t", { columns: { id: MySQL.text }, primaryKey: ["id"] }), /id is text, which MySQL cannot index without a prefix length/],
			["a JSON index", MySQL.table("t", { columns: { id: MySQL.int, doc: MySQL.json(Schema.Unknown) }, indexes: [MySQL.index("t_doc", ["doc"])] }), /doc is json/],
			["a UNIQUE TEXT column", MySQL.table("t", { columns: { id: MySQL.column(MySQL.longtext, { unique: true }) } }), /id is longtext/],
			["a nullable primary key column", MySQL.table("t", { columns: { id: MySQL.nullable(MySQL.int) }, primaryKey: ["id"] }), /cannot be nullable/],
			["a key past InnoDB's 3072 bytes", MySQL.table("t", { columns: { a: MySQL.varchar(500), b: MySQL.varchar(400) }, indexes: [MySQL.index("t_ab", ["a", "b"])] }), /3600 bytes; InnoDB allows 3072/],
			// Fixed-width parts count too: 767 * 4 + 4 + 4 = 3076.
			["a key whose fixed-width parts take it past 3072 bytes", MySQL.table("t", { columns: { a: MySQL.varchar(767), b: MySQL.int, c: MySQL.int }, indexes: [MySQL.index("t_abc", ["a", "b", "c"])] }), /3076 bytes; InnoDB allows 3072/],
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

	describe("generated columns", () => {
		const total = (as: string, stored?: boolean) => MySQL.column(MySQL.int, { generated: { as, stored } })
		const missing = (entity: string) => [{ type: "confirm_data_loss", kind: "column", entity: `links.${entity}` }] as const

		it("creates one, adds one in its place, and changes its expression or type in place", () => {
			const created = diffMysqlSchemas([], v({ n: MySQL.int, total: total("n * 2", true) }))
			expect(sqlOf(created.ops)[0]).toContain("`total` int GENERATED ALWAYS AS (n * 2) STORED")
			const before = v({ n: MySQL.int, total: total("n * 2", true) })
			expect(sqlOf(diffMysqlSchemas(before, v({ n: MySQL.int, total: total("n * 3", true) })).ops)).toEqual([
				"ALTER TABLE `links` MODIFY COLUMN `total` int GENERATED ALWAYS AS (n * 3) STORED",
			])
			// A generated column's values are computed, so a new type loses nothing: no hint.
			const retyped = diffMysqlSchemas(before, v({ n: MySQL.int, total: MySQL.column(MySQL.bigint, { generated: { as: "n * 2", stored: true } }) }))
			expect(retyped.missingHints).toEqual([])
			expect(sqlOf(retyped.ops)).toEqual(["ALTER TABLE `links` MODIFY COLUMN `total` bigint GENERATED ALWAYS AS (n * 2) STORED"])
			expect(sqlOf(diffMysqlSchemas(v({ n: MySQL.int }), v({ n: MySQL.int, total: total("n * 2") })).ops)).toEqual([
				"ALTER TABLE `links` ADD COLUMN `total` int GENERATED ALWAYS AS (n * 2) VIRTUAL AFTER `n`",
			])
		})

		it("turns a base column STORED and back with MODIFY, confirming only the values a base column loses", () => {
			const base = v({ n: MySQL.int, total: MySQL.column(MySQL.int, { unique: true }) })
			const stored = v({ n: MySQL.int, total: MySQL.column(MySQL.int, { generated: { as: "n * 2", stored: true }, unique: true }) })
			expect(diffMysqlSchemas(base, stored).missingHints).toEqual(missing("total"))
			expect(sqlOf(diffMysqlSchemas(base, stored, missing("total")).ops)).toEqual([
				"ALTER TABLE `links` MODIFY COLUMN `total` int GENERATED ALWAYS AS (n * 2) STORED",
			])
			// STORED to base keeps the stored values, and the UNIQUE constraint stays where it is.
			const made = diffMysqlSchemas(stored, base)
			expect(made.missingHints).toEqual([])
			expect(sqlOf(made.ops)).toEqual(["ALTER TABLE `links` MODIFY COLUMN `total` int NOT NULL"])
		})

		it("drops and adds a column back, at its place and around its keys, when it becomes or stops being VIRTUAL", () => {
			const indexed = (stored: boolean) => v({ n: MySQL.int, total: total("n * 2", stored), z: MySQL.int }, [MySQL.index("links_total", ["total"])])
			const toVirtual = diffMysqlSchemas(indexed(true), indexed(false))
			expect(toVirtual.missingHints).toEqual([])
			expect(sqlOf(toVirtual.ops)).toEqual([
				"DROP INDEX `links_total` ON `links`",
				"ALTER TABLE `links` DROP COLUMN `total`, ADD COLUMN `total` int GENERATED ALWAYS AS (n * 2) VIRTUAL AFTER `n`",
				"CREATE INDEX `links_total` ON `links` (`total`)",
			])
			// Computed again: a rewrite, not a loss. A base column made VIRTUAL loses its values.
			expect(toVirtual.ops.map(labelOfMysql)).toEqual(["metadata", "rewrite", "metadata"])
			const base = v({ n: MySQL.int, total: MySQL.int })
			const virtual = v({ n: MySQL.int, total: total("n * 2") })
			expect(diffMysqlSchemas(base, virtual).missingHints).toEqual(missing("total"))
			const made = diffMysqlSchemas(base, virtual, missing("total")).ops
			expect(made.map(labelOfMysql)).toEqual(["destructive"])
			expect(diffMysqlSchemas(virtual, base, missing("total")).ops.map((op) => op.op)).toEqual(["replace_column"])
		})

		it("refuses to make a VIRTUAL column base under a UNIQUE key: every row would take its default", () => {
			const unique = (column: MySQL.ColumnInput) => v({ n: MySQL.int, total: column }, [MySQL.uniqueIndex("links_total", ["total"])])
			const result = diffMysqlSchemas(unique(total("n * 2")), unique(MySQL.int), missing("total"))
			expect(result.unsupported).toEqual([{ entity: "links.total", message: expect.stringMatching(/make it STORED in one migration, then base in the next/) }])
		})

		it("drops a generated column before the base column it reads", () => {
			const before = v({ a: MySQL.int, g: MySQL.column(MySQL.int, { generated: { as: ($) => $.a!.add(1) } }), h: total("a + 2", true) })
			const hints = [...missing("a"), ...missing("g"), ...missing("h")]
			expect(sqlOf(diffMysqlSchemas(before, v({}), hints).ops)).toEqual([
				"ALTER TABLE `links` DROP COLUMN `h`",
				"ALTER TABLE `links` DROP COLUMN `g`",
				"ALTER TABLE `links` DROP COLUMN `a`",
			])
		})

		it("adds the base columns a generated column reads before it", () => {
			const after = v({ g: MySQL.column(MySQL.int, { generated: { as: ($) => $.a!.add(1) } }), a: MySQL.int })
			expect(sqlOf(diffMysqlSchemas(v({}), after).ops)).toEqual([
				"ALTER TABLE `links` ADD COLUMN `a` int NOT NULL",
				"ALTER TABLE `links` ADD COLUMN `g` int GENERATED ALWAYS AS (`a` + 1) VIRTUAL AFTER `id`",
			])
		})

		it("drops the generated columns reading a renamed column before the rename, and adds them back after", () => {
			const version = (qty: string) =>
				v({
					[qty]: MySQL.int,
					g: MySQL.column(MySQL.int, { generated: { as: ($) => $[qty]!.mul(2), stored: true } }),
					// Read through g, and by a string expression naming the column: both come back.
					h: MySQL.column(MySQL.int, { generated: { as: ($) => $.g!.add(1) } }),
					s: total(`${qty} + 1`),
					other: total("id + 1"),
				}, [MySQL.index("links_g", ["g"])])
			const renamed = diffMysqlSchemas(version("qty"), version("quantity"), [{ type: "confirm_rename", kind: "column", entity: "links.qty", to: "quantity" }])
			expect(renamed.missingHints).toEqual([])
			expect(sqlOf(renamed.ops)).toEqual([
				"DROP INDEX `links_g` ON `links`",
				"ALTER TABLE `links` DROP COLUMN `s`",
				"ALTER TABLE `links` DROP COLUMN `h`",
				"ALTER TABLE `links` DROP COLUMN `g`",
				"ALTER TABLE `links` CHANGE COLUMN `qty` `quantity` int NOT NULL",
				"ALTER TABLE `links` ADD COLUMN `g` int GENERATED ALWAYS AS (`quantity` * 2) STORED AFTER `quantity`",
				"ALTER TABLE `links` ADD COLUMN `h` int GENERATED ALWAYS AS (`g` + 1) VIRTUAL AFTER `g`",
				"ALTER TABLE `links` ADD COLUMN `s` int GENERATED ALWAYS AS (quantity + 1) VIRTUAL AFTER `h`",
				"CREATE INDEX `links_g` ON `links` (`g`)",
			])
			// A rename by case needs no hint, and rebuilds the same way.
			expect(sqlOf(diffMysqlSchemas(version("qty"), version("QTY")).ops)).toContain("ALTER TABLE `links` CHANGE COLUMN `qty` `QTY` int NOT NULL")
			expect(sqlOf(diffMysqlSchemas(version("qty"), version("QTY")).ops)[3]).toBe("ALTER TABLE `links` DROP COLUMN `g`")
		})

		it("drops and adds back, in dependency order, generated columns replaced together with the one they read", () => {
			const chain = (stored: boolean) =>
				v({
					n: MySQL.int,
					a: total("n * 2", stored),
					b: MySQL.column(MySQL.int, { generated: { as: ($) => $.a!.add(1), stored }, unique: true }),
					c: MySQL.column(MySQL.int, { generated: { as: ($) => $.b!.mul(2), stored } }),
				})
			for (const [from, to] of [[false, true], [true, false]] as const) {
				const kind = to ? "STORED" : "VIRTUAL"
				const result = diffMysqlSchemas(chain(from), chain(to))
				expect(result.missingHints).toEqual([])
				expect(sqlOf(result.ops)).toEqual([
					"DROP INDEX `links_b_unique` ON `links`",
					"ALTER TABLE `links` DROP COLUMN `c`",
					"ALTER TABLE `links` DROP COLUMN `b`",
					`ALTER TABLE \`links\` DROP COLUMN \`a\`, ADD COLUMN \`a\` int GENERATED ALWAYS AS (n * 2) ${kind} AFTER \`n\``,
					`ALTER TABLE \`links\` ADD COLUMN \`b\` int GENERATED ALWAYS AS (\`a\` + 1) ${kind} AFTER \`a\``,
					`ALTER TABLE \`links\` ADD COLUMN \`c\` int GENERATED ALWAYS AS (\`b\` * 2) ${kind} AFTER \`b\``,
					"ALTER TABLE `links` ADD CONSTRAINT `links_b_unique` UNIQUE (`b`)",
				])
			}
		})

		it("drops and adds back a generated column that is renamed or replaced while a column it reads is renamed", () => {
			const version = (qty: string, g: string, stored: boolean) =>
				v({ [qty]: MySQL.int, [g]: MySQL.column(MySQL.int, { generated: { as: ($) => $[qty]!.mul(2), stored } }) })
			const hints = [
				{ type: "confirm_rename", kind: "column", entity: "links.qty", to: "quantity" },
				{ type: "confirm_rename", kind: "column", entity: "links.g", to: "twice" },
			] as const
			// Renamed both, and made VIRTUAL: dropped by its old name, added back under its new one.
			expect(sqlOf(diffMysqlSchemas(version("qty", "g", true), version("quantity", "twice", false), hints).ops)).toEqual([
				"ALTER TABLE `links` DROP COLUMN `g`",
				"ALTER TABLE `links` CHANGE COLUMN `qty` `quantity` int NOT NULL",
				"ALTER TABLE `links` ADD COLUMN `twice` int GENERATED ALWAYS AS (`quantity` * 2) VIRTUAL AFTER `quantity`",
			])
			// Replaced while the column it reads is renamed.
			expect(sqlOf(diffMysqlSchemas(version("qty", "g", true), version("quantity", "g", false), [hints[0]]).ops)).toEqual([
				"ALTER TABLE `links` DROP COLUMN `g`",
				"ALTER TABLE `links` CHANGE COLUMN `qty` `quantity` int NOT NULL",
				"ALTER TABLE `links` ADD COLUMN `g` int GENERATED ALWAYS AS (`quantity` * 2) VIRTUAL AFTER `quantity`",
			])
		})

		it("drops the generated columns reading a column that becomes or stops being VIRTUAL, and adds them back after", () => {
			const version = (stored: boolean) => v({ n: MySQL.int, total: total("n * 2", stored), doubled: MySQL.column(MySQL.int, { generated: { as: ($) => $.total!.mul(2) } }) })
			expect(sqlOf(diffMysqlSchemas(version(true), version(false)).ops)).toEqual([
				"ALTER TABLE `links` DROP COLUMN `doubled`",
				"ALTER TABLE `links` DROP COLUMN `total`, ADD COLUMN `total` int GENERATED ALWAYS AS (n * 2) VIRTUAL AFTER `n`",
				"ALTER TABLE `links` ADD COLUMN `doubled` int GENERATED ALWAYS AS (`total` * 2) VIRTUAL AFTER `total`",
			])
		})
	})

	it("creates a new table with its UNIQUE constraints inside, and drops a table only once confirmed", () => {
		const created = diffMysqlSchemas([], v({ code: MySQL.column(MySQL.varchar(16), { unique: true }) }))
		expect(created.ops.map((op) => op.op)).toEqual(["create_table"])
		expect(diffMysqlSchemas(v({}), []).missingHints).toEqual([{ type: "confirm_data_loss", kind: "table", entity: "links" }])
	})
})

// The table type-checks as a Database query too.
export const insertTour = (db: Db.DatabaseApi<"mysql">) => db.run(MySQL.insertInto(Tours).values({ id: 1, orgId: "o", code: "c", note: null }))
