import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { expect, it } from "vitest"
import * as Db from "../database"
import { renderSqliteSchema, sqliteEntitiesOf } from "../schema"
import * as SQLite from "../sqlite"

// drizzle-kit 0.31.11 (drizzle-orm 0.45.4) `generate` output for the same table.
const drizzleShortLink = `CREATE TABLE \`short_link\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`code\` text NOT NULL,
	\`target_url\` text NOT NULL,
	\`target_hash\` text NOT NULL,
	\`org_id\` text,
	\`created_by\` text,
	\`subject_type\` text NOT NULL,
	\`subject_id\` text NOT NULL,
	\`purpose\` text NOT NULL,
	\`prospect_id\` text,
	\`click_count\` integer NOT NULL,
	\`first_accessed_at\` text,
	\`last_accessed_at\` text,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`short_link_code\` ON \`short_link\` (\`code\`);--> statement-breakpoint
CREATE INDEX \`short_link_org\` ON \`short_link\` (\`org_id\`);`

const named = <T extends Parameters<typeof SQLite.column>[0]>(type: T, name: string) => SQLite.column(type, { name })
const optionalText = (name: string) => named(SQLite.nullable(SQLite.text), name)

const ShortLink = SQLite.table("short_link", {
	columns: {
		id: SQLite.text,
		code: SQLite.text,
		targetUrl: named(SQLite.text, "target_url"),
		targetHash: named(SQLite.text, "target_hash"),
		orgId: optionalText("org_id"),
		createdBy: optionalText("created_by"),
		subjectType: named(SQLite.text, "subject_type"),
		subjectId: named(SQLite.text, "subject_id"),
		purpose: SQLite.text,
		prospectId: optionalText("prospect_id"),
		clickCount: named(SQLite.integer, "click_count"),
		firstAccessedAt: optionalText("first_accessed_at"),
		lastAccessedAt: optionalText("last_accessed_at"),
		createdAt: named(SQLite.text, "created_at"),
		updatedAt: named(SQLite.text, "updated_at"),
	},
	primaryKey: ["id"],
	indexes: [SQLite.uniqueIndex("short_link_code", ["code"]), SQLite.index("short_link_org", ["orgId"])],
	tenantColumn: "orgId",
})

const drizzleStatements = (sql: string) => sql.split("--> statement-breakpoint").map((s) => s.trim()).filter((s) => s.length > 0)

/** What SQLite reports about every table and index after running `statements` on an empty database. */
const shapeAfter = (statements: ReadonlyArray<string>) =>
	Effect.runPromise(Effect.gen(function* () {
		const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: SQLite.sqliteDialect })
		for (const sql of statements) yield* db.execute({ sql })
		const tables = yield* db.query({ sql: "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name" })
		const shape: Record<string, unknown> = {}
		for (const { name } of tables as ReadonlyArray<{ name: string }>) {
			const columns = yield* db.query({ sql: `SELECT * FROM pragma_table_info('${name}')` })
			const list = yield* db.query({ sql: `SELECT name, "unique", origin, partial FROM pragma_index_list('${name}') ORDER BY name` })
			const indexes = []
			for (const index of list as ReadonlyArray<{ name: string }>) {
				const keys = yield* db.query({ sql: `SELECT seqno, cid, name, "desc", coll, "key" FROM pragma_index_xinfo('${index.name}')` })
				indexes.push({ ...index, keys })
			}
			shape[name] = { columns, indexes }
		}
		return shape
	}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))))

const ddlOf = (tables: Parameters<typeof sqliteEntitiesOf>[0]) => Effect.runPromise(Effect.map(sqliteEntitiesOf(tables), renderSqliteSchema))

it("creates short_link exactly as drizzle-kit's SQL does, by PRAGMA table_info and index_list", async () => {
	const ours = await shapeAfter(await ddlOf([ShortLink]))
	expect(ours).toEqual(await shapeAfter(drizzleStatements(drizzleShortLink)))
	expect(Object.keys(ours)).toEqual(["short_link"])
})
