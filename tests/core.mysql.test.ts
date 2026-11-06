// The core builder suite on MySQL 8.4 and MariaDB 11.4, live when
// EFFECT_ORM_MYSQL_URL / EFFECT_ORM_MARIADB_URL are set (CI runs both).
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { contexts, coreCases, coreSkips, expectedFor } from "./core-cases"
import { mariadbServer, mysqlDatabase, mysqlServer } from "./mysql-support"

const servers = { mysql: mysqlServer, mariadb: mariadbServer }
const databases = { mysql: mysqlDatabase(mysqlServer), mariadb: mysqlDatabase(mariadbServer) }
afterAll(() => Promise.all(Object.values(databases).map((db) => db.close())))

for (const dialect of ["mysql", "mariadb"] as const) {
	describe.skipIf(servers[dialect].url === undefined)(`core builder suite on ${dialect}`, () => {
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
