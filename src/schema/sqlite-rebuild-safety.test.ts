import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { Miniflare } from "miniflare"
import { expect, it } from "vitest"
import * as SQLite from "../sqlite"
import { diffSqliteSchemas, renderSqliteOp, sqliteEntitiesOf } from "../schema"

const rebuild = () => {
	const before = SQLite.table("Parent", { columns: { id: SQLite.text, value: SQLite.text }, primaryKey: ["id"] })
	const after = SQLite.table("Parent", { columns: { id: SQLite.text, value: SQLite.column(SQLite.text, { default: "new" }) }, primaryKey: ["id"] })
	return diffSqliteSchemas(Effect.runSync(sqliteEntitiesOf([before])), Effect.runSync(sqliteEntitiesOf([after]))).ops.flatMap(renderSqliteOp)
}
const seed = (action: string) => [
	"CREATE TABLE Parent (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
	`CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES pArEnT(id) ON DELETE ${action})`,
	"INSERT INTO Parent VALUES ('p', 'old')",
	"INSERT INTO child VALUES ('c', 'p')",
]
const inTransaction = (db: DatabaseSync, statements: ReadonlyArray<string>) => {
	db.exec("BEGIN")
	try {
		for (const sql of statements) db.exec(sql)
		db.exec("COMMIT")
	} catch (error) {
		db.exec("ROLLBACK")
		throw error
	}
}

it.each(["CASCADE", "SET NULL", "NO ACTION"])("refuses a referenced parent's rebuild before ON DELETE %s can affect child rows", (action) => {
	const db = new DatabaseSync(":memory:")
	try {
		db.exec("PRAGMA foreign_keys=ON; PRAGMA ignore_check_constraints=ON")
		for (const sql of seed(action)) db.exec(sql)
		expect(() => inTransaction(db, rebuild())).toThrow(/foreign_key_references_prevent_rebuild/)
		expect(db.prepare("SELECT * FROM Parent").all()).toEqual([{ id: "p", value: "old" }])
		expect(db.prepare("SELECT * FROM child").all()).toEqual([{ id: "c", parent_id: "p" }])
		expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()).toEqual([{ name: "Parent" }, { name: "child" }])
	} finally {
		db.close()
	}
})

it("fails closed on a pre-existing guard table without reusing or dropping it", () => {
	const db = new DatabaseSync(":memory:")
	try {
		db.exec("CREATE TABLE Parent (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO Parent VALUES ('p', 'old')")
		db.exec("CREATE TABLE __effect_orm_rebuild_guard_Parent (value TEXT); INSERT INTO __effect_orm_rebuild_guard_Parent VALUES ('keep')")
		expect(() => inTransaction(db, rebuild())).toThrow(/already exists/)
		expect(db.prepare("SELECT * FROM __effect_orm_rebuild_guard_Parent").all()).toEqual([{ value: "keep" }])
		expect(db.prepare("SELECT * FROM Parent").all()).toEqual([{ id: "p", value: "old" }])
	} finally {
		db.close()
	}
})

it("checks internal-looking user table names and case-sensitive LIKE settings too", () => {
	const db = new DatabaseSync(":memory:")
	try {
		db.exec("PRAGMA foreign_keys=ON; PRAGMA case_sensitive_like=ON")
		db.exec("CREATE TABLE Parent (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO Parent VALUES ('p', 'old')")
		db.exec("CREATE TABLE _cf_user_child (parent_id TEXT references Parent(id) ON DELETE CASCADE); INSERT INTO _cf_user_child VALUES ('p')")
		expect(() => inTransaction(db, rebuild())).toThrow(/foreign_key_references_prevent_rebuild/)
		expect(db.prepare("SELECT * FROM _cf_user_child").all()).toEqual([{ parent_id: "p" }])
	} finally {
		db.close()
	}
})

it.each(["CASCADE", "SET NULL"])("refuses a real D1 batch with ON DELETE %s, rolls back the guard, and permits a later safe rebuild", async (action) => {
	const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('') } }", compatibilityDate: "2026-07-01", d1Databases: ["DB"] })
	try {
		const db = await mf.getD1Database("DB")
		await db.batch(seed(action).map((sql) => db.prepare(sql)))
		expect((await db.prepare("SELECT name FROM sqlite_schema WHERE name='_cf_METADATA'").all()).results).toEqual([{ name: "_cf_METADATA" }])
		await db.prepare("PRAGMA ignore_check_constraints=ON").run()
		await expect(db.batch(rebuild().map((sql) => db.prepare(sql)))).rejects.toThrow(/foreign_key_references_prevent_rebuild/)
		expect((await db.prepare("SELECT * FROM Parent").all()).results).toEqual([{ id: "p", value: "old" }])
		expect((await db.prepare("SELECT * FROM child").all()).results).toEqual([{ id: "c", parent_id: "p" }])
		expect((await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE '__effect_orm_%'").all()).results).toEqual([])
		await db.prepare("DROP TABLE child").run()
		await db.batch(rebuild().map((sql) => db.prepare(sql)))
		expect((await db.prepare("SELECT * FROM Parent").all()).results).toEqual([{ id: "p", value: "old" }])
		expect((await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE '__effect_orm_%'").all()).results).toEqual([])
		expect((await db.prepare("SELECT dflt_value FROM pragma_table_info('Parent') WHERE name='value'").all()).results).toEqual([{ dflt_value: "'new'" }])
	} finally {
		await mf.dispose()
	}
}, 30_000)
