// MySQL.table DDL on MySQL 8.4 and MariaDB 11.4, live when EFFECT_ORM_MYSQL_URL /
// EFFECT_ORM_MARIADB_URL are set: the rendered CREATE statements run, the
// catalog reports what the entities say, and an insert that leaves the
// defaulted columns out reads back their defaults through the builder.
import { afterAll, describe, expect, it } from "vitest"
import { DateTime, Effect, Schema } from "effect"
import * as MySQL from "@maple-dev/effect-orm/mysql"
import { diffMysqlSchemas, mysqlEntitiesOf, renderMysqlOp, renderMysqlSchema, type MysqlSchemaTable } from "@maple-dev/effect-orm/schema"
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

		it("computes generated columns, STORED and VIRTUAL, on a table it owns and on an external one", async () => {
			const db = await scratchDatabase(server, "ddl")
			opened.push(db)
			const Orders = MySQL.table("orders", {
				casing: "snake_case",
				columns: {
					id: MySQL.bigint,
					qty: MySQL.int,
					unitPrice: MySQL.int,
					total: MySQL.column(MySQL.int, { generated: { as: ($) => $.qty.mul($.unitPrice), stored: true } }),
					doubled: MySQL.column(MySQL.int, { generated: { as: ($) => $.total.mul(2) } }),
					email: MySQL.varchar(200),
					emailLower: MySQL.column(MySQL.nullable(MySQL.varchar(200)), { generated: { as: "LOWER(`email`)" }, unique: true }),
				},
				primaryKey: ["id"],
				indexes: [MySQL.index("orders_total", ["total"])],
			})
			for (const sql of renderMysqlSchema(await Effect.runPromise(mysqlEntitiesOf([Orders])))) await db.query(sql, [])
			const generated = await db.query(`SELECT COLUMN_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders' AND EXTRA LIKE '%GENERATED%' ORDER BY ORDINAL_POSITION`, [db.name])
			expect(generated.map((c) => [c.COLUMN_NAME, String(c.EXTRA).replace("PERSISTENT", "STORED")])).toEqual([
				["total", "STORED GENERATED"],
				["doubled", "VIRTUAL GENERATED"],
				["email_lower", "VIRTUAL GENERATED"],
			])

			const run = async (write: object) => {
				const compiled = MySQL.compileUnsafe(write as never, undefined, { dialect })
				await db.query(compiled.sql, compiled.parameters)
			}
			const read = async () => {
				const select = MySQL.compileUnsafe(MySQL.from(Orders).select().orderBy(["id", "asc"]), undefined, { dialect })
				return Effect.runPromise(select.decodeRows(await db.query(select.sql, select.parameters)))
			}
			const insert = MySQL.insertInto(Orders).values([
				{ id: 1, qty: 2, unitPrice: 3, email: "A@X.io" },
				{ id: 2, qty: 1, unitPrice: 5, email: "b@x.io" },
			])
			await run(insert)
			expect(await read()).toEqual([
				{ id: 1, qty: 2, unitPrice: 3, total: 6, doubled: 12, email: "A@X.io", emailLower: "a@x.io" },
				{ id: 2, qty: 1, unitPrice: 5, total: 5, doubled: 10, email: "b@x.io", emailLower: "b@x.io" },
			])
			// excludedAll copies the written columns only; the database computes the rest again.
			await run(MySQL.insertInto(Orders).values({ id: 1, qty: 4, unitPrice: 3, email: "c@x.io" }).onDuplicateKeyUpdate({ set: MySQL.excludedAll() }))
			await run(MySQL.update(Orders).set({ qty: 10 }).where(($) => [$.id.eq(2)]))
			expect(await read()).toEqual([
				{ id: 1, qty: 4, unitPrice: 3, total: 12, doubled: 24, email: "c@x.io", emailLower: "c@x.io" },
				{ id: 2, qty: 10, unitPrice: 5, total: 50, doubled: 100, email: "b@x.io", emailLower: "b@x.io" },
			])
			// The UNIQUE on the generated column holds.
			await expect(run(MySQL.insertInto(Orders).values({ id: 3, qty: 1, unitPrice: 1, email: "C@X.IO" }))).rejects.toThrow(/Duplicate entry/)

			// A table another tool owns: its DDL is MySQL's own, and the external declaration only marks the columns computed.
			await db.query(
				`CREATE TABLE \`lines\` (\`id\` int NOT NULL PRIMARY KEY, \`a\` int NOT NULL, \`b\` int NOT NULL,
				\`sum_ab\` int GENERATED ALWAYS AS (\`a\` + \`b\`) STORED, \`product\` int GENERATED ALWAYS AS (\`a\` * \`b\`) VIRTUAL)`,
				[],
			)
			const Lines = MySQL.table("lines", {
				external: true,
				columns: {
					id: MySQL.int,
					a: MySQL.int,
					b: MySQL.int,
					sum: MySQL.column(MySQL.int, { name: "sum_ab", generated: { as: "a + b", stored: true } }),
					product: MySQL.column(MySQL.int, { generated: { as: "a * b" } }),
				},
			})
			await run(MySQL.insertInto(Lines).values({ id: 1, a: 3, b: 4 }).onDuplicateKeyUpdate({ set: MySQL.excludedAll(["id"]) }))
			await run(MySQL.insertInto(Lines).values({ id: 1, a: 5, b: 4 }).onDuplicateKeyUpdate({ set: MySQL.excludedAll(["id"]) }))
			const select = MySQL.compileUnsafe(MySQL.from(Lines).select(), undefined, { dialect })
			expect(await Effect.runPromise(select.decodeRows(await db.query(select.sql, select.parameters)))).toEqual([{ id: 1, a: 5, b: 4, sum: 9, product: 20 }])
			// What the database says when a write names a generated column anyway: the builder never sends one.
			await expect(db.query("INSERT INTO `lines` (`id`, `a`, `b`, `sum_ab`) VALUES (2, 1, 1, 2)", [])).rejects.toThrow(/generated column/)
		})

		it("migrates a generated column: a new expression, STORED to VIRTUAL under an index, and a base column made generated", async () => {
			const db = await scratchDatabase(server, "ddl")
			opened.push(db)
			const version = (total: MySQL.ColumnInput, label: MySQL.ColumnInput) =>
				MySQL.table("items", { columns: { id: MySQL.int, n: MySQL.int, total, label }, primaryKey: ["id"], indexes: [MySQL.index("items_total", ["total"])] })
			const before = version(MySQL.column(MySQL.int, { generated: { as: "n * 2", stored: true } }), MySQL.column(MySQL.varchar(20), { default: "x" }))
			const after = version(MySQL.column(MySQL.int, { generated: { as: "n * 3" } }), MySQL.column(MySQL.nullable(MySQL.varchar(20)), { generated: { as: "CONCAT('#', n)", stored: true } }))
			const from = await Effect.runPromise(mysqlEntitiesOf([before]))
			const to = await Effect.runPromise(mysqlEntitiesOf([after]))
			for (const sql of renderMysqlSchema(from)) await db.query(sql, [])
			await db.query("INSERT INTO `items` (`id`, `n`) VALUES (1, 5)", [])
			const pending = diffMysqlSchemas(from, to)
			expect(pending.missingHints).toEqual([{ type: "confirm_data_loss", kind: "column", entity: "items.label" }])
			const diff = diffMysqlSchemas(from, to, pending.missingHints)
			for (const sql of diff.ops.flatMap(renderMysqlOp)) await db.query(sql, [])
			expect(await db.query("SELECT `total`, `label` FROM `items`", [])).toEqual([{ total: 15, label: "#5" }])
			// Nothing is left to change.
			expect(diffMysqlSchemas(to, to).ops).toEqual([])
		})

		// Each case creates a database and runs DDL on it, often several times: seconds apiece on MySQL.
		describe("migrates generated columns", { timeout: 30_000 }, () => {
			type Hints = Parameters<typeof diffMysqlSchemas>[2]
			const T = (columns: Record<string, MySQL.ColumnInput>, indexes: ReadonlyArray<MySQL.IndexSpec<any>> = []) =>
				MySQL.table("t", { columns: { id: MySQL.int, ...columns }, primaryKey: ["id"], indexes })
			const gen = (as: MySQL.GeneratedColumn["as"], stored = false) => MySQL.column(MySQL.int, { generated: { as, stored } })
			/** Create `before`, run `seed`, apply the diff to `after` (with the hints it asks for), and read every row. */
			const migrate = async (before: MysqlSchemaTable<"t", any>, after: MysqlSchemaTable<"t", any>, seed: ReadonlyArray<string>, hints: Hints = []) => {
				const db = await scratchDatabase(server, "gen")
				opened.push(db)
				const from = await Effect.runPromise(mysqlEntitiesOf([before]))
				const to = await Effect.runPromise(mysqlEntitiesOf([after]))
				for (const sql of renderMysqlSchema(from)) await db.query(sql, [])
				for (const sql of seed) await db.query(sql, [])
				const pending = diffMysqlSchemas(from, to, hints)
				const diff = diffMysqlSchemas(from, to, [...(hints ?? []), ...pending.missingHints])
				expect(diff.unsupported).toEqual([])
				for (const sql of diff.ops.flatMap(renderMysqlOp)) await db.query(sql, [])
				// The table now reads as `after` says, in its order, and nothing is left to change.
				const columns = await db.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 't' ORDER BY ORDINAL_POSITION`, [db.name])
				const select = MySQL.compileUnsafe(MySQL.from(after).select().orderBy(["id", "asc"]), undefined, { dialect })
				const rows = await Effect.runPromise(select.decodeRows(await db.query(select.sql, select.parameters)))
				return { rows, columns: columns.map((c) => c.COLUMN_NAME), missing: pending.missingHints }
			}

			it("drops a generated column before the base column it reads", async () => {
				const { rows } = await migrate(T({ a: MySQL.int, g: gen(($) => $.a!.add(1)), s: gen(($) => $.a!.add(2), true) }), T({}), ["INSERT INTO t (id, a) VALUES (1, 1)"])
				expect(rows).toEqual([{ id: 1 }])
			})

			it("adds a base column before the generated column declared ahead of it that reads it", async () => {
				const { rows, columns } = await migrate(T({}), T({ g: gen(($) => $.a!.add(1), true), a: MySQL.column(MySQL.int, { default: 4 }) }), ["INSERT INTO t (id) VALUES (1)"])
				expect(rows).toEqual([{ id: 1, g: 5, a: 4 }])
				expect(columns).toEqual(["id", "g", "a"])
			})

			it("renames a column generated columns read, dropping and adding them back around it", async () => {
				const version = (qty: string) =>
					T({ [qty]: MySQL.int, g: gen(($) => $[qty]!.mul(2), true), h: gen(($) => $.g!.add(1)), s: gen(`${qty} + 100`) }, [MySQL.uniqueIndex("t_g", ["g"])])
				const renamed = await migrate(version("qty"), version("quantity"), ["INSERT INTO t (id, qty) VALUES (1, 4), (2, 5)"], [{ type: "confirm_rename", kind: "column", entity: "t.qty", to: "quantity" }])
				expect(renamed.rows).toEqual([{ id: 1, quantity: 4, g: 8, h: 9, s: 104 }, { id: 2, quantity: 5, g: 10, h: 11, s: 105 }])
				expect(renamed.columns).toEqual(["id", "quantity", "g", "h", "s"])
				// By case only: no hint.
				const cased = await migrate(version("qty"), version("QTY"), ["INSERT INTO t (id, qty) VALUES (1, 4)"])
				expect(cased.rows).toEqual([{ id: 1, QTY: 4, g: 8, h: 9, s: 104 }])
			})

			it("makes a STORED column VIRTUAL and back under a UNIQUE key, with a generated column reading it", async () => {
				const version = (stored: boolean) => T({ n: MySQL.int, total: MySQL.column(MySQL.int, { generated: { as: "n * 2", stored }, unique: true }), doubled: gen(($) => $.total!.mul(2)), z: MySQL.int })
				for (const [from, to] of [[true, false], [false, true]] as const) {
					const { rows, columns, missing } = await migrate(version(from), version(to), ["INSERT INTO t (id, n, z) VALUES (1, 4, 0), (2, 5, 0)"])
					expect(missing).toEqual([])
					expect(rows).toEqual([{ id: 1, n: 4, total: 8, doubled: 16, z: 0 }, { id: 2, n: 5, total: 10, doubled: 20, z: 0 }])
					expect(columns).toEqual(["id", "n", "total", "doubled", "z"])
				}
			})

			it("replaces a chain of three generated columns together, each reading the one before", async () => {
				const chain = (stored: boolean) =>
					T({
						n: MySQL.int,
						a: gen("n * 2", stored),
						b: MySQL.column(MySQL.int, { generated: { as: ($) => $.a!.add(1), stored }, unique: true }),
						c: gen(($) => $.b!.mul(2), stored),
					})
				for (const [from, to] of [[false, true], [true, false]] as const) {
					const { rows, columns, missing } = await migrate(chain(from), chain(to), ["INSERT INTO t (id, n) VALUES (1, 4), (2, 5)"])
					expect(missing).toEqual([])
					expect(rows).toEqual([{ id: 1, n: 4, a: 8, b: 9, c: 18 }, { id: 2, n: 5, a: 10, b: 11, c: 22 }])
					expect(columns).toEqual(["id", "n", "a", "b", "c"])
				}
				// Two at once: the one read, and its reader.
				const pair = (stored: boolean) => T({ n: MySQL.int, total: gen("n * 2", stored), doubled: gen(($) => $.total!.mul(2), stored) })
				const { rows } = await migrate(pair(false), pair(true), ["INSERT INTO t (id, n) VALUES (1, 4)"])
				expect(rows).toEqual([{ id: 1, n: 4, total: 8, doubled: 16 }])
			})

			it("renames a column while a generated column reading it is renamed and made VIRTUAL", async () => {
				const version = (qty: string, g: string, stored: boolean) => T({ [qty]: MySQL.int, [g]: gen(($) => $[qty]!.mul(2), stored) })
				const { rows, columns } = await migrate(version("qty", "g", true), version("quantity", "twice", false), ["INSERT INTO t (id, qty) VALUES (1, 4)"], [
					{ type: "confirm_rename", kind: "column", entity: "t.qty", to: "quantity" },
					{ type: "confirm_rename", kind: "column", entity: "t.g", to: "twice" },
				])
				expect(rows).toEqual([{ id: 1, quantity: 4, twice: 8 }])
				expect(columns).toEqual(["id", "quantity", "twice"])
			})

			it("changes generated expressions in place, one reading another, under a UNIQUE key", async () => {
				const version = (factor: number, offset: number) =>
					T({
						n: MySQL.int,
						a: MySQL.column(MySQL.int, { generated: { as: `n * ${factor}`, stored: true }, unique: true }),
						b: gen(($) => $.a!.add(offset)),
						c: MySQL.column(MySQL.int, { generated: { as: ($) => $.b!.mul(factor) }, unique: true }),
					})
				const { rows, missing } = await migrate(version(2, 1), version(3, 10), ["INSERT INTO t (id, n) VALUES (1, 4), (2, 5)"])
				expect(missing).toEqual([])
				expect(rows).toEqual([{ id: 1, n: 4, a: 12, b: 22, c: 66 }, { id: 2, n: 5, a: 15, b: 25, c: 75 }])
			})

			it("adds a dependent declared before a VIRTUAL column back only after that column is made STORED or base", async () => {
				// The database has `g` after `x`, as when the table was made; the definition now declares it first.
				const before = T({ n: MySQL.int, x: gen("n * 2"), g: gen("x + 1") })
				const stored = await migrate(before, T({ n: MySQL.int, g: gen("x + 1"), x: gen("n * 2", true) }), ["INSERT INTO t (id, n) VALUES (1, 4)"])
				expect(stored.rows).toEqual([{ id: 1, n: 4, g: 9, x: 8 }])
				// MySQL requires a generated column after the generated ones it reads.
				expect(stored.columns).toEqual(["id", "n", "x", "g"])
				const base = await migrate(before, T({ n: MySQL.int, g: gen("x + 1"), x: MySQL.column(MySQL.int, { default: 7 }) }), ["INSERT INTO t (id, n) VALUES (1, 4)"])
				expect(base.missing).toEqual([{ type: "confirm_data_loss", kind: "column", entity: "t.x" }])
				expect(base.rows).toEqual([{ id: 1, n: 4, g: 8, x: 7 }])
				expect(base.columns).toEqual(["id", "n", "g", "x"])
			})

			it("makes a STORED column base, keeping its values and its UNIQUE key, and a base column STORED", async () => {
				const stored = T({ n: MySQL.int, total: MySQL.column(MySQL.int, { generated: { as: "n * 2", stored: true }, unique: true }) })
				const base = T({ n: MySQL.int, total: MySQL.column(MySQL.int, { unique: true }) })
				const made = await migrate(stored, base, ["INSERT INTO t (id, n) VALUES (1, 4), (2, 5)"])
				expect(made.missing).toEqual([])
				expect(made.rows).toEqual([{ id: 1, n: 4, total: 8 }, { id: 2, n: 5, total: 10 }])
				const back = await migrate(base, stored, ["INSERT INTO t (id, n, total) VALUES (1, 4, 0), (2, 5, 1)"])
				expect(back.missing).toEqual([{ type: "confirm_data_loss", kind: "column", entity: "t.total" }])
				expect(back.rows).toEqual([{ id: 1, n: 4, total: 8 }, { id: 2, n: 5, total: 10 }])
			})

			it("makes a VIRTUAL column base, confirmed: it takes the default", async () => {
				const { rows, missing } = await migrate(T({ n: MySQL.int, total: gen("n * 2") }), T({ n: MySQL.int, total: MySQL.column(MySQL.int, { default: 7 }) }), ["INSERT INTO t (id, n) VALUES (1, 4)"])
				expect(missing).toEqual([{ type: "confirm_data_loss", kind: "column", entity: "t.total" }])
				expect(rows).toEqual([{ id: 1, n: 4, total: 7 }])
			})

			it("stores the NULL a nullable generated column computes", async () => {
				const Notes = MySQL.table("t", {
					columns: { id: MySQL.int, a: MySQL.nullable(MySQL.int), next: MySQL.column(MySQL.nullable(MySQL.int), { generated: { as: ($) => $.a!.add(1), stored: true } }) },
					primaryKey: ["id"],
				})
				const { rows } = await migrate(T({}), Notes, [])
				expect(rows).toEqual([])
				const db = await scratchDatabase(server, "gen")
				opened.push(db)
				for (const sql of renderMysqlSchema(await Effect.runPromise(mysqlEntitiesOf([Notes])))) await db.query(sql, [])
				const insert = MySQL.compileUnsafe(MySQL.insertInto(Notes).values([{ id: 1, a: null }, { id: 2, a: 1 }]), undefined, { dialect })
				await db.query(insert.sql, insert.parameters)
				const select = MySQL.compileUnsafe(MySQL.from(Notes).select().orderBy(["id", "asc"]), undefined, { dialect })
				expect(await Effect.runPromise(select.decodeRows(await db.query(select.sql, select.parameters)))).toEqual([{ id: 1, a: null, next: null }, { id: 2, a: 1, next: 2 }])
			})
		})

		// MariaDB 11.4 sizes an integer literal a digit short where a union branch is a
		// derived table, and cut it down to fit the DECIMAL beside it: 97 came back 9.9999.
		it("keeps an integer literal whole beside a narrower DECIMAL in a union", async () => {
			const db = await scratchDatabase(server, "ddl")
			opened.push(db)
			const Slots = MySQL.table("slots", { columns: { id: MySQL.int }, primaryKey: ["id"] })
			for (const sql of renderMysqlSchema(await Effect.runPromise(mysqlEntitiesOf([Slots])))) await db.query(sql, [])
			await db.query("INSERT INTO `slots` (`id`) VALUES (1), (2)", [])
			const whole = MySQL.from(Slots).select(($) => ({ id: $.id, share: MySQL.lit(97) }))
			const fraction = MySQL.from(Slots).select(($) => ({ id: $.id, share: MySQL.lit(1).div($.id.mul(8)) }))
			const compiled = MySQL.compileUnionUnsafe(MySQL.unionAll(whole, fraction).orderBy(["share", "desc"], ["id", "asc"]), {}, { dialect })
			const rows = await Effect.runPromise(compiled.decodeRows(await db.query(compiled.sql, compiled.parameters)))
			expect(rows, compiled.sql).toEqual([
				{ id: 1, share: 97 },
				{ id: 2, share: 97 },
				{ id: 1, share: 0.125 },
				{ id: 2, share: 0.0625 },
			])
		})
	})
}
