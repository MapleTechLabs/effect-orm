// The core builder suite on Postgres 17 (PGlite, in-process), so it runs on every `vitest run`.
import { PGlite } from "@electric-sql/pglite"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { coreCases, coreSkips, expectedFor, postgresContext } from "./core-cases"
import { runOn } from "./postgres-support"

// PGlite 0.5 takes the session time zone from the host; the fixtures assume UTC.
const db = new PGlite({ postgresqlconf: "timezone = 'UTC'" })
afterAll(() => db.close())

describe("core builder suite on Postgres", () => {
	for (const fixture of coreCases) {
		if (fixture.rejects?.postgres || Object.hasOwn(coreSkips.postgres, fixture.id)) continue
		it.effect(fixture.id, () =>
			Effect.gen(function* () {
				const compiled = fixture.build(postgresContext)
				if (fixture.metadata) expect(compiled).toMatchObject(fixture.metadata)
				const rows = yield* runOn(db, compiled)
				expect(rows, compiled.sql).toEqual(expectedFor(fixture, "postgres"))
			}),
		)
	}
})
