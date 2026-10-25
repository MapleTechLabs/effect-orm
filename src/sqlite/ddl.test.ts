import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Effect, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { expect, it } from "vitest"
import * as Db from "../database"
import { canonicalJson, renderSqliteSchema, SqliteSchemaEntity, sqliteEntitiesOf } from "../schema"
import * as SQLite from "../sqlite"
import { shapeAfter } from "./shape.test-support"

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

const ddlOf = (tables: Parameters<typeof sqliteEntitiesOf>[0]) => Effect.runPromise(Effect.map(sqliteEntitiesOf(tables), renderSqliteSchema))

it("creates short_link exactly as drizzle-kit's SQL does, by PRAGMA table_info and index_list", async () => {
	const ours = await shapeAfter(await ddlOf([ShortLink]))
	expect(ours).toEqual(await shapeAfter(drizzleStatements(drizzleShortLink)))
	expect(Object.keys(ours)).toEqual(["short_link"])
})

// drizzle-kit 1.0.0-rc.5 for: composite primaryKey, .default(...) literals, sql`(CURRENT_TIMESTAMP)`,
// text("email").unique(), real, blob, numeric, a two-column index. drizzle-kit 1.0 writes
// .unique() inline, as a UNIQUE constraint; 0.31 wrote a separate unique index.
const drizzleMembership = `CREATE TABLE \`membership\` (
	\`org_id\` text NOT NULL,
	\`user_id\` text NOT NULL,
	\`role\` text DEFAULT 'member' NOT NULL,
	\`weight\` real DEFAULT 1.5 NOT NULL,
	\`active\` integer DEFAULT true NOT NULL,
	\`avatar\` blob,
	\`amount\` numeric,
	\`email\` text UNIQUE,
	\`created_at\` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT \`membership_pk\` PRIMARY KEY(\`org_id\`, \`user_id\`)
);
--> statement-breakpoint
CREATE INDEX \`membership_user_role\` ON \`membership\` (\`user_id\`,\`role\`);`

// drizzle-kit 1.0.0-rc.5 for short_link. It drops NOT NULL from a primary key column even when
// the column says .notNull(), so SQLite accepts a NULL id. We keep NOT NULL.
const drizzleV1ShortLinkTable = drizzleShortLink
	.replace("`id` text PRIMARY KEY NOT NULL", "`id` text PRIMARY KEY")
	.split("--> statement-breakpoint")[0]!

const Membership = SQLite.table("membership", {
	columns: {
		orgId: named(SQLite.text, "org_id"),
		userId: named(SQLite.text, "user_id"),
		role: SQLite.column(SQLite.text, { default: "member" }),
		weight: SQLite.column(SQLite.real, { default: 1.5 }),
		active: SQLite.column(SQLite.boolean, { default: true }),
		avatar: SQLite.nullable(SQLite.blob),
		amount: SQLite.nullable(SQLite.custom("numeric", Schema.Finite)),
		email: SQLite.column(SQLite.nullable(SQLite.text), { unique: true }),
		createdAt: SQLite.column(SQLite.text, { name: "created_at", defaultExpr: "(CURRENT_TIMESTAMP)" }),
	},
	primaryKey: ["orgId", "userId"],
	indexes: [SQLite.index("membership_user_role", ["userId", "role"])],
	tenantColumn: "orgId",
})

it("matches drizzle-kit 1.0 for short_link, except that the primary key column stays NOT NULL", async () => {
	const ours = (await shapeAfter(await ddlOf([ShortLink]))) as { short_link: { columns: Array<{ name: string; notnull: number }> } }
	const theirs = (await shapeAfter([drizzleV1ShortLinkTable, ...drizzleStatements(drizzleShortLink).slice(1)])) as typeof ours
	expect(ours.short_link.columns.find((c) => c.name === "id")?.notnull).toBe(1)
	expect(theirs.short_link.columns.find((c) => c.name === "id")?.notnull).toBe(0)
	const withoutKeyNull = (shape: typeof ours) => ({ ...shape, short_link: { ...shape.short_link, columns: shape.short_link.columns.map((c) => (c.name === "id" ? { ...c, notnull: 1 } : c)) } })
	expect(withoutKeyNull(ours)).toEqual(withoutKeyNull(theirs))
})

it("creates composite keys, defaults, unique columns and every storage class as drizzle-kit 1.0 does", async () => {
	expect(await shapeAfter(await ddlOf([Membership]))).toEqual(await shapeAfter(drizzleStatements(drizzleMembership)))
})

it("lets an insert leave out defaulted columns, and SQLite fills them", async () => {
	const rows = await Effect.runPromise(Effect.gen(function* () {
		const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: SQLite.sqliteDialect })
		for (const sql of yield* Effect.map(sqliteEntitiesOf([Membership]), renderSqliteSchema)) yield* db.execute({ sql })
		yield* db.run(SQLite.insertInto(Membership).values({ orgId: "o", userId: "u", avatar: null, amount: null, email: null }))
		return yield* db.run(SQLite.from(Membership).select("role", "weight", "active"))
	}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))))
	expect(rows).toEqual([{ role: "member", weight: 1.5, active: true }])
})

it("renders DSL defaults and expression index keys that SQLite accepts", async () => {
	const Codes = SQLite.table("codes", {
		columns: {
			id: SQLite.integer,
			code: SQLite.text,
			hits: SQLite.column(SQLite.integer, { defaultExpr: () => SQLite.lit(1) }),
		},
		primaryKey: ["id"],
		indexes: [SQLite.uniqueIndex("codes_code_lower", ($) => [SQLite.lower($.code)])],
	})
	const statements = await ddlOf([Codes])
	expect(statements).toEqual([
		'CREATE TABLE IF NOT EXISTS "codes" (\n\t"id" integer PRIMARY KEY NOT NULL,\n\t"code" text NOT NULL,\n\t"hits" integer NOT NULL DEFAULT (1)\n)',
		'CREATE UNIQUE INDEX IF NOT EXISTS "codes_code_lower" ON "codes" (lower("code"))',
	])
	const shape = (await shapeAfter(statements)) as { codes: { indexes: Array<{ keys: Array<{ cid: number }> }> } }
	expect(shape.codes.indexes[0]?.keys[0]?.cid).toBe(-2)
})

it("keeps the query-only forms free of DDL", async () => {
	const External = SQLite.table("ext", { external: true, columns: { id: SQLite.integer, orgId: named(SQLite.text, "org_id") }, tenantColumn: "orgId" })
	const Legacy = SQLite.table("legacy", { id: SQLite.integer, note: SQLite.text }, { defaults: ["note"] })
	expect("ddl" in External || "ddl" in Legacy).toBe(false)
	expect(SQLite.compileUnsafe(SQLite.from(External).select("orgId").where(($) => [$.orgId.eq("o")])).sql).toContain('"ext"."org_id" AS "orgId"')
	const exit = await Effect.runPromiseExit(sqliteEntitiesOf([External as never]))
	expect(exit._tag).toBe("Failure")
})

it("records every definition problem, and sqliteEntitiesOf fails with all of them", async () => {
	const Bad = SQLite.table("sqlite_bad", {
		columns: {
			id: SQLite.nullable(SQLite.text),
			both: SQLite.column(SQLite.text, { default: "a", defaultExpr: "('b')" }),
		},
		primaryKey: ["id", "missing" as "id"],
		indexes: [SQLite.index("bad_none", ["nope" as "id"])],
	})
	const Clash = SQLite.table("clash", { columns: { id: SQLite.text }, indexes: [SQLite.index("short_link", ["id"])] })
	const exit = await Effect.runPromiseExit(sqliteEntitiesOf([Bad, Clash, ShortLink]))
	if (exit._tag !== "Failure") throw new Error("a broken schema was accepted")
	const messages = JSON.stringify(exit.cause)
	for (const expected of ["starts with sqlite_", "cannot be nullable", "missing is not a column", "one of default, defaultExpr", "nope is not a column", "one namespace"]) {
		expect(messages).toContain(expected)
	}
})

it("refuses definitions SQLite would only reject when it runs the DDL", async () => {
	// Each of these renders, then fails in SQLite: duplicate column name, a repeated key column,
	// "default value of column is not constant", or an insert hitting NOT NULL.
	const Bad = SQLite.table("bad_ddl", {
		columns: {
			id: SQLite.text,
			Id: SQLite.text,
			a: SQLite.column(SQLite.text, { name: "b" }),
			b: SQLite.text,
			copy: SQLite.column(SQLite.text, { defaultExpr: ($) => $.b }),
			maybe: SQLite.column(SQLite.text, { default: undefined as never }),
		},
		primaryKey: ["id", "id"],
		indexes: [SQLite.index("bad_ddl_twice", ["b", "b"])],
	})
	const exit = await Effect.runPromiseExit(sqliteEntitiesOf([Bad]))
	if (exit._tag !== "Failure") throw new Error("a broken schema was accepted")
	const messages = JSON.stringify(exit.cause)
	for (const expected of [
		"Id has the same SQL name as id",
		"b has the same SQL name as a",
		"id is listed more than once",
		"b is listed more than once",
		"defaultExpr reads b",
		"default is undefined",
	]) {
		expect(messages).toContain(expected)
	}
})

it("keeps entities as plain data that survive a JSON round trip, sorted the same every time", async () => {
	const entities = await Effect.runPromise(sqliteEntitiesOf([Membership, ShortLink]))
	const again = await Effect.runPromise(sqliteEntitiesOf([ShortLink, Membership]))
	expect(canonicalJson(again)).toBe(canonicalJson(entities))
	const decoded = Schema.decodeUnknownSync(Schema.Array(SqliteSchemaEntity))(JSON.parse(canonicalJson(entities)))
	expect(renderSqliteSchema(decoded)).toEqual(renderSqliteSchema(entities))
	expect(entities.map((e) => e.kind).filter((k, i, all) => all.indexOf(k) === i)).toEqual(["table", "column", "index", "unique"])
})
