// Enums and unique constraints against a live Postgres (PGlite): what
// `generate` writes applies, `verify` reads back clean, and a database
// drizzle-kit pushed is adopted without false drift.

import { PgliteClient } from "@effect/sql-pglite"
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Migrate from "../migrate"
import * as PG from "../postgres"
import * as S from "../schema"

const Live = Migrate.layerSqlClient().pipe(Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })))

const ChannelType = PG.enumType("channel_type", ["public", "private", "direct"])
const OutboxStatus = PG.enumType("message_outbox_event_status", ["pending", "processing", "done"])

const schemaWith = (channelType: PG.PgEnum<string> = ChannelType) => {
	const Channels = PG.table("channels", {
		columns: {
			id: PG.text,
			org_id: PG.text,
			slug: PG.column(PG.text, { unique: true }),
			type: PG.column(channelType, { default: "public" }),
			allowed: PG.nullable(PG.array(channelType)),
		},
		primaryKey: ["id"],
		uniqueConstraints: [PG.unique("channels_org_slug_unique", ["org_id", "slug"], { nullsNotDistinct: true })],
	})
	const Outbox = PG.table("message_outbox", {
		columns: {
			id: PG.text,
			channel_org_id: PG.text,
			channel_slug: PG.text,
			status: PG.column(OutboxStatus, { default: "pending" }),
			created_at: PG.column(PG.timestamptz, { defaultExpr: "now()" }),
		},
		primaryKey: ["id"],
		indexes: [PG.index("message_outbox_pending_idx", ["created_at"], { where: `"message_outbox"."status" = 'pending'` })],
		foreignKeys: [
			// References the unique constraint, not the primary key.
			PG.foreignKey({ columns: ["channel_org_id", "channel_slug"], references: Channels, foreignColumns: ["org_id", "slug"], name: "message_outbox_channel_fk" }),
		],
	})
	return { Channels, Outbox }
}

/** Each step generated from the one before, as `generate` writes them. */
const history = (steps: ReadonlyArray<{ readonly name: string; readonly objects: ReadonlyArray<S.SchemaObject>; readonly hints?: ReadonlyArray<S.Hint> }>) =>
	Effect.gen(function* () {
		const record: Record<string, Migrate.MigrationInput> = {}
		let prev: ReadonlyArray<S.PgSchemaEntity> = []
		let prevIds: ReadonlyArray<string> = [S.ORIGIN_ID]
		for (const step of steps) {
			const next = yield* S.pgEntitiesOf(step.objects)
			const { ops, missingHints, unsupported } = S.diffPgSchemas(prev, next, step.hints)
			assert.deepStrictEqual([missingHints, unsupported], [[], []])
			const snapshot = yield* S.makeSnapshot(next, prevIds, "postgres")
			record[step.name] = {
				kind: "ops",
				migration: JSON.stringify({ version: "1", dialect: "postgres", ops }),
				snapshot: S.serializeSnapshot(snapshot),
			}
			prev = next
			prevIds = [snapshot.id]
		}
		return yield* Migrate.fromRecord(record)
	})

const labels = (type: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const rows = yield* sql.unsafe<{ label: string }>(
			`SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = '${type}' ORDER BY e.enumsortorder`,
		)
		return rows.map((r) => r.label)
	})

describe("Postgres enums and unique constraints", () => {
	it.effect("migrate creates them, verify reads them back clean, and queries use them", () =>
		Effect.gen(function* () {
			const { Channels, Outbox } = schemaWith()
			const migrations = yield* history([{ name: "20261013000000_init", objects: [ChannelType, OutboxStatus, Channels, Outbox] }])
			yield* Migrate.run({ migrations })
			expect(yield* Migrate.verify(migrations)).toEqual({ against: "20261013000000_init", drift: [] })

			const sql = yield* SqlClient.SqlClient
			const exec = (compiled: { readonly sql: string; readonly parameters: ReadonlyArray<unknown> }) =>
				sql.unsafe<Record<string, unknown>>(compiled.sql, [...compiled.parameters])
			yield* exec(PG.compileUnsafe(PG.insertInto(Channels).values({ id: "c1", org_id: "o", slug: "general", allowed: ["public", "direct"] }), {}))
			// The unique constraint is the conflict target, by its columns or by name.
			yield* exec(
				PG.compileUnsafe(
					PG.insertInto(Channels)
						.values({ id: "c2", org_id: "o", slug: "general", type: "private" })
						.onConflictDoUpdate({ target: ["slug"], set: { type: "private" } }),
					{},
				),
			)
			yield* exec(
				PG.compileUnsafe(
					PG.insertInto(Channels).values({ id: "c3", org_id: "o", slug: "general" }).onConflictDoNothing({ target: { constraint: "channels_slug_unique" } }),
					{},
				),
			)
			const query = PG.compileUnsafe(PG.from(Channels).select("id", "type", "allowed").where(($) => [$.type.in_("private", "direct")]), {})
			expect(yield* query.decodeRows(yield* exec(query))).toEqual([{ id: "c1", type: "private", allowed: ["public", "direct"] }])
			const bad = yield* Effect.exit(sql.unsafe(`INSERT INTO channels (id, org_id, slug, type) VALUES ('c4', 'o', 's', 'nope')`))
			expect(Exit.isFailure(bad)).toBe(true)
		}).pipe(Effect.provide(Live)),
	)

	it.effect("adds and renames labels, swaps a unique index for a constraint, and drops a type, verifying clean after each", () =>
		Effect.gen(function* () {
			const v1 = schemaWith()
			const added = PG.enumType("channel_type", ["public", "announcement", "private", "direct", "thread"])
			const v2 = schemaWith(added)
			const renamed = PG.enumType("channel_type", ["public", "announcement", "private", "dm", "thread"])
			const v3 = schemaWith(renamed)
			const Tags = (unique: boolean) =>
				PG.table("tags", {
					columns: { id: PG.text, name: PG.text },
					...(unique ? { uniqueConstraints: [PG.unique("tags_name_unique", ["name"])] } : { indexes: [PG.uniqueIndex("tags_name_unique", ["name"])] }),
				})
			const Mood = PG.enumType("mood", ["ok"])
			const Notes = (withMood: boolean) => PG.table("notes", { columns: { id: PG.text, mood: withMood ? Mood : PG.text } })

			const steps = [
				{ name: "20261013000000_init", objects: [v1.Channels, v1.Outbox, Tags(false), Notes(true)] },
				{ name: "20261013000001_labels", objects: [v2.Channels, v2.Outbox, Tags(false), Notes(true)] },
				{
					name: "20261013000002_rename",
					objects: [v3.Channels, v3.Outbox, Tags(true), Notes(true)],
					hints: [{ type: "confirm_rename", kind: "enum_value", entity: "channel_type.direct", to: "dm" } as const],
				},
				{
					name: "20261013000003_drop_mood",
					objects: [v3.Channels, v3.Outbox, Tags(true), Notes(false)],
					hints: [{ type: "confirm_data_loss", kind: "enum", entity: "mood" } as const],
				},
			]
			const sql = yield* SqlClient.SqlClient
			for (let i = 1; i <= steps.length; i++) {
				const migrations = yield* history(steps.slice(0, i))
				yield* Migrate.run({ migrations })
				expect((yield* Migrate.verify(migrations)).drift).toEqual([])
				if (i === 1) yield* sql.unsafe(`INSERT INTO channels (id, org_id, slug, type) VALUES ('c1', 'o', 's', 'direct')`)
			}
			expect(yield* labels("channel_type")).toEqual(["public", "announcement", "private", "dm", "thread"])
			// The renamed label kept its rows.
			expect(yield* sql.unsafe(`SELECT type::text AS type FROM channels`)).toEqual([{ type: "dm" }])
			expect(yield* labels("mood")).toEqual([])
			const tagsConstraint = yield* sql.unsafe(`SELECT conname FROM pg_constraint WHERE conname = 'tags_name_unique' AND contype = 'u'`)
			expect(tagsConstraint).toHaveLength(1)
		}).pipe(Effect.provide(Live)),
	)

	it.effect("a label the migration adds and uses fails the migration as a whole", () =>
		Effect.gen(function* () {
			// What generate refuses to write, written by hand: Postgres rejects it and nothing is applied.
			const migrations = yield* Migrate.fromRecord({
				"20261013000000_a": { kind: "sql", migration: `CREATE TYPE "k" AS ENUM ('a');\n--> statement-breakpoint\nCREATE TABLE "t" ("k" k NOT NULL)` },
				"20261013000001_b": {
					kind: "sql",
					migration: `ALTER TYPE "k" ADD VALUE 'b'\n--> statement-breakpoint\nALTER TABLE "t" ALTER COLUMN "k" SET DEFAULT 'b'`,
				},
			})
			const exit = yield* Effect.exit(Migrate.run({ migrations, dialect: "postgres" }))
			assert(Exit.isFailure(exit))
			expect(String(exit.cause)).toMatch(/unsafe use of new value/)
			expect(yield* labels("k")).toEqual(["a"])
		}).pipe(Effect.provide(Live)),
	)

	it.effect("verify reports drift in labels, unique constraints and stray types", () =>
		Effect.gen(function* () {
			const { Channels, Outbox } = schemaWith()
			const migrations = yield* history([{ name: "20261013000000_init", objects: [Channels, Outbox] }])
			yield* Migrate.run({ migrations })
			const sql = yield* SqlClient.SqlClient
			yield* sql.unsafe(`ALTER TYPE channel_type ADD VALUE 'thread'`)
			yield* sql.unsafe(`ALTER TABLE channels DROP CONSTRAINT channels_slug_unique`)
			// The same uniqueness as an index is still drift: it is not a constraint.
			yield* sql.unsafe(`CREATE UNIQUE INDEX channels_slug_unique ON channels (slug)`)
			yield* sql.unsafe(`ALTER TABLE channels DROP CONSTRAINT channels_org_slug_unique CASCADE`)
			yield* sql.unsafe(`ALTER TABLE channels ADD CONSTRAINT channels_org_slug_unique UNIQUE (org_id, slug)`)
			yield* sql.unsafe(`CREATE TYPE stray AS ENUM ('x')`)
			const { drift } = yield* Migrate.verify(migrations)
			expect(drift.map((d) => `${d.problem} ${d.entity}`).sort()).toEqual([
				"enum enum channel_type",
				"missing channels.channels_slug_unique",
				"missing message_outbox.message_outbox_channel_fk",
				"unexpected channels.channels_slug_unique",
				"unexpected enum stray",
				"unique channels.channels_org_slug_unique",
			])
			expect(drift.find((d) => d.problem === "enum")).toMatchObject({
				expected: JSON.stringify(["public", "private", "direct"]),
				actual: JSON.stringify(["public", "private", "direct", "thread"]),
			})
		}).pipe(Effect.provide(Live)),
	)

	it.effect("an enum in another schema is created there and verified, and that schema's other enums are not drift", () =>
		Effect.gen(function* () {
			const Role = PG.enumType("role", ["admin", "member"], { schema: "auth" })
			const Users = PG.table("users", { columns: { id: PG.text, role: PG.column(Role, { default: "member" }) } })
			const entities = yield* S.pgEntitiesOf([Users])
			const snapshot = yield* S.makeSnapshot(entities, [S.ORIGIN_ID], "postgres")
			const { ops } = S.diffPgSchemas([], entities)
			const migrations = yield* Migrate.fromRecord({
				// generate does not create schemas.
				"20261013000000_auth": { kind: "sql", migration: `CREATE SCHEMA auth;\n--> statement-breakpoint\nCREATE TYPE auth.other AS ENUM ('x')` },
				"20261013000001_users": {
					kind: "ops",
					migration: JSON.stringify({ version: "1", dialect: "postgres", ops }),
					snapshot: S.serializeSnapshot(snapshot),
				},
			})
			yield* Migrate.run({ migrations })
			expect((yield* Migrate.verify(migrations)).drift).toEqual([])
			const sql = yield* SqlClient.SqlClient
			yield* sql.unsafe(`ALTER TYPE auth.role ADD VALUE 'guest'`)
			expect((yield* Migrate.verify(migrations)).drift.map((d) => `${d.problem} ${d.entity}`)).toEqual(["enum enum auth.role"])
		}).pipe(Effect.provide(Live)),
	)

	it.effect("a PG.custom enum type created by hand still verifies clean, qualified or not", () =>
		Effect.gen(function* () {
			const Role = Schema.Literals(["owner", "member"])
			const Members = PG.table("members", {
				columns: {
					id: PG.text,
					role: PG.column(PG.custom("public.organization_role", Role), { default: "member" }),
					old_role: PG.nullable(PG.custom("organization_role", Role)),
				},
				indexes: [PG.index("members_owner_idx", ["id"], { where: `role = 'owner'::public.organization_role` })],
			})
			const entities = yield* S.pgEntitiesOf([Members])
			const snapshot = yield* S.makeSnapshot(entities, [S.ORIGIN_ID], "postgres")
			const record: Record<string, Migrate.MigrationInput> = {
				"20261013000000_types": { kind: "sql", migration: `CREATE TYPE "public"."organization_role" AS ENUM ('owner', 'member')` },
				"20261013000001_members": {
					kind: "sql",
					migration: S.renderPgSchema(entities).join("\n--> statement-breakpoint\n"),
					snapshot: S.serializeSnapshot(snapshot),
				},
			}
			const migrations = yield* Migrate.fromRecord(record)
			yield* Migrate.run({ migrations, dialect: "postgres" })
			expect((yield* Migrate.verify(migrations)).drift).toEqual([])

			// Then declared with enumType: the type is kept, the column moves to its unqualified name.
			const OrganizationRole = PG.enumType("organization_role", ["owner", "member"])
			const declared = PG.table("members", {
				columns: { id: PG.text, role: PG.column(OrganizationRole, { default: "member" }), old_role: PG.nullable(OrganizationRole) },
				indexes: [PG.index("members_owner_idx", ["id"], { where: `role = 'owner'::public.organization_role` })],
			})
			const next = yield* S.pgEntitiesOf([declared])
			const { ops } = S.diffPgSchemas(entities, next)
			expect(ops.map((op) => op.op)).toEqual(["create_enum", "alter_column"])
			const nextSnapshot = yield* S.makeSnapshot(next, [snapshot.id], "postgres")
			const adopted = yield* Migrate.fromRecord({
				...record,
				"20261013000002_enum": {
					kind: "ops",
					migration: JSON.stringify({ version: "1", dialect: "postgres", ops }),
					snapshot: S.serializeSnapshot(nextSnapshot),
				},
			})
			expect((yield* Migrate.run({ migrations: adopted })).map((m) => m.name)).toEqual(["20261013000002_enum"])
			expect((yield* Migrate.verify(adopted)).drift).toEqual([])
		}).pipe(Effect.provide(Live)),
	)

	it.effect("a database drizzle-kit pushed, with enums and unique constraints, adopts through a baseline and verifies clean", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			// What `drizzle-kit push` ran.
			const pushed = [
				`CREATE TYPE "public"."channel_type" AS ENUM('public', 'private', 'direct')`,
				`CREATE TYPE "public"."message_outbox_event_status" AS ENUM('pending', 'processing', 'done')`,
				`CREATE TABLE "channels" (
					"id" text PRIMARY KEY NOT NULL,
					"org_id" text NOT NULL,
					"slug" text NOT NULL,
					"type" "channel_type" DEFAULT 'public' NOT NULL,
					"allowed" "channel_type"[],
					CONSTRAINT "channels_org_slug_unique" UNIQUE NULLS NOT DISTINCT("org_id","slug")
				)`,
				`CREATE TABLE "message_outbox" (
					"id" text PRIMARY KEY NOT NULL,
					"channel_org_id" text NOT NULL,
					"channel_slug" text NOT NULL,
					"status" "message_outbox_event_status" DEFAULT 'pending' NOT NULL,
					"created_at" timestamp with time zone DEFAULT now() NOT NULL
				)`,
				`ALTER TABLE "channels" ADD CONSTRAINT "channels_slug_unique" UNIQUE("slug")`,
				`ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_channel_fk" FOREIGN KEY ("channel_org_id","channel_slug") REFERENCES "public"."channels"("org_id","slug") ON DELETE no action ON UPDATE no action`,
				`CREATE INDEX "message_outbox_pending_idx" ON "message_outbox" USING btree ("created_at") WHERE "message_outbox"."status" = 'pending'`,
			]
			for (const statement of pushed) yield* sql.unsafe(statement)

			// drizzle-kit's snapshot of the same schema.
			const column = (table: string, name: string, type: string, extra: Record<string, unknown> = {}) => ({
				type,
				typeSchema: null,
				notNull: true,
				dimensions: 0,
				default: null,
				generated: null,
				identity: null,
				name,
				entityType: "columns",
				schema: "public",
				table,
				...extra,
			})
			const drizzle = {
				version: "8",
				dialect: "postgres",
				id: "d",
				prevIds: [],
				renames: [],
				ddl: [
					{ name: "channel_type", schema: "public", values: ["public", "private", "direct"], entityType: "enums" },
					{ name: "message_outbox_event_status", schema: "public", values: ["pending", "processing", "done"], entityType: "enums" },
					{ isRlsEnabled: false, name: "channels", entityType: "tables", schema: "public" },
					column("channels", "id", "text"),
					column("channels", "org_id", "text"),
					column("channels", "slug", "text"),
					column("channels", "type", "channel_type", { typeSchema: "public", default: "'public'" }),
					column("channels", "allowed", "channel_type", { typeSchema: "public", notNull: false, dimensions: 1 }),
					{ columns: ["id"], nameExplicit: false, name: "channels_pkey", entityType: "pks", schema: "public", table: "channels" },
					{ nameExplicit: false, columns: ["slug"], nullsNotDistinct: false, name: "channels_slug_unique", entityType: "uniques", schema: "public", table: "channels" },
					{ nameExplicit: true, columns: ["org_id", "slug"], nullsNotDistinct: true, name: "channels_org_slug_unique", entityType: "uniques", schema: "public", table: "channels" },
					{ isRlsEnabled: false, name: "message_outbox", entityType: "tables", schema: "public" },
					column("message_outbox", "id", "text"),
					column("message_outbox", "channel_org_id", "text"),
					column("message_outbox", "channel_slug", "text"),
					column("message_outbox", "status", "message_outbox_event_status", { typeSchema: "public", default: "'pending'" }),
					column("message_outbox", "created_at", "timestamp with time zone", { default: "now()" }),
					{ columns: ["id"], nameExplicit: false, name: "message_outbox_pkey", entityType: "pks", schema: "public", table: "message_outbox" },
					{
						nameExplicit: false,
						columns: ["channel_org_id", "channel_slug"],
						schemaTo: "public",
						tableTo: "channels",
						columnsTo: ["org_id", "slug"],
						onUpdate: "NO ACTION",
						onDelete: "NO ACTION",
						name: "message_outbox_channel_fk",
						entityType: "fks",
						schema: "public",
						table: "message_outbox",
					},
					{
						nameExplicit: true,
						columns: [{ value: "created_at", isExpression: false, asc: true, nullsFirst: false, opclass: null }],
						isUnique: false,
						where: `"message_outbox"."status" = 'pending'`,
						with: "",
						method: "btree",
						concurrently: false,
						name: "message_outbox_pending_idx",
						entityType: "indexes",
						schema: "public",
						table: "message_outbox",
					},
				],
			}

			// `generate --baseline --from-drizzle`, then `effect-orm baseline`.
			const imported = S.fromDrizzleSnapshot(drizzle)
			expect(imported.unsupported).toEqual([])
			const base = yield* S.makeSnapshot(imported.entities, [S.ORIGIN_ID], "postgres")
			const migrations = yield* Migrate.fromRecord({
				"20260101000000_drizzle_init": { kind: "sql", migration: pushed.join("\n--> statement-breakpoint\n"), snapshot: JSON.stringify(drizzle) },
				"20261013000000_effect_orm_baseline": { kind: "sql", migration: "-- Baseline: runs nothing.\n", snapshot: S.serializeSnapshot(base) },
			})
			yield* Migrate.baseline({ migrations, upTo: "20261013000000_effect_orm_baseline" })
			expect(yield* Migrate.verify(migrations)).toEqual({ against: "20261013000000_effect_orm_baseline", drift: [] })

			// The same schema declared with enumType and unique: the next generate has nothing to write.
			const { Channels, Outbox } = schemaWith()
			expect(S.diffPgSchemas(imported.entities, yield* S.pgEntitiesOf([ChannelType, OutboxStatus, Channels, Outbox])).ops).toEqual([])
		}).pipe(Effect.provide(Live)),
	)
})
