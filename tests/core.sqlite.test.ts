// The core builder suite on SQLite (node:sqlite, in-process) and D1 (a local
// workerd binding through Miniflare), so both run on every `vitest run`.
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { contexts, coreCases, coreSkips, expectedFor } from "./core-cases"
import { d1Database, sqliteDatabase } from "./sqlite-support"

const databases = { sqlite: sqliteDatabase(), d1: d1Database() }
afterAll(() => Promise.all(Object.values(databases).map((db) => db.close())))

for (const dialect of ["sqlite", "d1"] as const) {
	describe(`core builder suite on ${dialect}`, () => {
		for (const fixture of coreCases) {
			if (fixture.rejects?.[dialect] || Object.hasOwn(coreSkips[dialect], fixture.id)) continue
			it.effect(fixture.id, () =>
				Effect.gen(function* () {
					const compiled = fixture.build(contexts[dialect])
					if (fixture.metadata) expect(compiled).toMatchObject(fixture.metadata)
					const wire = yield* Effect.promise(() => databases[dialect].query(compiled.sql, compiled.parameters))
					const rows = yield* compiled.decodeRows(wire)
					expect(rows, compiled.sql).toEqual(expectedFor(fixture, dialect))
				}),
			)
		}
	})
}
