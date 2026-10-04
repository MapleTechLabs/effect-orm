import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as CH from "../ch/index"
import * as PG from "../postgres"
import * as S from "../schema"

const Dashboards = PG.table("dashboards", {
	columns: {
		org_id: PG.text,
		id: PG.text,
		name: PG.column(PG.text, { default: "Untitled" }),
		tags: PG.column(PG.array(PG.text), { default: [] }),
		layout: PG.column(PG.jsonb(), { default: {} }),
		widgets: PG.int4,
		archived: PG.column(PG.bool, { default: false }),
		created_at: PG.column(PG.timestamptz, { defaultExpr: "now()" }),
		archived_at: PG.nullable(PG.timestamptz),
	},
	primaryKey: { columns: ["org_id", "id"], name: "dashboards_org_id_id_pk" },
	indexes: [
		PG.index("dashboards_org_idx", ["org_id"]),
		PG.index("dashboards_live_idx", ["org_id", "created_at"], { where: ($) => $.archived_at.isNull() }),
	],
	tenantColumn: "org_id",
})

const Shares = PG.table("dashboard_shares", {
	columns: {
		org_id: PG.text,
		id: PG.text,
		dashboard_id: PG.text,
		widget_id: PG.nullable(PG.text),
		embedding: PG.nullable(PG.array(PG.float4)),
		revoked_at: PG.nullable(PG.timestamptz),
	},
	primaryKey: ["org_id", "id"],
	indexes: [
		PG.uniqueIndex("dashboard_shares_live_unq", ($) => [$.org_id, $.dashboard_id, CH.coalesce($.widget_id, CH.lit(""))], {
			where: "revoked_at is null",
		}),
	],
	foreignKeys: [
		PG.foreignKey({
			columns: ["org_id", "dashboard_id"],
			references: Dashboards,
			foreignColumns: ["org_id", "id"],
			onDelete: "cascade",
			name: "dashboard_shares_dashboard_fk",
		}),
	],
})

describe("PG.table", () => {
	it("is a Table the query builder accepts, with defaults optional on insert", () => {
		const { sql } = PG.compileUnsafe(CH.from(Dashboards).select("name").where(($) => [$.org_id.eq("o")]), {})
		expect(sql).toContain('FROM "dashboards"')
		const insert = PG.compileUnsafe(CH.insertInto(Dashboards).values({ org_id: "o", id: "d", widgets: 0 }), {})
		expect(insert.sql).toContain('INSERT INTO "dashboards"')
		expect(Dashboards.defaults).toEqual(["name", "tags", "layout", "archived", "created_at"])
	})

	it("normalizes types and nullability into entities", () => {
		const columns = Object.fromEntries(Shares.ddl.columns.map((c) => [c.name, [c.type, c.notNull]]))
		expect(columns).toEqual({
			org_id: ["text", true],
			id: ["text", true],
			dashboard_id: ["text", true],
			widget_id: ["text", false],
			embedding: ["real[]", false],
			revoked_at: ["timestamp with time zone", false],
		})
		expect(Shares.ddl.table.primaryKey).toEqual({ name: "dashboard_shares_pkey", columns: ["org_id", "id"] })
	})

	it("renders its DDL", () => {
		expect(S.renderPgSchema(S.pgEntitiesOf([Dashboards, Shares]))).toEqual([
			[
				'CREATE TABLE IF NOT EXISTS "dashboard_shares" (',
				'\t"org_id" text NOT NULL,',
				'\t"id" text NOT NULL,',
				'\t"dashboard_id" text NOT NULL,',
				'\t"widget_id" text,',
				'\t"embedding" real[],',
				'\t"revoked_at" timestamp with time zone,',
				'\tCONSTRAINT "dashboard_shares_pkey" PRIMARY KEY ("org_id", "id")',
				")",
			].join("\n"),
			[
				'CREATE TABLE IF NOT EXISTS "dashboards" (',
				'\t"org_id" text NOT NULL,',
				'\t"id" text NOT NULL,',
				"\t\"name\" text NOT NULL DEFAULT 'Untitled',",
				"\t\"tags\" text[] NOT NULL DEFAULT '{}',",
				"\t\"layout\" jsonb NOT NULL DEFAULT '{}',",
				'\t"widgets" integer NOT NULL,',
				'\t"archived" boolean NOT NULL DEFAULT false,',
				'\t"created_at" timestamp with time zone NOT NULL DEFAULT now(),',
				'\t"archived_at" timestamp with time zone,',
				'\tCONSTRAINT "dashboards_org_id_id_pk" PRIMARY KEY ("org_id", "id")',
				")",
			].join("\n"),
			`CREATE UNIQUE INDEX IF NOT EXISTS "dashboard_shares_live_unq" ON "dashboard_shares" USING btree ("org_id", "dashboard_id", coalesce("widget_id", '')) WHERE revoked_at is null`,
			'CREATE INDEX IF NOT EXISTS "dashboards_live_idx" ON "dashboards" USING btree ("org_id", "created_at") WHERE "archived_at" IS NULL',
			'CREATE INDEX IF NOT EXISTS "dashboards_org_idx" ON "dashboards" USING btree ("org_id")',
			'ALTER TABLE "dashboard_shares" ADD CONSTRAINT "dashboard_shares_dashboard_fk" FOREIGN KEY ("org_id", "dashboard_id") REFERENCES "dashboards" ("org_id", "id") ON DELETE CASCADE',
		])
	})

	it("names a foreign key as drizzle-kit does when no name is given", () => {
		const Checks = PG.table("checks", {
			columns: { id: PG.text, target_id: PG.text },
			foreignKeys: [PG.foreignKey({ columns: ["target_id"], references: "targets", foreignColumns: ["id"] })],
		})
		expect(Checks.ddl.foreignKeys[0]?.name).toBe("checks_target_id_targets_id_fk")
	})

	it("shortens a default foreign key name past 63 characters with drizzle-kit's hash", () => {
		const long = PG.table("organization_membership_invitations", {
			columns: { organization_id: PG.text, invited_by_user_id: PG.text },
			foreignKeys: [
				PG.foreignKey({ columns: ["organization_id", "invited_by_user_id"], references: "organization_members", foreignColumns: ["organization_id", "user_id"] }),
			],
		})
		const name = long.ddl.foreignKeys[0]!.name
		expect(name).toMatch(/^organization_membership_invitations_[0-9A-Za-z]{12}_fk$/)
		expect(name.length).toBeLessThanOrEqual(63)
		// Deterministic, so a snapshot and the next generate agree.
		expect(PG.defaultForeignKeyName("organization_membership_invitations", ["organization_id", "invited_by_user_id"], "organization_members", ["organization_id", "user_id"])).toBe(name)
		expect(PG.defaultForeignKeyName("t".repeat(60), ["a"], "u", ["b"])).toMatch(/^[0-9A-Za-z]{12}_fk$/)
	})

	it("rejects definitions Postgres would not take as written", () => {
		expect(() => PG.table("t", { columns: { a: PG.nullable(PG.text) }, primaryKey: ["a"] })).toThrow(/cannot be nullable/)
		expect(() => PG.table("t".repeat(64), { columns: { a: PG.text } })).toThrow(/longer than 63/)
		expect(() =>
			PG.table("t", { columns: { a: PG.text }, foreignKeys: [PG.foreignKey({ columns: ["a"], references: "u", foreignColumns: ["x", "y"] })] }),
		).toThrow(/same, non-zero, length/)
	})

	it("validates a schema as a whole", () => {
		const Other = PG.table("other", {
			columns: { a: PG.text },
			indexes: [PG.index("dashboards_org_idx", ["a"])],
		})
		expect(() => S.pgEntitiesOf([Dashboards, Other])).toThrow(/one namespace/)
		expect(() => S.pgEntitiesOf([Shares])).toThrow(/not a table in this schema/)
		expect(() => S.entitiesOf([Shares])).toThrow(/Postgres table/)
	})
})

describe("canonicalPgType", () => {
	it("spells types the way format_type does", () => {
		expect(S.canonicalPgType("int4")).toBe("integer")
		expect(S.canonicalPgType("float8")).toBe("double precision")
		expect(S.canonicalPgType("timestamptz[]")).toBe("timestamp with time zone[]")
		expect(S.canonicalPgType("timestamptz(3)")).toBe("timestamp(3) with time zone")
		expect(S.canonicalPgType("varchar(20)")).toBe("character varying(20)")
		expect(S.canonicalPgType("jsonb")).toBe("jsonb")
	})
})

describe("diffPgSchemas", () => {
	const v1 = S.pgEntitiesOf([Dashboards])
	const v2 = S.pgEntitiesOf([
		PG.table("dashboards", {
			columns: {
				org_id: PG.text,
				id: PG.text,
				name: PG.column(PG.text, { default: "New dashboard" }),
				widgets: PG.int8,
				archived: PG.bool,
				created_at: PG.column(PG.timestamptz, { defaultExpr: "now()" }),
				archived_at: PG.nullable(PG.timestamptz),
				owner: PG.nullable(PG.text),
			},
			primaryKey: ["org_id", "id"],
			indexes: [PG.index("dashboards_org_idx", ["org_id", "owner"])],
		}),
	])

	it("alters columns, keys and indexes in place, and asks before dropping", () => {
		const first = S.diffPgSchemas(v1, v2)
		expect(first.missingHints).toEqual([
			{ type: "confirm_data_loss", kind: "column", entity: "dashboards.tags" },
			{ type: "confirm_data_loss", kind: "column", entity: "dashboards.layout" },
		])
		const { ops, unsupported } = S.diffPgSchemas(v1, v2, first.missingHints)
		expect(unsupported).toEqual([])
		expect(ops.map((op) => op.op)).toEqual([
			"drop_index",
			"drop_index",
			"drop_column",
			"drop_column",
			"add_column",
			"alter_column",
			"alter_column",
			"alter_column",
			"set_primary_key",
			"create_index",
		])
		expect(ops.flatMap((op) => S.renderPgOp(op))).toEqual([
			'DROP INDEX IF EXISTS "dashboards_org_idx"',
			'DROP INDEX IF EXISTS "dashboards_live_idx"',
			'ALTER TABLE "dashboards" DROP COLUMN IF EXISTS "tags"',
			'ALTER TABLE "dashboards" DROP COLUMN IF EXISTS "layout"',
			'ALTER TABLE "dashboards" ADD COLUMN IF NOT EXISTS "owner" text',
			`ALTER TABLE "dashboards" ALTER COLUMN "name" SET DEFAULT 'New dashboard'`,
			'ALTER TABLE "dashboards" ALTER COLUMN "widgets" SET DATA TYPE bigint USING "widgets"::bigint',
			'ALTER TABLE "dashboards" ALTER COLUMN "archived" DROP DEFAULT',
			'ALTER TABLE "dashboards" DROP CONSTRAINT IF EXISTS "dashboards_org_id_id_pk"',
			'ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_pkey" PRIMARY KEY ("org_id", "id")',
			'CREATE INDEX IF NOT EXISTS "dashboards_org_idx" ON "dashboards" USING btree ("org_id", "owner")',
		])
		expect(ops.map(S.labelOfPg)).toContain("rewrite")
	})

	it("drops foreign keys before the tables they point at, and nothing for an unchanged schema", () => {
		const both = S.pgEntitiesOf([Dashboards, Shares])
		expect(S.diffPgSchemas(both, both).ops).toEqual([])
		const hint = { type: "confirm_data_loss", kind: "table", entity: "dashboards" } as const
		const hint2 = { type: "confirm_data_loss", kind: "table", entity: "dashboard_shares" } as const
		const { ops } = S.diffPgSchemas(both, [], [hint, hint2])
		expect(ops.map((op) => op.op)).toEqual(["drop_foreign_key", "drop_table", "drop_table"])
	})

	it("snapshots carry their dialect and hash entities alone", async () => {
		const snapshot = await Effect.runPromise(S.makeSnapshot(v1, [S.ORIGIN_ID], "postgres"))
		expect(snapshot.dialect).toBe("postgres")
		const again = await Effect.runPromise(S.makeSnapshot([...v1].reverse(), [S.ORIGIN_ID], "postgres"))
		expect(again.id).toBe(snapshot.id)
	})
})

describe("fromDrizzleSnapshot", () => {
	const drizzle = {
		version: "8",
		dialect: "postgres",
		id: "x",
		prevIds: [],
		renames: [],
		ddl: [
			{ isRlsEnabled: false, name: "dashboard_shares", entityType: "tables", schema: "public" },
			{ type: "text", typeSchema: null, notNull: true, dimensions: 0, default: null, generated: null, identity: null, name: "org_id", entityType: "columns", schema: "public", table: "dashboard_shares" },
			{ type: "real", typeSchema: null, notNull: false, dimensions: 1, default: null, generated: null, identity: null, name: "embedding", entityType: "columns", schema: "public", table: "dashboard_shares" },
			{ type: "text", typeSchema: null, notNull: true, dimensions: 0, default: "'open'", generated: null, identity: null, name: "status", entityType: "columns", schema: "public", table: "dashboard_shares" },
			{
				nameExplicit: true,
				columns: [
					{ value: "org_id", isExpression: false, asc: true, nullsFirst: false, opclass: null },
					{ value: "coalesce(widget_id, '')", isExpression: true, asc: true, nullsFirst: false, opclass: null },
				],
				isUnique: true,
				where: "revoked_at is null",
				with: "",
				method: "btree",
				concurrently: false,
				name: "dashboard_shares_live_unq",
				entityType: "indexes",
				schema: "public",
				table: "dashboard_shares",
			},
			{ nameExplicit: true, columns: ["org_id"], schemaTo: "public", tableTo: "dashboards", columnsTo: ["org_id"], onUpdate: "NO ACTION", onDelete: "CASCADE", name: "fk", entityType: "fks", schema: "public", table: "dashboard_shares" },
			{ columns: ["org_id"], nameExplicit: false, name: "dashboard_shares_org_id_pk", entityType: "pks", schema: "public", table: "dashboard_shares" },
		],
	}

	it("converts tables, columns, keys and indexes", () => {
		const { entities, unsupported } = S.fromDrizzleSnapshot(drizzle)
		expect(unsupported).toEqual([])
		expect(entities).toContainEqual({ kind: "table", name: "dashboard_shares", primaryKey: { name: "dashboard_shares_org_id_pk", columns: ["org_id"] } })
		expect(entities).toContainEqual({ kind: "column", table: "dashboard_shares", name: "embedding", position: 1, type: "real[]", notNull: false, default: null, identity: null })
		expect(entities).toContainEqual({ kind: "column", table: "dashboard_shares", name: "status", position: 2, type: "text", notNull: true, default: "'open'", identity: null })
		expect(entities).toContainEqual({
			kind: "index",
			table: "dashboard_shares",
			name: "dashboard_shares_live_unq",
			unique: true,
			method: "btree",
			columns: ['"org_id"', "coalesce(widget_id, '')"],
			where: "revoked_at is null",
		})
		expect(entities.find((e) => e.kind === "foreign_key")).toMatchObject({ foreignTable: "dashboards", onDelete: "CASCADE" })
	})

	it("reports what it cannot model instead of dropping it", () => {
		const { unsupported } = S.fromDrizzleSnapshot({
			...drizzle,
			ddl: [...drizzle.ddl, { name: "mood", values: ["a"], entityType: "enums", schema: "public" }],
		})
		expect(unsupported).toEqual(["enums mood"])
	})
})
