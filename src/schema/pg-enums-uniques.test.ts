import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as PG from "../postgres"
import { parsePgArrayLiteral } from "../pg/types"
import * as S from "../schema"

const entitiesOf = (...objects: ReadonlyArray<S.SchemaObject>) => Effect.runSync(S.pgEntitiesOf(objects))
const failureOf = (...objects: ReadonlyArray<S.SchemaObject>) => Effect.runSync(Effect.flip(S.pgEntitiesOf(objects))).message

const ChannelType = PG.enumType("channel_type", ["public", "private", "direct"])

const channels = (type: S.SchemaObject & PG.PgEnum = ChannelType) =>
	PG.table("channels", {
		columns: {
			id: PG.text,
			org_id: PG.text,
			slug: PG.column(PG.text, { unique: true }),
			type: PG.column(type, { default: "public" }),
			allowed: PG.nullable(PG.array(type)),
		},
		primaryKey: ["id"],
		uniqueConstraints: [PG.unique("channels_org_slug_unique", ["org_id", "slug"], { nullsNotDistinct: true })],
		indexes: [PG.index("channels_public_idx", ["org_id"], { where: ($) => $.type.eq("public") })],
	})

describe("PG.enumType", () => {
	it("is a column type and a schema object", () => {
		expect(S.isSchemaObject(ChannelType)).toBe(true)
		expect(S.dialectOfObject(ChannelType)).toBe("postgres")
		expect(ChannelType.values).toEqual(["public", "private", "direct"])
		expect(ChannelType.sql).toBe("channel_type")
		expect(PG.enumType("Kind", ["a"]).sql).toBe('"Kind"')
		expect(PG.enumType("role", ["a"], { schema: "auth" }).sql).toBe("auth.role")
	})

	it("renders the type before the tables that use it, whether or not it is exported", () => {
		const statements = S.renderPgSchema(entitiesOf(channels()))
		expect(statements).toEqual([
			`DO $effect_orm$ BEGIN CREATE TYPE "channel_type" AS ENUM ('public', 'private', 'direct'); EXCEPTION WHEN duplicate_object THEN NULL; END $effect_orm$`,
			[
				'CREATE TABLE IF NOT EXISTS "channels" (',
				'\t"id" text NOT NULL,',
				'\t"org_id" text NOT NULL,',
				'\t"slug" text NOT NULL,',
				"\t\"type\" channel_type NOT NULL DEFAULT 'public',",
				'\t"allowed" channel_type[],',
				'\tCONSTRAINT "channels_pkey" PRIMARY KEY ("id")',
				")",
			].join("\n"),
			'ALTER TABLE "channels" ADD CONSTRAINT "channels_org_slug_unique" UNIQUE NULLS NOT DISTINCT ("org_id", "slug")',
			'ALTER TABLE "channels" ADD CONSTRAINT "channels_slug_unique" UNIQUE ("slug")',
			`CREATE INDEX IF NOT EXISTS "channels_public_idx" ON "channels" USING btree ("org_id") WHERE "type" = 'public'`,
		])
		// Exported as well, it is still one type.
		expect(entitiesOf(ChannelType, channels()).filter((e) => e.kind === "enum")).toHaveLength(1)
	})

	it("quotes labels and qualifies a type of another schema", () => {
		const Role = PG.enumType("role", ["it's", "admin"], { schema: "auth" })
		const users = PG.table("users", { columns: { id: PG.text, role: Role } })
		const statements = S.renderPgSchema(entitiesOf(users))
		expect(statements[0]).toContain(`CREATE TYPE "auth"."role" AS ENUM ('it''s', 'admin');`)
		expect(statements[1]).toContain('"role" auth.role NOT NULL')
	})

	it("rejects a definition Postgres would refuse", () => {
		expect(PG.enumType("x", ["a", "a"]).problems.map((p) => p.message)).toEqual(['"a" is listed twice'])
		expect(PG.enumType("x", ["a".repeat(64)]).problems[0]?.message).toMatch(/longer than 63 bytes/)
		expect(PG.enumType("bad name", ["a"]).problems[0]?.message).toMatch(/not a plain identifier/)
		expect(failureOf(PG.enumType("x", ["a", "a"]))).toMatch(/listed twice/)
		expect(failureOf(PG.enumType("channel_type", ["public"]), channels())).toMatch(/declared twice, with different values/)
		expect(failureOf(PG.enumType("channels", ["a"]), channels())).toMatch(/names both a table and an enum/)
	})

	it("decodes an enum array from its text form, which drivers send for it", () => {
		expect(parsePgArrayLiteral("{public,private}")).toEqual(["public", "private"])
		expect(parsePgArrayLiteral(`{"a b","it's","x\\"y",NULL}`)).toEqual(["a b", "it's", 'x"y', null])
		expect(parsePgArrayLiteral("{}")).toEqual([])
		expect(parsePgArrayLiteral("{{a}}")).toBeUndefined()
		expect(parsePgArrayLiteral("public")).toBeUndefined()
	})
})

describe("PG.unique", () => {
	it("names a column's constraint as drizzle-orm does, or as given", () => {
		const t = PG.table("users", {
			columns: {
				email: PG.column(PG.text, { unique: true }),
				handle: PG.column(PG.text, { unique: "users_handle_key" }),
				phone: PG.column(PG.nullable(PG.text), { unique: { nullsNotDistinct: true } }),
				orgId: PG.column(PG.text, { name: "org_id" }),
			},
			uniqueConstraints: [PG.unique("users_org_email_unique", ["orgId", "email"])],
		})
		expect(t.ddl.uniques).toEqual([
			{ kind: "unique", table: "users", name: "users_email_unique", columns: ["email"], nullsNotDistinct: false },
			{ kind: "unique", table: "users", name: "users_handle_key", columns: ["handle"], nullsNotDistinct: false },
			{ kind: "unique", table: "users", name: "users_phone_unique", columns: ["phone"], nullsNotDistinct: true },
			{ kind: "unique", table: "users", name: "users_org_email_unique", columns: ["org_id", "email"], nullsNotDistinct: false },
		])
		// `unique` does not make a column optional on insert.
		expect(t.defaults).toBeUndefined()
	})

	it("checks names and columns", () => {
		const t = PG.table("t", { columns: { a: PG.text }, uniqueConstraints: [PG.unique("t_b_unique", ["b"]) as PG.UniqueSpec<any>] })
		// @ts-expect-error not a column
		PG.table("t", { columns: { a: PG.text }, uniqueConstraints: [PG.unique("t_b_unique", ["b"])] })
		expect(t.problems.map((p) => p.message)).toEqual(["b is not a column"])
		const clash = PG.table("t", { columns: { a: PG.column(PG.text, { unique: "t_a_unique" }) }, indexes: [PG.uniqueIndex("t_a_unique", ["a"])] })
		expect(failureOf(clash)).toMatch(/one namespace/)
	})
})

describe("diffPgSchemas: enums", () => {
	const before = entitiesOf(channels())
	const withValues = (values: readonly [string, ...Array<string>]) => entitiesOf(channels(PG.enumType("channel_type", values)))

	it("creates a new type before the table that uses it", () => {
		const { ops } = S.diffPgSchemas([], before)
		expect(ops.map((op) => op.op)).toEqual(["create_enum", "create_table", "add_unique", "add_unique", "create_index"])
	})

	it("adds labels in place, each before the label it precedes", () => {
		const { ops, unsupported, missingHints } = S.diffPgSchemas(before, withValues(["public", "announcement", "private", "direct", "thread", "bot"]))
		expect(unsupported).toEqual([])
		expect(missingHints).toEqual([])
		expect(ops.flatMap((op) => S.renderPgOp(op))).toEqual([
			`ALTER TYPE "channel_type" ADD VALUE IF NOT EXISTS 'announcement' BEFORE 'private'`,
			`ALTER TYPE "channel_type" ADD VALUE IF NOT EXISTS 'thread'`,
			`ALTER TYPE "channel_type" ADD VALUE IF NOT EXISTS 'bot'`,
		])
		expect(ops.map(S.labelOfPg)).toEqual(["metadata", "metadata", "metadata"])
	})

	it("renames a label swapped in place, once confirmed", () => {
		const next = withValues(["public", "private", "dm"])
		const first = S.diffPgSchemas(before, next)
		expect(first.ops).toEqual([])
		expect(first.missingHints).toEqual([{ type: "confirm_rename", kind: "enum_value", entity: "channel_type.direct", to: "dm" }])
		const { ops } = S.diffPgSchemas(before, next, first.missingHints)
		expect(ops.flatMap((op) => S.renderPgOp(op))).toEqual([`ALTER TYPE "channel_type" RENAME VALUE 'direct' TO 'dm'`])
		// A hint for another target does not confirm this one.
		expect(S.diffPgSchemas(before, next, [{ ...first.missingHints[0]!, to: "direct_message" } as S.Hint]).ops).toEqual([])
	})

	it("reports removing or reordering labels as unsupported", () => {
		expect(S.diffPgSchemas(before, withValues(["public", "private"])).unsupported).toEqual([
			{ entity: "channel_type", message: expect.stringMatching(/^removing "direct" needs the type rebuilt/) },
		])
		expect(S.diffPgSchemas(before, withValues(["private", "public", "direct"])).unsupported).toEqual([
			{ entity: "channel_type", message: expect.stringMatching(/^reordering labels needs the type rebuilt/) },
		])
		// A removal next to an addition is not read as a rename.
		expect(S.diffPgSchemas(before, withValues(["public", "private", "dm", "group"])).unsupported).toHaveLength(1)
	})

	it("reports a new label used in the migration that adds it", () => {
		const Type = PG.enumType("channel_type", ["public", "private", "direct", "thread"])
		const next = entitiesOf(
			PG.table("channels", {
				columns: {
					id: PG.text,
					org_id: PG.text,
					slug: PG.column(PG.text, { unique: true }),
					type: PG.column(Type, { default: "thread" }),
					allowed: PG.nullable(PG.array(Type)),
				},
				primaryKey: ["id"],
				uniqueConstraints: [PG.unique("channels_org_slug_unique", ["org_id", "slug"], { nullsNotDistinct: true })],
				indexes: [PG.index("channels_public_idx", ["org_id"], { where: ($) => $.type.eq("thread") })],
			}),
		)
		expect(S.diffPgSchemas(before, next).unsupported).toEqual([
			{ entity: "channels.type", message: expect.stringMatching(/^uses "thread", which this migration adds/) },
			{ entity: "channels.channels_public_idx", message: expect.stringMatching(/^uses "thread", which this migration adds/) },
		])
	})

	it("asks before dropping a type, and drops it after the columns that used it", () => {
		const next = entitiesOf(
			PG.table("channels", {
				columns: { id: PG.text, org_id: PG.text, slug: PG.column(PG.text, { unique: true }), type: PG.text, allowed: PG.nullable(PG.array(PG.text)) },
				primaryKey: ["id"],
				uniqueConstraints: [PG.unique("channels_org_slug_unique", ["org_id", "slug"], { nullsNotDistinct: true })],
			}),
		)
		const first = S.diffPgSchemas(before, next)
		expect(first.missingHints).toEqual([{ type: "confirm_data_loss", kind: "enum", entity: "channel_type" }])
		const { ops } = S.diffPgSchemas(before, next, first.missingHints)
		expect(ops.map((op) => op.op)).toEqual(["drop_index", "alter_column", "alter_column", "drop_enum"])
		expect(S.renderPgOp(ops.at(-1)!)).toEqual(['DROP TYPE IF EXISTS "channel_type"'])
		expect(S.labelOfPg(ops.at(-1)!)).toBe("destructive")
	})
})

describe("diffPgSchemas: unique constraints", () => {
	const table = (uniques: ReadonlyArray<PG.UniqueSpec<"id" | "org_id" | "slug">>, indexes: ReadonlyArray<PG.IndexSpec<any>> = []) =>
		PG.table("projects", { columns: { id: PG.text, org_id: PG.text, slug: PG.text }, primaryKey: ["id"], uniqueConstraints: uniques, indexes })

	it("drops and re-adds a changed constraint as a constraint", () => {
		const v1 = entitiesOf(table([PG.unique("projects_slug_unique", ["slug"])]))
		const v2 = entitiesOf(table([PG.unique("projects_slug_unique", ["org_id", "slug"])]))
		expect(S.diffPgSchemas(v1, v2).ops.flatMap((op) => S.renderPgOp(op))).toEqual([
			'ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_slug_unique"',
			'ALTER TABLE "projects" ADD CONSTRAINT "projects_slug_unique" UNIQUE ("org_id", "slug")',
		])
		expect(S.diffPgSchemas(v2, v2).ops).toEqual([])
	})

	it("turns a unique index into a constraint of the same name: the index goes first", () => {
		const v1 = entitiesOf(table([], [PG.uniqueIndex("projects_slug_unique", ["slug"])]))
		const v2 = entitiesOf(table([PG.unique("projects_slug_unique", ["slug"])]))
		expect(S.diffPgSchemas(v1, v2).ops.map((op) => op.op)).toEqual(["drop_index", "add_unique"])
		expect(S.diffPgSchemas(v2, v1).ops.map((op) => op.op)).toEqual(["drop_unique", "create_index"])
	})

	it("adds a constraint before a foreign key that references it, and drops it after", () => {
		const Projects = table([PG.unique("projects_org_slug_unique", ["org_id", "slug"])])
		const Links = PG.table("links", {
			columns: { id: PG.text, org_id: PG.text, slug: PG.text },
			foreignKeys: [PG.foreignKey({ columns: ["org_id", "slug"], references: Projects, foreignColumns: ["org_id", "slug"] })],
		})
		const both = entitiesOf(Projects, Links)
		expect(S.renderPgSchema(both).map((sql) => sql.split(/[\n(]/)[0]!.split(" ").slice(0, 6).join(" ").trim())).toEqual([
			'CREATE TABLE IF NOT EXISTS "links"',
			'CREATE TABLE IF NOT EXISTS "projects"',
			'ALTER TABLE "projects" ADD CONSTRAINT "projects_org_slug_unique"',
			'ALTER TABLE "links" ADD CONSTRAINT "links_org_id_slug_projects_org_id_slug_fk"',
		])
		const hints = [{ type: "confirm_data_loss", kind: "table", entity: "links" } as const]
		expect(S.diffPgSchemas(both, entitiesOf(table([])), hints).ops.map((op) => op.op)).toEqual(["drop_foreign_key", "drop_unique", "drop_table"])
		// A dropped table takes its own constraints with it.
		const dropAll = [...hints, { type: "confirm_data_loss", kind: "table", entity: "projects" } as const]
		expect(S.diffPgSchemas(both, [], dropAll).ops.map((op) => op.op)).toEqual(["drop_foreign_key", "drop_table", "drop_table"])
	})
})

describe("fromDrizzleSnapshot: enums and unique constraints", () => {
	const snapshot = {
		version: "8",
		dialect: "postgres",
		id: "x",
		prevIds: [],
		renames: [],
		ddl: [
			{ name: "channel_type", schema: "public", values: ["public", "private", "direct"], entityType: "enums" },
			{ name: "role", schema: "auth", values: ["admin"], entityType: "enums" },
			{ isRlsEnabled: false, name: "channels", entityType: "tables", schema: "public" },
			{ type: "text", typeSchema: null, notNull: true, dimensions: 0, default: null, generated: null, identity: null, name: "id", entityType: "columns", schema: "public", table: "channels" },
			{ type: "text", typeSchema: null, notNull: true, dimensions: 0, default: null, generated: null, identity: null, name: "org_id", entityType: "columns", schema: "public", table: "channels" },
			{ type: "text", typeSchema: null, notNull: true, dimensions: 0, default: null, generated: null, identity: null, name: "slug", entityType: "columns", schema: "public", table: "channels" },
			{ type: "channel_type", typeSchema: "public", notNull: true, dimensions: 0, default: "'public'", generated: null, identity: null, name: "type", entityType: "columns", schema: "public", table: "channels" },
			{ type: "channel_type", typeSchema: "public", notNull: false, dimensions: 1, default: null, generated: null, identity: null, name: "allowed", entityType: "columns", schema: "public", table: "channels" },
			{ columns: ["id"], nameExplicit: false, name: "channels_pkey", entityType: "pks", schema: "public", table: "channels" },
			{ nameExplicit: false, columns: ["slug"], nullsNotDistinct: false, name: "channels_slug_unique", entityType: "uniques", schema: "public", table: "channels" },
			{ nameExplicit: true, columns: ["org_id", "slug"], nullsNotDistinct: true, name: "channels_org_slug_unique", entityType: "uniques", schema: "public", table: "channels" },
			{
				nameExplicit: true,
				columns: [{ value: "org_id", isExpression: false, asc: true, nullsFirst: false, opclass: null }],
				isUnique: false,
				where: `"channels"."type" = 'public'`,
				with: "",
				method: "btree",
				concurrently: false,
				name: "channels_public_idx",
				entityType: "indexes",
				schema: "public",
				table: "channels",
			},
		],
	}

	it("converts enums, enum columns and unique constraints", () => {
		const { entities, unsupported } = S.fromDrizzleSnapshot(snapshot)
		expect(unsupported).toEqual([])
		expect(entities.filter((e) => e.kind === "enum")).toEqual([
			{ kind: "enum", schema: "auth", name: "role", values: ["admin"] },
			{ kind: "enum", schema: null, name: "channel_type", values: ["public", "private", "direct"] },
		])
		expect(entities).toContainEqual({ kind: "column", table: "channels", name: "type", position: 3, type: "channel_type", notNull: true, default: "'public'", identity: null })
		expect(entities).toContainEqual({ kind: "column", table: "channels", name: "allowed", position: 4, type: "channel_type[]", notNull: false, default: null, identity: null })
		expect(entities).toContainEqual({ kind: "unique", table: "channels", name: "channels_org_slug_unique", columns: ["org_id", "slug"], nullsNotDistinct: true })
	})

	it("matches the same schema declared with PG.enumType and PG.unique, but for how a predicate is written", () => {
		const imported = S.fromDrizzleSnapshot({ ...snapshot, ddl: snapshot.ddl.filter((e) => e.name !== "role") }).entities
		const { ops } = S.diffPgSchemas(imported, entitiesOf(channels()))
		expect(ops.map((op) => op.op)).toEqual(["drop_index", "create_index"])
	})
})
