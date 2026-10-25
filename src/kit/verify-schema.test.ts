// `verifySchema`: the schema modules against a live database, with no
// migrations folder and no ledger.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PgliteClient } from "@effect/sql-pglite"
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { runCli, verifySchema, type KitConfig } from "../kit"
import * as Migrate from "../migrate"

const src = resolve(import.meta.dirname, "..")

const schemaModule = `
import * as PG from "${src}/postgres"

export const Users = PG.table("users", {
	columns: {
		id: PG.text,
		email: PG.text,
		name: PG.nullable(PG.text),
	},
	primaryKey: ["id"],
	indexes: [PG.uniqueIndex("users_email_unq", ["email"])],
})
`

const created = [
	`CREATE TABLE users (id text NOT NULL, email text NOT NULL, name text, CONSTRAINT users_pkey PRIMARY KEY (id))`,
	`CREATE UNIQUE INDEX users_email_unq ON users (email)`,
]

describe("verifySchema", () => {
	let dir = ""
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "effect-orm-verify-schema-"))
		writeFileSync(join(dir, "schema.ts"), schemaModule)
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	const withDb = <A, E>(body: (config: KitConfig) => Effect.Effect<A, E, SqlClient.SqlClient>) =>
		Effect.gen(function* () {
			const context = yield* Layer.build(Migrate.layerSqlClient().pipe(Layer.provideMerge(PgliteClient.layer({}))))
			// The same database for the test body and for the config's driver.
			const config: KitConfig = { dialect: "postgres", schema: "./schema.ts", out: "./migrations", driver: Layer.succeedContext(context) }
			return yield* body(config).pipe(Effect.provideContext(context))
		}).pipe(Effect.scoped)

	it.effect("reads clean when the database matches the definitions, with no migrations folder", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				for (const statement of created) yield* sql.unsafe(statement)
				expect(yield* verifySchema(config, dir)).toEqual({ drift: [] })
			}),
		),
	)

	it.effect("reports a missing column, a type change, a nullability change and a missing index", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				yield* sql.unsafe(`CREATE TABLE users (id text NOT NULL, email varchar(10), CONSTRAINT users_pkey PRIMARY KEY (id))`)
				const { drift } = yield* verifySchema(config, dir)
				expect(drift.map((d) => `${d.problem} ${d.entity}`).sort()).toEqual([
					"missing users.name",
					"missing users.users_email_unq",
					"not_null users.email",
					"type users.email",
				])
				expect(drift.find((d) => d.problem === "type")).toMatchObject({ expected: "text", actual: "character varying(10)" })
			}),
		),
	)
})

describe("effect-orm verify --schema", () => {
	let dir = ""
	let lines: Array<string> = []
	const cli = (...args: Array<string>) => {
		const cwd = process.cwd()
		process.chdir(dir)
		return runCli(args, (line) => lines.push(line)).finally(() => process.chdir(cwd))
	}
	/** A config whose driver is a fresh database holding what `statements` create. */
	const config = (name: string, statements: ReadonlyArray<string>) =>
		writeFileSync(
			join(dir, name),
			`import { pgliteDriver } from "${src}/kit/__fixtures__/pglite-driver"
export default { dialect: "postgres", schema: "./schema.ts", out: "./migrations", driver: pgliteDriver(${JSON.stringify(statements)}) }
`,
		)

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "effect-orm-verify-schema-cli-"))
		lines = []
		writeFileSync(join(dir, "schema.ts"), schemaModule)
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it("exits 0 when the database matches, with no migrations folder", async () => {
		config("clean.config.ts", created)
		expect(await cli("verify", "--schema", "--config", "clean.config.ts")).toBe(0)
		expect(lines).toEqual(["No drift against the schema modules."])
	})

	it("exits 3 and prints one line per difference", async () => {
		config("drift.config.ts", [`CREATE TABLE users (id text NOT NULL, email text, CONSTRAINT users_pkey PRIMARY KEY (id))`])
		expect(await cli("verify", "--schema", "--config", "drift.config.ts")).toBe(3)
		expect(lines).toEqual([
			"Drift against the schema modules:",
			"  users.email: not_null (expected NOT NULL, actual NULL)",
			"  users.name: missing",
			"  users.users_email_unq: missing",
		])
		lines = []
		expect(await cli("verify", "--schema", "--json", "--config", "drift.config.ts")).toBe(3)
		expect(JSON.parse(lines[0]!).drift).toHaveLength(3)
	})
})
