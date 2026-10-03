// `effect-orm generate`: diff the schema modules against the migrations folder
// and write the next migration. Offline: it never connects to a database.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Schema } from "effect"
import type { Layer } from "effect"
import { fromRecord, isStagingName, type LoadedMigration, type MigrationInput } from "../migrate/source"
import type { MigrationDriver } from "../migrate/driver"
import { diffSchemas, type Hint } from "../schema/diff"
import { labelOf, renderOp, type MigrationFile } from "../schema/ops"
import type { RenderOptions } from "../schema/render"
import { entitiesOf, isSchemaObject, makeSnapshot, serializeSnapshot, type SchemaObject } from "../schema/snapshot"
import { analyze, type GraphProblem } from "./graph"

export interface KitConfig {
	/** Modules whose exports include `defineTable` / `materializedView` values. */
	readonly schema: string | ReadonlyArray<string>
	/** The migrations folder. */
	readonly out: string
	/** How `migrate`, `status`, and `verify` render statements for this deployment. */
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
		return [...objects]
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
		return { migrations: migrations.length, leaves: analysis.leaves.map((l) => l.name) }
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
		const objects = yield* loadSchema(config, cwd)
		const next = yield* Effect.try({
			try: () => entitiesOf(objects),
			catch: (cause) => new KitError({ code: "config", message: cause instanceof Error ? cause.message : String(cause) }),
		})

		let file: MigrationFile | undefined
		let snapshotEntities = next
		if (options.custom === true) {
			snapshotEntities = analysis.base
		} else {
			const hints = [...(options.hints ?? [])]
			let diff = diffSchemas(analysis.base, next, hints)
			if (diff.unsupported.length > 0) {
				return yield* new KitError({
					code: "unsupported",
					message: "these changes need a table rebuild or a data rewrite, which generate does not write yet",
					details: diff.unsupported.map((u) => `${u.entity}: ${u.message}`),
				})
			}
			if (diff.missingHints.length > 0 && options.confirm !== undefined) {
				for (const hint of diff.missingHints) {
					if (yield* options.confirm(hint)) hints.push(hint)
				}
				diff = diffSchemas(analysis.base, next, hints)
			}
			if (diff.missingHints.length > 0) {
				return yield* new KitError({
					code: "missing_hints",
					message: "confirm data loss with --hints, or run in a terminal to be asked",
					details: [JSON.stringify(diff.missingHints)],
				})
			}
			if (diff.ops.length === 0) return { written: undefined, plan: [] } satisfies GenerateResult
			file = { version: "1", ops: diff.ops }
		}

		const snapshot = yield* makeSnapshot(snapshotEntities, analysis.baseIds)
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
						? writeFile(join(staging, "migration.sql"), "-- Custom SQL migration. Separate statements with a line holding only:\n-- --> statement-breakpoint\n")
						: writeFile(join(staging, "migration.json"), `${JSON.stringify(file, null, "\t")}\n`),
				`Cannot write ${dir}`,
			)
			yield* io(() => writeFile(join(staging, "snapshot.json"), serializeSnapshot(snapshot)), `Cannot write ${dir}`)
			yield* io(() => rename(staging, dir), `Cannot move ${staging} to ${dir}`)
		}).pipe(Effect.onError(() => Effect.promise(() => rm(staging, { recursive: true, force: true }).catch(() => undefined))))

		const plan = (file?.ops ?? []).map((op) => ({ label: labelOf(op), sql: renderOp(op, config.render) }))
		return { written: dir, plan } satisfies GenerateResult
	})
