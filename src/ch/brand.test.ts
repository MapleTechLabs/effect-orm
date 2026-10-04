import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Schema } from "effect"
import * as CH from "./index"
import * as Db from "../database"
import * as PG from "../postgres"
import * as S from "../schema"
import { QueryBuilderError } from "./errors"

const OrgId = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("@maple/OrgId"))
const Cents = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand("Cents"))

const orgId = PG.brand(PG.text, OrgId)

const Accounts = PG.table("accounts", {
	columns: {
		org_id: orgId,
		id: PG.text,
		balance: PG.brand(PG.int8, Cents),
		owner: PG.nullable(orgId),
	},
	primaryKey: ["org_id", "id"],
})

const Live = Db.layerSqlClient({ dialect: PG.postgresDialect }).pipe(
	Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })),
)

describe("brand", () => {
	it("keeps the base type's SQL, wrapper tag and wire codec", () => {
		const balance = PG.brand(PG.int8, Cents)
		expect(balance.sql).toBe("int8")
		expect(PG.nullable(orgId)._tag).toBe("Nullable")
		expect(Accounts.ddl.columns.map((c) => [c.name, c.type, c.notNull])).toEqual([
			["org_id", "text", true],
			["id", "text", true],
			["balance", "bigint", true],
			["owner", "text", false],
		])
		// int8 arrives as a string from node-postgres; the base codec still reads it.
		expect(Schema.decodeUnknownSync(balance.schema)("1250")).toBe(1250)
		expect(() => Schema.decodeUnknownSync(balance.schema)("-1")).toThrow()
	})

	it("refuses a literal or a param value that fails the brand's checks", () => {
		const literal = Effect.runSync(
			Effect.exit(PG.compile(CH.from(Accounts).select("id").where(($) => [$.org_id.eq("" as typeof OrgId.Type)]), {})),
		)
		expect(Exit.isFailure(literal) && Exit.findErrorOption(literal)._tag === "Some").toBe(true)
		const param = Effect.runSync(
			Effect.exit(
				PG.compile(
					CH.from(Accounts)
						.select("id")
						.where(($) => [$.org_id.eq(CH.param.of(orgId, "orgId"))]),
					{ orgId: "" as typeof OrgId.Type },
				),
			),
		)
		expect(Exit.isFailure(param)).toBe(true)
		if (Exit.isFailure(param)) {
			const error = Exit.findErrorOption(param)
			expect(error._tag === "Some" && error.value instanceof QueryBuilderError).toBe(true)
		}
	})

	it.effect("round-trips branded values through Postgres", () =>
		Effect.gen(function* () {
			for (const statement of S.renderPgSchema(S.pgEntitiesOf([Accounts]))) yield* Db.execute(Db.sql.raw(statement))
			const org = OrgId.make("org_1")
			const inserted = yield* Db.run(
				CH.insertInto(Accounts)
					.values({ org_id: org, id: "a", balance: Cents.make(1250) })
					.returning("org_id", "balance", "owner"),
			)
			expect(inserted).toEqual([{ org_id: "org_1", balance: 1250, owner: null }])

			const rows = yield* Db.run(
				CH.from(Accounts)
					.select("id", "balance")
					.where(($) => [$.org_id.eq(CH.param.of(orgId, "orgId"))]),
				{ orgId: org },
			)
			expect(rows).toEqual([{ id: "a", balance: 1250 }])

			// A row that breaks the brand's checks is a decode error, not a silently wrong value.
			yield* Db.execute(Db.sql`INSERT INTO accounts (org_id, id, balance) VALUES ('', 'b', 5)`)
			const exit = yield* Effect.exit(Db.run(CH.from(Accounts).select("org_id")))
			expect(Exit.isFailure(exit)).toBe(true)
		}).pipe(Effect.provide(Live)),
	)
})
