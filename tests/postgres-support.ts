import type { PGlite } from "@electric-sql/pglite"
import { Effect } from "effect"
import type * as CH from "@maple-dev/effect-orm/clickhouse"

/** Run the compiled SQL with its bound parameters and decode through the query's own codec. */
export const runOn = Effect.fn("runOn")(function* <Output>(db: PGlite, compiled: CH.CompiledQuery<Output>) {
	const result = yield* Effect.promise(() => db.query<Record<string, unknown>>(compiled.sql, [...compiled.parameters])).pipe(
		Effect.tapDefect(() => Effect.logError(compiled.sql)),
	)
	return yield* compiled.decodeRows(result.rows)
})
