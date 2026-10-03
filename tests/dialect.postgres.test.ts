// Every Postgres function and type fixture, executed on Postgres 17 (PGlite).
import { PGlite } from "@electric-sql/pglite"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { postgresCases } from "./dialect-cases.postgres"
import { runOn } from "./postgres-support"

// PGlite 0.5 takes the session time zone from the host; the fixtures assume UTC.
const db = new PGlite({ postgresqlconf: "timezone = 'UTC'" })
afterAll(() => db.close())

describe("postgres dialect fixtures", () => {
	for (const fixture of postgresCases) {
		it.effect(fixture.id, () =>
			Effect.gen(function* () {
				const compiled = fixture.build()
				expect(yield* runOn(db, compiled), compiled.sql).toEqual(fixture.expected)
			}),
		)
	}
})
