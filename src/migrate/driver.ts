// The migrator's only dependency: run a statement, read rows.
//
// The library never opens a connection. A caller provides a driver, most often
// built from the `SqlClient` they already use for queries. ClickHouse DDL must
// go through the client's command path (`asCommand` on
// `@effect/sql-clickhouse`): its query path asks for a JSON result, which a
// DDL statement does not have.

import { Context, Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { firstLine } from "../database/sql-error"
import { MigrateSqlError } from "./errors"

export interface MigrationDriverApi {
	/** Run a statement that returns no rows (DDL, INSERT). */
	readonly execute: (sql: string) => Effect.Effect<void, MigrateSqlError>
	/** Run a SELECT and return its rows as plain records. */
	readonly query: (sql: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, MigrateSqlError>
	/**
	 * Run an effect in one transaction: commit when it succeeds, roll back when
	 * it fails. Postgres migrations need it; ClickHouse has none to offer.
	 */
	readonly transaction?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | MigrateSqlError, R>
}

export class MigrationDriver extends Context.Service<MigrationDriver, MigrationDriverApi>()(
	"@maple-dev/effect-orm/MigrationDriver",
) {}

const sqlError = (sql: string) => (cause: unknown) => new MigrateSqlError({ message: firstLine(cause), sql, cause })

export interface FromSqlClientOptions {
	/**
	 * Wraps statements that return no rows. Pass the ClickHouse client's
	 * `asCommand`; leave unset for drivers whose query path accepts DDL.
	 */
	readonly command?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/**
 * A driver over an Effect `SqlClient`. Its `transaction` is the client's
 * `withTransaction`, which every statement the driver runs inside it joins.
 */
export const fromSqlClient = (sql: SqlClient.SqlClient, options: FromSqlClientOptions = {}): MigrationDriverApi => {
	const command = options.command ?? ((effect) => effect)
	return {
		transaction: (effect) => sql.withTransaction(effect).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(sqlError("BEGIN / COMMIT")(cause)))),
		execute: (text) => command(sql.unsafe(text)).pipe(Effect.asVoid, Effect.mapError(sqlError(text))),
		query: (text) =>
			sql.unsafe<Record<string, unknown>>(text).pipe(
				Effect.map((rows): ReadonlyArray<Record<string, unknown>> => rows),
				Effect.mapError(sqlError(text)),
			),
	}
}

/** A `MigrationDriver` layer over the `SqlClient` in context. */
export const layerSqlClient = (options: FromSqlClientOptions = {}): Layer.Layer<MigrationDriver, never, SqlClient.SqlClient> =>
	Layer.effect(
		MigrationDriver,
		Effect.gen(function* () {
			return fromSqlClient(yield* SqlClient.SqlClient, options)
		}),
	)
