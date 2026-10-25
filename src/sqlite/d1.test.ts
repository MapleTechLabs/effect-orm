// A real local Workers D1 binding; no cloud account or network database needed.
import * as D1Client from "@effect/sql-d1/D1Client"
import { Cause, Effect, Exit, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { Miniflare } from "miniflare"
import { expect, it } from "vitest"
import * as Db from "../database"
import * as SQLite from "../sqlite"

const Ack = SQLite.table("whats_new_ack", {
	id: SQLite.text,
	entry_id: SQLite.text,
	user_id: SQLite.text,
	org_id: SQLite.text,
	acked_at: SQLite.text,
}, { tenantColumn: "org_id" })
const first = { id: "ack_1", entry_id: "release_1", user_id: "user_1", org_id: "org_1", acked_at: "2026-10-01T09:00:00.000Z" }
const second = { ...first, id: "ack_2", entry_id: "release_2" }
const other = { ...first, id: "ack_3", user_id: "user_2", org_id: "org_2" }

const withD1 = async <A, E>(body: (db: Db.DatabaseApi, statements: Array<string>) => Effect.Effect<A, E>) => {
	const mf = new Miniflare({
		modules: true,
		script: "export default { fetch() { return new Response('D1 dialect test') } }",
		compatibilityDate: "2026-07-01",
		d1Databases: ["DB"],
	})
	try {
		const binding = await mf.getD1Database("DB")
		return await Effect.runPromise(Effect.gen(function* () {
			const client = yield* SqlClient.SqlClient
			const statements: Array<string> = []
			const db = Db.fromSqlClient(client, {
				dialect: SQLite.d1Dialect,
				requireTenantScope: true,
				observe: (statement) => Effect.sync(() => void statements.push(statement.sql)),
			})
			yield* db.execute({ sql: "CREATE TABLE whats_new_ack (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, user_id TEXT NOT NULL, org_id TEXT NOT NULL, acked_at TEXT NOT NULL, UNIQUE(entry_id, user_id))" })
			statements.length = 0
			return yield* body(db, statements)
		}).pipe(Effect.provide(D1Client.layer({ db: binding }))))
	} finally {
		await mf.dispose()
	}
}

it("copies acknowledgments on D1, keeps the first row, scopes reads and pages explicitly across tenants", async () => {
	const result = await withD1((db) => Effect.gen(function* () {
		yield* db.run(SQLite.insertInto(Ack).values([first, second, other]).onConflictDoNothing().crossTenant())
		yield* db.run(SQLite.insertInto(Ack).values({ ...first, id: "ack_9", acked_at: "2026-10-09T00:00:00.000Z" }).onConflictDoNothing())
		const byUser = yield* db.run(SQLite.from(Ack).select("entry_id").where(($) => [$.org_id.eq("org_1"), $.user_id.eq("user_1")]).orderBy(["entry_id", "asc"]))
		const page = yield* db.run(SQLite.from(Ack).select().where(($) => [$.id.gt("ack_1")]).orderBy(["id", "asc"]).limit(2).crossTenant())
		const kept = yield* db.run(SQLite.from(Ack).select().where(($) => [$.org_id.eq("org_1"), $.id.eq("ack_1")]))
		return { byUser, page, kept }
	}))
	expect(result).toEqual({ byUser: [{ entry_id: "release_1" }, { entry_id: "release_2" }], page: [second, other], kept: [first] })
}, 30_000)

it("refuses an unscoped query, too many bindings and interactive transactions before dispatch", async () => {
	const seen = await withD1((db, statements) => Effect.gen(function* () {
		const scope = yield* Effect.exit(db.run(SQLite.from(Ack).select()))
		const limits = yield* Effect.exit(db.run(SQLite.insertInto(Ack).values(Array.from({ length: 21 }, (_, i) => ({ ...first, id: `${i}` }))).crossTenant()))
		let bodyRan = false
		const transaction = yield* Effect.exit(db.transaction(Effect.sync(() => { bodyRan = true })))
		return { scope, limits, transaction, bodyRan, statements: [...statements] }
	}))
	if (!Exit.isFailure(seen.scope) || !Exit.isFailure(seen.limits) || !Exit.isFailure(seen.transaction)) throw new Error("a D1 guard accepted an invalid request")
	expect(Cause.findDefect(seen.scope.cause)).toMatchObject({ success: { _tag: "@maple-dev/effect-orm/TenantScopeViolation" } })
	expect(Cause.findError(seen.limits.cause)).toMatchObject({ success: { _tag: "@maple-dev/effect-orm/QueryBuilderError" } })
	expect(Cause.findError(seen.transaction.cause)).toMatchObject({ success: { _tag: "@maple-dev/effect-orm/TransactionUnsupported" } })
	expect(seen.bodyRan).toBe(false)
	expect(seen.statements).toEqual([])
}, 30_000)

it("decodes D1 JSON and blob wire values and returns typed errors for malformed rows", async () => {
	const Payloads = SQLite.table("payloads", { id: SQLite.integer, payload: SQLite.json(Schema.Struct({ ok: Schema.Boolean })), bytes: SQLite.blob })
	const seen = await withD1((db) => Effect.gen(function* () {
		yield* db.execute({ sql: "CREATE TABLE payloads (id INTEGER, payload TEXT, bytes BLOB)" })
		yield* db.run(SQLite.insertInto(Payloads).values({ id: 1, payload: { ok: true }, bytes: new Uint8Array([0, 127, 255]) }))
		const rows = yield* db.run(SQLite.from(Payloads).select())
		yield* db.execute({ sql: "UPDATE payloads SET payload = '{}' WHERE id = 1" })
		const malformed = yield* Effect.exit(db.run(SQLite.from(Payloads).select()))
		return { rows, malformed }
	}))
	expect(seen.rows).toEqual([{ id: 1, payload: { ok: true }, bytes: new Uint8Array([0, 127, 255]) }])
	if (!Exit.isFailure(seen.malformed)) throw new Error("malformed JSON was accepted")
	expect(Cause.findError(seen.malformed.cause)).toMatchObject({ success: { _tag: "@maple-dev/effect-orm/CompiledQueryDecodeError" } })
}, 30_000)

it("refuses a D1 integer past 2^53 instead of decoding a different number", async () => {
	const Big = SQLite.table("big", { id: SQLite.integer })
	const exit = await withD1((db) => Effect.gen(function* () {
		yield* db.execute({ sql: "CREATE TABLE big (id INTEGER)" })
		// D1 reads 9007199254740993 as the JS number 9007199254740992: no longer the stored value.
		yield* db.execute({ sql: "INSERT INTO big VALUES (9007199254740993)" })
		return yield* Effect.exit(db.run(SQLite.from(Big).select().crossTenant()))
	}))
	if (!Exit.isFailure(exit)) throw new Error(`an unsafe integer decoded as ${JSON.stringify(exit.value)}`)
	expect(Cause.findError(exit.cause)).toMatchObject({ success: { _tag: "@maple-dev/effect-orm/CompiledQueryDecodeError" } })
}, 30_000)
