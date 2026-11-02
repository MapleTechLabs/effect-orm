import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { fromDrizzleSqliteSnapshot } from "./sqlite-drizzle"

const fixture = join(import.meta.dirname, "..", "kit", "__fixtures__", "drizzle-sqlite")
const snapshot = () => {
	const [folder] = readdirSync(fixture).filter((name) => /^\d{14}_/.test(name))
	return JSON.parse(readFileSync(join(fixture, folder!, "snapshot.json"), "utf8")) as { ddl: Array<Record<string, unknown>> }
}

it("reads a drizzle-kit 1.0 primary key column as NOT NULL, and keeps UNIQUE constraints and index keys", () => {
	const { entities, unsupported } = fromDrizzleSqliteSnapshot(snapshot())
	expect(unsupported).toEqual([])
	expect(entities).toContainEqual(expect.objectContaining({ kind: "column", table: "short_link", name: "id", notNull: true }))
	expect(entities).toContainEqual({ kind: "unique", table: "membership", name: "membership_email_unique", columns: ["email"] })
	expect(entities).toContainEqual({ kind: "table", name: "membership", primaryKey: { columns: ["org_id", "user_id"] } })
	expect(entities).toContainEqual({ kind: "index", table: "membership", name: "membership_user_role", unique: false, columns: ['"user_id"', '"role"'] })
})

it("reports what the entity model cannot hold", () => {
	const json = snapshot()
	json.ddl.push(
		{ entityType: "fks", table: "membership", name: "membership_org_fk" },
		{ entityType: "columns", table: "membership", name: "n", type: "integer", notNull: true, autoincrement: true, default: null, generated: null },
	)
	expect(fromDrizzleSqliteSnapshot(json).unsupported).toEqual(["fks membership.membership_org_fk", "columns membership.n: AUTOINCREMENT"])
	expect(fromDrizzleSqliteSnapshot({ ...json, dialect: "postgresql" }).unsupported).toContain("dialect postgresql: only SQLite snapshots convert here")
})
