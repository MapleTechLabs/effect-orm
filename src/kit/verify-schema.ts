// `effect-orm verify --schema`: the schema modules against a live database.
//
// `verify` compares the database with the snapshot of the last applied
// migration, so it needs the migrations folder and the ledger. This compares
// it with the table definitions as they stand: for a database that another
// tool migrates, or none, and for a CI check that the code and the database
// agree. The comparison itself is `verifySnapshot`, the one `verify` uses.

import { Effect, Layer } from "effect"
import { verifySnapshot, type Drift, type VerifyOptions } from "../migrate/verify"
import type { MigrateSourceError, MigrateSqlError } from "../migrate/errors"
import { ORIGIN_ID } from "../schema/entities"
import { makeSnapshot } from "../schema/snapshot"
import { KitError, schemaEntities, type KitConfig } from "./generate"

export interface VerifySchemaResult {
	readonly drift: ReadonlyArray<Drift>
}

/**
 * Compare the database behind `config.driver` with the definitions in
 * `config.schema`. Reads no migrations folder and no ledger; the ledger tables
 * are never reported.
 */
export const verifySchema = (
	config: KitConfig,
	cwd: string,
	options: Pick<VerifyOptions, "ignoreTables"> = {},
): Effect.Effect<VerifySchemaResult, KitError | MigrateSqlError | MigrateSourceError> =>
	Effect.gen(function* () {
		const driver = config.driver
		if (driver === undefined) {
			return yield* new KitError({ code: "config", message: "this command needs a database: set `driver` in the config" })
		}
		const entities = yield* schemaEntities(config, cwd)
		const snapshot = yield* makeSnapshot(entities, [ORIGIN_ID], config.dialect ?? "clickhouse")
		// Built apart, so a driver that cannot start fails as a KitError and the
		// comparison keeps its own typed errors.
		const context = yield* Layer.build(driver).pipe(
			Effect.mapError(
				(cause) => new KitError({ code: "config", message: `Cannot build the config's driver: ${cause instanceof Error ? cause.message : String(cause)}` }),
			),
		)
		const drift = yield* verifySnapshot(snapshot, options, "the schema modules").pipe(Effect.provideContext(context))
		return { drift }
	}).pipe(Effect.scoped)
