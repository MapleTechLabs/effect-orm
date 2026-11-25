// Constraint violations as typed errors on MySQL 8.4 and MariaDB 11.4, through
// @effect/sql-mysql2, live when EFFECT_ORM_MYSQL_URL / EFFECT_ORM_MARIADB_URL are set.
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { Effect, Redacted } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Db from "../database"
import * as MySQL from "../mysql"

const servers = [
	["mysql", process.env.EFFECT_ORM_MYSQL_URL, MySQL.mysqlDialect],
	["mariadb", process.env.EFFECT_ORM_MARIADB_URL, MySQL.mariadbDialect],
] as const

for (const [name, url, dialect] of servers) {
	describe.skipIf(url === undefined)(`constraint violations on ${name}`, () => {
		const orgs = `orgs_${name}_${process.pid}`
		const units = `units_${name}_${process.pid}`
		const run = <A, E>(body: (db: Db.DatabaseApi<"mysql">) => Effect.Effect<A, E>) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const db = Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect })
					const drop = Effect.orDie(
						Effect.andThen(db.execute({ sql: `DROP TABLE IF EXISTS \`${units}\`` }), db.execute({ sql: `DROP TABLE IF EXISTS \`${orgs}\`` })),
					)
					yield* drop
					yield* db.execute({ sql: `CREATE TABLE \`${orgs}\` (id INT PRIMARY KEY, email VARCHAR(64) NOT NULL, CONSTRAINT \`${orgs}_email_key\` UNIQUE (email))` })
					yield* db.execute({
						sql: `CREATE TABLE \`${units}\` (id INT PRIMARY KEY, org_id INT NOT NULL, seats INT NOT NULL, CONSTRAINT \`${units}_org_fk\` FOREIGN KEY (org_id) REFERENCES \`${orgs}\` (id), CONSTRAINT \`${units}_seats_positive\` CHECK (seats > 0))`,
					})
					return yield* body(db).pipe(Effect.ensuring(drop))
				}).pipe(Effect.provide(MysqlClient.layer({ url: Redacted.make(`${url}${url?.includes("?") ? "&" : "?"}timezone=Z`) }))),
			)
		const violation = <A>(db: Db.DatabaseApi<"mysql">, sql: string) =>
			Effect.flip(Db.refineConstraints(db.execute({ sql }))) as Effect.Effect<Db.ConstraintViolation | Db.DatabaseError, A>

		it("reads each kind from the server's error number, with the names its message gives", async () => {
			const seen = await run((db) =>
				Effect.gen(function* () {
					yield* db.execute({ sql: `INSERT INTO \`${orgs}\` VALUES (1, 'a@x')` })
					yield* db.execute({ sql: `INSERT INTO \`${units}\` VALUES (1, 1, 2)` })
					return {
						duplicate: yield* violation(db, `INSERT INTO \`${orgs}\` VALUES (2, 'a@x')`),
						missingParent: yield* violation(db, `INSERT INTO \`${units}\` VALUES (2, 9, 2)`),
						referenced: yield* violation(db, `DELETE FROM \`${orgs}\` WHERE id = 1`),
						nullColumn: yield* violation(db, `INSERT INTO \`${units}\` VALUES (3, 1, NULL)`),
						leftOut: yield* violation(db, `INSERT INTO \`${units}\` (id, org_id) VALUES (4, 1)`),
						check: yield* violation(db, `INSERT INTO \`${units}\` VALUES (5, 1, 0)`),
						syntax: yield* violation(db, `INSERT INTO \`${units}\` VALUES (`),
						// The duplicated value is user input: it cannot name the key, and a newline in it
						// does not lose the name (DatabaseError keeps the message's first line only).
						spoofed: yield* Effect.andThen(
							db.execute({ sql: `INSERT INTO \`${orgs}\` VALUES (3, ?)`, parameters: ["x' for key 'evil"] }),
							violation(db, `INSERT INTO \`${orgs}\` VALUES (4, 'x'' for key ''evil')`),
						),
						multiline: yield* Effect.andThen(
							db.execute({ sql: `INSERT INTO \`${orgs}\` VALUES (5, ?)`, parameters: ["l1\nl2"] }),
							violation(db, `INSERT INTO \`${orgs}\` VALUES (6, 'l1\\nl2')`),
						),
					}
				}),
			)
			expect(seen.duplicate).toBeInstanceOf(Db.UniqueViolation)
			// MySQL 8 qualifies the key with its table; MariaDB names the key alone.
			expect(seen.duplicate).toMatchObject(
				name === "mysql"
					? { constraint: `${orgs}_email_key`, table: orgs, errorCode: 1062, sqlState: "23000" }
					: { constraint: `${orgs}_email_key`, errorCode: 1062, sqlState: "23000" },
			)
			expect(seen.missingParent).toBeInstanceOf(Db.ForeignKeyViolation)
			expect(seen.missingParent).toMatchObject({ constraint: `${units}_org_fk`, table: units, errorCode: 1452 })
			expect(seen.referenced).toBeInstanceOf(Db.ForeignKeyViolation)
			expect(seen.referenced).toMatchObject({ constraint: `${units}_org_fk`, table: units, errorCode: 1451 })
			expect(seen.nullColumn).toBeInstanceOf(Db.NotNullViolation)
			expect(seen.nullColumn).toMatchObject({ column: "seats", errorCode: 1048 })
			expect(seen.leftOut).toBeInstanceOf(Db.NotNullViolation)
			expect(seen.leftOut).toMatchObject({ column: "seats", errorCode: 1364 })
			expect(seen.check).toBeInstanceOf(Db.CheckViolation)
			expect(seen.check).toMatchObject(
				name === "mysql" ? { constraint: `${units}_seats_positive`, errorCode: 3819 } : { constraint: `${units}_seats_positive`, table: units, errorCode: 4025 },
			)
			for (const spoof of [seen.spoofed, seen.multiline]) {
				expect(spoof).toBeInstanceOf(Db.UniqueViolation)
				expect(spoof).toMatchObject({ constraint: `${orgs}_email_key` })
			}
			// Not a constraint: it stays a DatabaseError, now with the server's number.
			expect(seen.syntax).toBeInstanceOf(Db.DatabaseError)
			expect(seen.syntax).toMatchObject({ errorCode: 1064, sqlState: "42000" })
		})
	})
}
