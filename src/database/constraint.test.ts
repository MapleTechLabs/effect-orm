// Constraint violations as typed errors, against a real Postgres (PGlite) for
// the SQLSTATE side. ClickHouse's live CHECK test is in
// tests/database.clickhouse.test.ts; here its errors are built by hand.

import * as D1Client from "@effect/sql-d1/D1Client"
import { PgliteClient } from "@effect/sql-pglite"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { Miniflare } from "miniflare"
import { postgresDialect } from "../pg/dialect"
import * as Db from "../database"
import * as SQLite from "../sqlite"

const Live = Layer.effect(
	Db.Database,
	Effect.gen(function* () {
		return Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: postgresDialect })
	}),
).pipe(Layer.provideMerge(PgliteClient.layer()))

layer(Live, { excludeTestServices: true })("constraint violations on PGlite", (it) => {
	it.effect("a duplicate key is UniqueViolation with the constraint name", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`CREATE TABLE users_u (id int4 PRIMARY KEY, email text CONSTRAINT users_u_email_key UNIQUE)`)
			yield* Db.execute(Db.sql`INSERT INTO users_u VALUES (${1}, ${"a@x"})`)
			const error = yield* Effect.flip(
				Db.execute(Db.sql`INSERT INTO users_u VALUES (${2}, ${"a@x"})`).pipe(Db.refineConstraints),
			)
			expect(error._tag).toBe("@maple-dev/effect-orm/UniqueViolation")
			if (error._tag !== "@maple-dev/effect-orm/UniqueViolation") return
			expect(error.constraint).toBe("users_u_email_key")
			expect(error.table).toBe("users_u")
			expect(error.sqlState).toBe("23505")
			expect(error.cause).toBeInstanceOf(Db.DatabaseError)
		}),
	)

	it.effect("a missing referenced row is ForeignKeyViolation", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`CREATE TABLE orgs_f (id int4 PRIMARY KEY)`)
			yield* Db.execute(
				Db.sql`CREATE TABLE units_f (id int4 PRIMARY KEY, org_id int4 CONSTRAINT units_f_org_fk REFERENCES orgs_f (id))`,
			)
			const error = yield* Effect.flip(Db.execute(Db.sql`INSERT INTO units_f VALUES (${1}, ${9})`).pipe(Db.refineConstraints))
			expect(error).toBeInstanceOf(Db.ForeignKeyViolation)
			expect(error).toMatchObject({ constraint: "units_f_org_fk", table: "units_f", sqlState: "23503" })
		}),
	)

	it.effect("NULL in a NOT NULL column is NotNullViolation with the column", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`CREATE TABLE tours_n (id int4 PRIMARY KEY, starts_at timestamptz NOT NULL)`)
			const error = yield* Effect.flip(Db.execute(Db.sql`INSERT INTO tours_n VALUES (${1}, ${null})`).pipe(Db.refineConstraints))
			expect(error).toBeInstanceOf(Db.NotNullViolation)
			expect(error).toMatchObject({ table: "tours_n", column: "starts_at", sqlState: "23502" })
		}),
	)

	it.effect("a row that fails a CHECK is CheckViolation with the constraint name", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`CREATE TABLE rents_c (id int4 PRIMARY KEY, cents int4 CONSTRAINT rents_c_positive CHECK (cents > 0))`)
			const error = yield* Effect.flip(Db.execute(Db.sql`INSERT INTO rents_c VALUES (${1}, ${-5})`).pipe(Db.refineConstraints))
			expect(error).toBeInstanceOf(Db.CheckViolation)
			expect(error).toMatchObject({ constraint: "rents_c_positive", table: "rents_c", sqlState: "23514" })
		}),
	)

	it.effect("a deferred foreign key found at COMMIT is ForeignKeyViolation too", () =>
		Effect.gen(function* () {
			yield* Db.execute(Db.sql`CREATE TABLE orgs_d (id int4 PRIMARY KEY)`)
			yield* Db.execute(
				Db.sql`CREATE TABLE units_d (id int4, org_id int4 CONSTRAINT units_d_org_fk REFERENCES orgs_d (id) DEFERRABLE INITIALLY DEFERRED)`,
			)
			const error = yield* Effect.flip(
				Db.transaction(Db.execute(Db.sql`INSERT INTO units_d VALUES (${1}, ${9})`)).pipe(Db.refineConstraints),
			)
			expect(error).toBeInstanceOf(Db.ForeignKeyViolation)
			expect(error).toMatchObject({ constraint: "units_d_org_fk", sqlState: "23503" })
			expect((error as Db.ForeignKeyViolation).cause).toBeInstanceOf(Db.TransactionCommitFailed)
		}),
	)

	it.effect("every other failure passes through unchanged", () =>
		Effect.gen(function* () {
			const syntax = yield* Effect.flip(Db.execute({ sql: "SELEC 1" }).pipe(Db.refineConstraints))
			expect(syntax).toBeInstanceOf(Db.DatabaseError)
			const domain = new Error("domain")
			expect(yield* Effect.flip(Effect.fail(domain).pipe(Db.refineConstraints))).toBe(domain)
		}),
	)
})

// SQLite reports each kind by its extended result code (node:sqlite keeps it
// as `errcode`; D1 only in its message). SQLite names no unique index, so a
// violation carries the table and, for one column, the column.
const SQLITE_SCHEMA = [
	"PRAGMA foreign_keys = ON",
	"CREATE TABLE orgs (id INTEGER PRIMARY KEY)",
	"CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, org_id INTEGER REFERENCES orgs (id), cents INTEGER CONSTRAINT positive CHECK (cents > 0), a TEXT, b TEXT, UNIQUE (a, b))",
	"INSERT INTO users (id, email, cents, a, b) VALUES (1, 'a@x', 1, 'p', 'q')",
]

const sqliteViolations = (db: Db.DatabaseApi) =>
	Effect.gen(function* () {
		for (const sql of SQLITE_SCHEMA) yield* db.execute({ sql })
		const violation = (sql: string) => Effect.flip(db.execute({ sql }).pipe(Db.refineConstraints))
		return {
			unique: yield* violation("INSERT INTO users (id, email, cents) VALUES (2, 'a@x', 1)"),
			primaryKey: yield* violation("INSERT INTO users (id, email, cents) VALUES (1, 'b@x', 1)"),
			composite: yield* violation("INSERT INTO users (id, email, cents, a, b) VALUES (3, 'c@x', 1, 'p', 'q')"),
			notNull: yield* violation("INSERT INTO users (id, email, cents) VALUES (4, NULL, 1)"),
			check: yield* violation("INSERT INTO users (id, email, cents) VALUES (5, 'd@x', -5)"),
			foreignKey: yield* violation("INSERT INTO users (id, email, cents, org_id) VALUES (6, 'e@x', 1, 9)"),
			other: yield* violation("SELEC 1"),
		}
	})

const expectSqliteViolations = (seen: Effect.Success<ReturnType<typeof sqliteViolations>>) => {
	expect(seen.unique).toBeInstanceOf(Db.UniqueViolation)
	expect(seen.unique).toMatchObject({ table: "users", column: "email" })
	expect(seen.unique).not.toHaveProperty("constraint")
	expect(seen.primaryKey).toBeInstanceOf(Db.UniqueViolation)
	expect(seen.primaryKey).toMatchObject({ table: "users", column: "id" })
	expect(seen.composite).toBeInstanceOf(Db.UniqueViolation)
	expect(seen.composite).toMatchObject({ table: "users" })
	expect(seen.composite).not.toHaveProperty("column")
	expect(seen.notNull).toBeInstanceOf(Db.NotNullViolation)
	expect(seen.notNull).toMatchObject({ table: "users", column: "email" })
	expect(seen.check).toBeInstanceOf(Db.CheckViolation)
	expect(seen.check).toMatchObject({ constraint: "positive" })
	expect(seen.foreignKey).toBeInstanceOf(Db.ForeignKeyViolation)
	expect(seen.other).toBeInstanceOf(Db.DatabaseError)
}

describe("constraint violations on SQLite", () => {
	it.effect("node:sqlite: each kind is its tagged error", () =>
		Effect.gen(function* () {
			const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: SQLite.sqliteDialect })
			expectSqliteViolations(yield* sqliteViolations(db))
		}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
	)

	it.effect("node:sqlite: a deferred foreign key found at COMMIT is ForeignKeyViolation", () =>
		Effect.gen(function* () {
			const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: SQLite.sqliteDialect })
			yield* db.execute({ sql: "PRAGMA foreign_keys = ON" })
			yield* db.execute({ sql: "CREATE TABLE orgs (id INTEGER PRIMARY KEY)" })
			yield* db.execute({ sql: "CREATE TABLE units (id INTEGER, org_id INTEGER REFERENCES orgs (id) DEFERRABLE INITIALLY DEFERRED)" })
			const error = yield* Effect.flip(db.transaction(db.execute({ sql: "INSERT INTO units VALUES (1, 9)" })).pipe(Db.refineConstraints))
			expect(error).toBeInstanceOf(Db.ForeignKeyViolation)
			expect((error as Db.ForeignKeyViolation).cause).toBeInstanceOf(Db.TransactionCommitFailed)
		}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
	)

	it("D1: each kind is its tagged error", async () => {
		const mf = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('constraint test') } }",
			compatibilityDate: "2026-07-01",
			d1Databases: ["DB"],
		})
		try {
			const binding = await mf.getD1Database("DB")
			const seen = await Effect.runPromise(
				Effect.gen(function* () {
					return yield* sqliteViolations(Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: SQLite.d1Dialect }))
				}).pipe(Effect.provide(D1Client.layer({ db: binding }))),
			)
			expectSqliteViolations(seen)
		} finally {
			await mf.dispose()
		}
	}, 30_000)
})
