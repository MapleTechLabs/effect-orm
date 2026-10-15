// `effect-orm pull`: write a schema module from the database `config.driver`
// connects to, so an existing database starts with definitions that match it.
// `generate --baseline` then records them as the starting point.

import { mkdir, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Effect } from "effect"
import { introspectClickHouse } from "../migrate/introspect"
import { renderClickHouseSchema } from "./codegen"
import { io, KitError, type KitConfig } from "./generate"

export interface PullOptions {
	/** The file to write. */
	readonly out: string
	/** Only these tables. Default: every one. */
	readonly tables?: ReadonlyArray<string>
	/** Overwrite `out` when it exists. */
	readonly force?: boolean
}

export interface PullResult {
	readonly written: string
	/** Tables written with their DDL. */
	readonly tables: ReadonlyArray<string>
	/** Tables written as `external: true`: queried, never migrated. */
	readonly external: ReadonlyArray<string>
	/** What the file leaves out or could not type, one line each; also in its header. */
	readonly review: ReadonlyArray<string>
}

/** `effect-orm pull`. ClickHouse only, for now. */
export const pull = (config: KitConfig, cwd: string, options: PullOptions) =>
	Effect.gen(function* () {
		if ((config.dialect ?? "clickhouse") !== "clickhouse") {
			return yield* new KitError({ code: "unsupported", message: "pull reads ClickHouse only, for now" })
		}
		if (config.driver === undefined) {
			return yield* new KitError({ code: "config", message: "this command needs a database: set `driver` in the config" })
		}
		const path = resolve(cwd, options.out)
		const exists = yield* io(() => stat(path).then(() => true, () => false), `Cannot stat ${path}`)
		if (exists && options.force !== true) {
			return yield* new KitError({ code: "config", message: `${options.out} exists; pass --force to overwrite it` })
		}
		const schema = yield* introspectClickHouse(options.tables === undefined ? {} : { tables: options.tables }).pipe(
			Effect.provide(config.driver),
			Effect.mapError((error) => new KitError({ code: "io", message: `Cannot read the database: ${error instanceof Error ? error.message : String(error)}` })),
		)
		const { source, todos } = renderClickHouseSchema(schema)
		yield* io(() => mkdir(dirname(path), { recursive: true }), `Cannot create ${dirname(path)}`)
		yield* io(() => writeFile(path, source), `Cannot write ${path}`)
		return {
			written: path,
			tables: schema.entities.flatMap((e) => (e.kind === "table" ? [e.name] : [])),
			external: schema.external.map((t) => t.name),
			review: [...schema.notes, ...todos],
		} satisfies PullResult
	})
