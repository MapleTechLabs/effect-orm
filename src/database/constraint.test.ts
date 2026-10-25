// Constraint violations as typed errors, against a real Postgres (PGlite) for
// the SQLSTATE side. ClickHouse's live CHECK test is in
// tests/database.clickhouse.test.ts; here its errors are built by hand.

import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { postgresDialect } from "../pg/dialect"
import * as Db from "../database"

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
