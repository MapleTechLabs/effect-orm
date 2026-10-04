// `effect-orm generate`: diff the schema modules against the migrations folder
// and write the next migration. Offline: it never connects to a database.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Schema } from "effect"
import type { Layer } from "effect"
import { fromRecord, isStagingName, type LoadedMigration, type MigrationInput } from "../migrate/source"
import type { MigrationDriver } from "../migrate/driver"
import { diffSchemas, type DiffResult, type Hint } from "../schema/diff"
import { fromDrizzleSnapshot } from "../schema/drizzle"
import { ORIGIN_ID, type AnySchemaEntity, type SchemaDialect, type SchemaEntity } from "../schema/entities"
import { labelOf, renderOp, type MigrationFile, type MigrationOp } from "../schema/ops"
import { diffPgSchemas } from "../schema/pg-diff"
import type { PgSchemaEntity } from "../schema/pg-entities"
import { labelOfPg, renderPgOp, type PgMigrationOp } from "../schema/pg-ops"
import type { RenderOptions } from "../schema/render"
import {
	dialectOfObject,
	entitiesOf,
	isSchemaObject,
	makeSnapshot,
	pgEntitiesOf,
	serializeSnapshot,
	type SchemaObject,
} from "../schema/snapshot"
import { analyze, type GraphProblem } from "./graph"

export interface KitConfig {
	/** The database this folder migrates. Default `clickhouse`. */
	readonly dialect?: SchemaDialect
	/** Modules whose exports include `defineTable` / `materializedView` (or `S.pg.table`) values. */
	readonly schema: string | ReadonlyArray<string>
	/** The migrations folder. */
	readonly out: string
	/** How `migrate`, `status`, and `verify` render ClickHouse statements for this deployment. */
	readonly render?: RenderOptions
	/** Needed by `migrate`, `status`, and `verify`. Build it from your `SqlClient`. */
	readonly driver?: Layer.Layer<MigrationDriver, unknown>
}

/** Typed identity, for `effect-orm.config.ts`. */
export const defineConfig = (config: KitConfig): KitConfig => config

/** Anything the kit could not do. `code` decides the CLI's exit status. */
export class KitError extends Schema.TaggedError<KitError>()("@maple-dev/effect-orm/KitError", {
	code: Schema.Literals(["config", "io", "check", "unsupported", "missing_hints"]),
	message: Schema.String,
	details: Schema.optional(Schema.Array(Schema.String)),
}) {}

const io = <A>(op: () => Promise<A>, message: string) =>
	Effect.tryPromise({ try: op, catch: (cause) => new KitError({ code: "io", message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}` }) })

/** Import every schema module and collect the definitions they export. */
export const loadSchema = (config: KitConfig, cwd: string): Effect.Effect<ReadonlyArray<SchemaObject>, KitError> =>
	Effect.gen(function* () {
		const paths = typeof config.schema === "string" ? [config.schema] : config.schema
		const objects = new Set<SchemaObject>()
		for (const path of paths) {
			const module = yield* io(
				() => import(pathToFileURL(resolve(cwd, path)).href) as Promise<Record<string, unknown>>,
				`Cannot import ${path} (TypeScript needs Bun, or Node with type stripping)`,
			)
			for (const value of Object.values(module)) if (isSchemaObject(value)) objects.add(value)
		}
		const dialect = config.dialect ?? "clickhouse"
		const mine = [...objects].filter((object) => dialectOfObject(object) === dialect)
		if (mine.length === 0 && objects.size > 0) {
			return yield* new KitError({
				code: "config",
				message: `the schema modules define no ${dialect} tables; set \`dialect\` in the config to the database they are for`,
			})
		}
		return mine
	})

/** Read `<out>/<name>/...` with node:fs. */
export const readMigrations = (out: string): Effect.Effect<ReadonlyArray<LoadedMigration>, KitError> =>
	Effect.gen(function* () {
		const exists = yield* io(() => stat(out).then(() => true, () => false), `Cannot stat ${out}`)
		if (!exists) return []
		const names = yield* io(() => readdir(out), `Cannot read ${out}`)
		const record: Record<string, MigrationInput> = {}
		const optional = (path: string) => readFile(path, "utf8").then((text): string | undefined => text, () => undefined)
		for (const name of names.sort()) {
			if (isStagingName(name)) continue
			const dir = join(out, name)
			const isDir = yield* io(() => stat(dir).then((s) => s.isDirectory()), `Cannot stat ${dir}`)
			if (!isDir) continue
			const json = yield* io(() => optional(join(dir, "migration.json")), `Cannot read ${dir}`)
			const sql = yield* io(() => optional(join(dir, "migration.sql")), `Cannot read ${dir}`)
			const snapshot = yield* io(() => optional(join(dir, "snapshot.json")), `Cannot read ${dir}`)
			const migration = json ?? sql
			if (migration === undefined) continue
			record[name] = { migration, kind: json !== undefined ? "ops" : "sql", ...(snapshot !== undefined ? { snapshot } : undefined) }
		}
		return yield* fromRecord(record).pipe(Effect.mapError((e) => new KitError({ code: "check", message: `${e.migration}: ${e.message}` })))
	})

const describeProblems = (problems: ReadonlyArray<GraphProblem>) => problems.map((p) => `${p.migration}: ${p.message}`)

/** `effect-orm check`. */
export const check = (config: KitConfig, cwd: string) =>
	Effect.gen(function* () {
		const migrations = yield* readMigrations(resolve(cwd, config.out))
		const analysis = yield* analyze(migrations)
		if (analysis.problems.length > 0) {
			return yield* new KitError({ code: "check", message: "the migrations folder is inconsistent", details: describeProblems(analysis.problems) })
		}
		return { migrations: migrations.length, leaves: analysis.leaves.map((l) => l.name), legacy: analysis.legacy.length }
	})

const ADJECTIVES = ["amber", "brisk", "calm", "deft", "eager", "fond", "gentle", "hardy", "keen", "lucid", "merry", "nimble", "quiet", "rapid", "steady", "tidy", "vivid", "witty"]
const NOUNS = ["badger", "comet", "delta", "ember", "falcon", "glacier", "harbor", "island", "juniper", "kestrel", "lantern", "meadow", "nebula", "otter", "prairie", "quartz", "river", "summit"]

const pick = <A>(list: ReadonlyArray<A>): A => list[Math.floor(Math.random() * list.length)]!

/** `YYYYMMDDHHMMSS` in UTC, bumped past any prefix already in use so two migrations never share a second. */
const timestamp = (now: Date, taken: ReadonlySet<string>): string => {
	let t = Math.floor(now.getTime() / 1000) * 1000
	for (;;) {
		const d = new Date(t)
		const p = (n: number, w = 2) => String(n).padStart(w, "0")
		const prefix = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
		if (!taken.has(prefix)) return prefix
		t += 1000
	}
}

export interface GenerateOptions {
	readonly name?: string
	readonly custom?: boolean
	readonly hints?: ReadonlyArray<Hint>
	/** Asked for each data-loss confirmation the hints do not cover. Absent: report them as missing. */
	readonly confirm?: (hint: Hint) => Effect.Effect<boolean>
	readonly now?: Date
	/**
	 * Adopt a folder another tool wrote, or a database that already exists:
	 * write a migration with no statements whose snapshot is the schema as it
	 * stands. `schema` takes it from the definitions; `drizzle` from the newest
	 * drizzle-kit snapshot in the folder, so the next `generate` shows every
	 * place the definitions and the database disagree.
	 */
	readonly baseline?: "schema" | "drizzle"
}

export interface GenerateResult {
	readonly written: string | undefined
	readonly plan: ReadonlyArray<{ readonly label: string; readonly sql: ReadonlyArray<string> }>
}

/** `effect-orm generate`. */
export const generate = (config: KitConfig, cwd: string, options: GenerateOptions = {}) =>
	Effect.gen(function* () {
		const out = resolve(cwd, config.out)
		const migrations = yield* readMigrations(out)
		const analysis = yield* analyze(migrations)
		if (analysis.problems.length > 0) {
			return yield* new KitError({ code: "check", message: "fix the migrations folder first", details: describeProblems(analysis.problems) })
		}
		if (options.name !== undefined && !/^[a-z0-9_]+$/.test(options.name)) {
			return yield* new KitError({ code: "config", message: "--name takes lowercase letters, digits, and underscores" })
		}
		const dialect = config.dialect ?? "clickhouse"
		if (analysis.dialect !== undefined && analysis.dialect !== dialect) {
			return yield* new KitError({ code: "config", message: `the migrations folder holds ${analysis.dialect} snapshots, but the config's dialect is ${dialect}` })
		}
		const adopting = analysis.leaves.length === 0 && analysis.legacy.length > 0
		if (options.baseline !== undefined && analysis.leaves.length > 0) {
			return yield* new KitError({ code: "config", message: "--baseline starts a folder's history; this one already has effect-orm snapshots" })
		}
		if (options.baseline === undefined && adopting && options.custom !== true) {
			return yield* new KitError({
				code: "config",
				message: `the folder has ${analysis.legacy.length} migrations from another tool and no effect-orm snapshot yet; run generate --baseline first (add --from-drizzle for a drizzle-kit folder)`,
			})
		}

		let file: MigrationFile | undefined
		let snapshotEntities: ReadonlyArray<AnySchemaEntity>
		let prevIds = analysis.baseIds
		if (options.baseline === "drizzle") {
			if (dialect !== "postgres") return yield* new KitError({ code: "config", message: "--from-drizzle needs dialect: \"postgres\"" })
			const source = [...analysis.legacy].reverse().find((m) => m.foreignSnapshot?.tool === "drizzle-kit")
			if (source === undefined) return yield* new KitError({ code: "config", message: "no drizzle-kit snapshot.json in the folder to start from" })
			const imported = fromDrizzleSnapshot(source.foreignSnapshot!.json)
			if (imported.unsupported.length > 0) {
				return yield* new KitError({
					code: "unsupported",
					message: `${source.name}/snapshot.json holds objects effect-orm cannot model yet`,
					details: imported.unsupported,
				})
			}
			snapshotEntities = imported.entities
			prevIds = [ORIGIN_ID]
		} else {
			const objects = yield* loadSchema(config, cwd)
			const next = yield* Effect.try({
				try: (): ReadonlyArray<AnySchemaEntity> => (dialect === "postgres" ? pgEntitiesOf(objects) : entitiesOf(objects)),
				catch: (cause) => new KitError({ code: "config", message: cause instanceof Error ? cause.message : String(cause) }),
			})
			snapshotEntities = next
			if (options.baseline === "schema") prevIds = [ORIGIN_ID]
			else if (options.custom === true) snapshotEntities = analysis.base
			else {
				const hints = [...(options.hints ?? [])]
				const diff = (): DiffResult<MigrationOp | PgMigrationOp> =>
					dialect === "postgres"
						? diffPgSchemas(analysis.base as ReadonlyArray<PgSchemaEntity>, next as ReadonlyArray<PgSchemaEntity>, hints)
						: diffSchemas(analysis.base as ReadonlyArray<SchemaEntity>, next as ReadonlyArray<SchemaEntity>, hints)
				let result = diff()
				if (result.unsupported.length > 0) {
					return yield* new KitError({
						code: "unsupported",
						message: "these changes need a table rebuild or a data rewrite, which generate does not write yet",
						details: result.unsupported.map((u) => `${u.entity}: ${u.message}`),
					})
				}
				if (result.missingHints.length > 0 && options.confirm !== undefined) {
					for (const hint of result.missingHints) {
						if (yield* options.confirm(hint)) hints.push(hint)
					}
					result = diff()
				}
				if (result.missingHints.length > 0) {
					return yield* new KitError({
						code: "missing_hints",
						message: "confirm data loss with --hints, or run in a terminal to be asked",
						details: [JSON.stringify(result.missingHints)],
					})
				}
				if (result.ops.length === 0) return { written: undefined, plan: [] } satisfies GenerateResult
				file =
					dialect === "postgres"
						? { version: "1", dialect: "postgres", ops: result.ops as ReadonlyArray<PgMigrationOp> }
						: { version: "1", ops: result.ops as ReadonlyArray<MigrationOp> }
			}
		}

		const snapshot = yield* makeSnapshot(snapshotEntities, prevIds, dialect)
		const taken = new Set(migrations.map((m) => m.name.slice(0, 14)))
		const name = `${timestamp(options.now ?? new Date(), taken)}_${options.name ?? `${pick(ADJECTIVES)}_${pick(NOUNS)}`}`
		const dir = join(out, name)
		const staging = `${dir}.tmp-${process.pid}`
		// Written aside and renamed into place, so a reader never sees half a migration.
		yield* Effect.gen(function* () {
			yield* io(() => mkdir(staging, { recursive: true }), `Cannot create ${staging}`)
			yield* io(
				() =>
					file === undefined
						? writeFile(
								join(staging, "migration.sql"),
								options.baseline !== undefined
									? "-- Baseline: the schema as it stood when effect-orm took over this folder. Runs nothing.\n"
									: "-- Custom SQL migration. Separate statements with a line holding only:\n-- --> statement-breakpoint\n",
							)
						: writeFile(join(staging, "migration.json"), `${JSON.stringify(file, null, "\t")}\n`),
				`Cannot write ${dir}`,
			)
			yield* io(() => writeFile(join(staging, "snapshot.json"), serializeSnapshot(snapshot)), `Cannot write ${dir}`)
			yield* io(() => rename(staging, dir), `Cannot move ${staging} to ${dir}`)
		}).pipe(Effect.onError(() => Effect.promise(() => rm(staging, { recursive: true, force: true }).catch(() => undefined))))

		const plan =
			file === undefined
				? []
				: "dialect" in file
					? file.ops.map((op) => ({ label: labelOfPg(op), sql: renderPgOp(op) }))
					: file.ops.map((op) => ({ label: labelOf(op), sql: renderOp(op, config.render) }))
		return { written: dir, plan } satisfies GenerateResult
	})
