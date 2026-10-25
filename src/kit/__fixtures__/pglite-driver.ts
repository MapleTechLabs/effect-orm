// A config `driver` for CLI tests: a fresh in-memory PGlite database that
// holds what `statements` create.

import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Migrate from "../../migrate"

export const pgliteDriver = (statements: ReadonlyArray<string>) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			for (const statement of statements) yield* sql.unsafe(statement)
		}),
	).pipe(Layer.provideMerge(Migrate.layerSqlClient()), Layer.provide(PgliteClient.layer({})))
