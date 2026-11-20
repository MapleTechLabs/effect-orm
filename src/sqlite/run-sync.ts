// Running builder queries on a synchronous SQLite handle: Cloudflare Durable
// Object storage (`ctx.storage.sql`), whose `exec` returns rows at once and is
// no Effect `SqlClient`. Compiles for SQLite, binds, runs, decodes: what
// `Database.run` does, without an Effect around it.

import { Cause, Effect, Exit } from "effect"
import { fillDefaults, type RequirementsOf } from "../ch/client-defaults"
import { compileCHRaw, compileUnionRaw, type CompiledQuery } from "../ch/compile"
import type { DialectSatisfied, ParamsSatisfied, SourcesSatisfied } from "../ch/expr"
import { compiledUnsafe } from "../ch/failure"
import type { QueryParams } from "../ch/union"
import type { RowOf, Runnable, RunCheck } from "../database/database"
import { QueryBuilderDefect } from "../ch/errors"
import { sqliteDialect } from "./dialect"

/**
 * What `runSync` needs of a synchronous SQLite handle: workerd's `SqlStorage`
 * (`ctx.storage.sql`) has this shape, and a `node:sqlite` database wraps into
 * it in one line (`{ exec: (sql, ...values) => ({ toArray: () => db.prepare(sql).all(...values) }) }`).
 */
export interface SqlStorageLike {
	exec(query: string, ...bindings: Array<unknown>): { toArray(): Array<Record<string, unknown>> }
}

/** `unknown` when a write's client defaults need no service, so they can run here; otherwise why not. */
export type SyncDefaults<Q> = [RequirementsOf<Q>] extends [never]
	? unknown
	: { readonly clientDefaultsNeedServices: "this write's defaultFn / onUpdate need services; run it with Database.run, or pass every such column" }

/** The thrown value of a failed Effect: its error, or its defect. */
const orThrow = <A>(exit: Exit.Exit<A, unknown>): A => {
	if (Exit.isSuccess(exit)) return exit.value
	throw Cause.squash(exit.cause)
}

/**
 * Compile `query` for SQLite, run it on `storage`, and decode its rows, all
 * synchronously: `Database.run` for Durable Object storage. A write returns
 * its RETURNING rows, or none without `returning`. A write's client defaults
 * (`defaultFn` / `onUpdate`) run first, and must be synchronous Effects that
 * need no service. Throws the `QueryBuilderError`, the
 * `CompiledQueryDecodeError` or the storage's own error.
 *
 * ```ts
 * const rows = SQLite.runSync(ctx.storage.sql, SQLite.from(Jobs).select().where(($) => [$.id.eq(id)]))
 * ```
 */
export function runSync<Q extends Runnable, const Given extends object = {}>(
	storage: SqlStorageLike,
	query: Q &
		RunCheck<Q> &
		SyncDefaults<Q> &
		ParamsSatisfied<QueryParams<Q>, Given> &
		DialectSatisfied<QueryParams<Q>, "sqlite"> &
		SourcesSatisfied<QueryParams<Q>>,
	params?: Given,
): ReadonlyArray<RowOf<Q>> {
	const runnable = query as Runnable
	const values = (params ?? {}) as Record<string, unknown>
	const compiled: CompiledQuery<RowOf<Q>, any> = (() => {
		if ("decodeRows" in runnable) {
			if (runnable.dialect !== undefined && runnable.dialect !== sqliteDialect.name) {
				throw new QueryBuilderDefect({
					message: `runSync: a query compiled for ${runnable.dialect} cannot run on SQLite storage; pass the query instead of compiling it`,
				})
			}
			return runnable as CompiledQuery<RowOf<Q>, any>
		}
		const filled = orThrow(Effect.runSyncExit(fillDefaults(runnable) as Effect.Effect<Runnable>))
		return "_tag" in filled && filled._tag === "CHUnionQuery"
			? compiledUnsafe(() => compileUnionRaw(filled as never, values, { dialect: sqliteDialect }))
			: compiledUnsafe(() => compileCHRaw(filled as never, values, { dialect: sqliteDialect }))
	})()
	const rows = storage.exec(compiled.sql, ...compiled.parameters).toArray()
	if (compiled.kind !== "select" && compiled.returning === undefined) return []
	return orThrow(Effect.runSyncExit(compiled.decodeRows(rows)))
}
