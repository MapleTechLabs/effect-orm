// Loading and ordering migrations.
//
// A migration is a folder name plus its file: `migration.json` (generated ops,
// rendered when it runs) or `migration.sql` (hand-written, statements split on
// `--> statement-breakpoint`, the drizzle-kit separator). Its `snapshot.json`
// is optional at run time; `verify` needs it, and ordering prefers it. A
// drizzle-kit `snapshot.json` is recognized and kept aside, so a drizzle folder
// loads as it is.

import { Effect, FileSystem, Path, Schema } from "effect"
import { canonicalJson, sha256Hex, Snapshot, type SchemaDialect } from "../schema/entities"
import { MigrationFile, renderOp } from "../schema/ops"
import { renderPgOp } from "../schema/pg-ops"
import type { RenderOptions } from "../schema/render"
import { MigrateSourceError } from "./errors"

export const STATEMENT_BREAKPOINT = "--> statement-breakpoint"

/** `generate` writes a migration into `<name>.tmp-<pid>` and renames it into place. Readers skip these. */
export const isStagingName = (name: string): boolean => /\.tmp-\d+$/.test(name)

export interface MigrationInput {
	/** `migration.json` or `migration.sql` contents. */
	readonly migration: string
	readonly kind: "ops" | "sql"
	/** `snapshot.json` contents, when present. */
	readonly snapshot?: string
}

export interface LoadedMigration {
	readonly name: string
	readonly kind: "ops" | "sql"
	/** sha256 of the migration file, recorded when it runs and checked afterwards. */
	readonly hash: string
	readonly file: MigrationFile | undefined
	readonly sql: ReadonlyArray<string>
	readonly snapshot: Snapshot | undefined
	/**
	 * A `snapshot.json` another tool wrote (drizzle-kit's, in a folder being
	 * adopted), parsed but not interpreted. `snapshot` is `undefined` then.
	 */
	readonly foreignSnapshot: { readonly tool: "drizzle-kit"; readonly json: unknown } | undefined
}

export interface MigrationStep {
	/** Stable within a migration: `<op>.<statement>` or `<statement>`. */
	readonly id: string
	readonly sql: string
}

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(MigrationFile))
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot))

const load = (name: string, input: MigrationInput): Effect.Effect<LoadedMigration, MigrateSourceError> =>
	Effect.gen(function* () {
		const fail = (message: string) => (cause: unknown) => new MigrateSourceError({ migration: name, message, cause })
		const file = input.kind === "ops" ? yield* decodeFile(input.migration).pipe(Effect.mapError(fail("migration.json does not decode"))) : undefined
		const foreignSnapshot = input.snapshot === undefined ? undefined : foreignSnapshotOf(input.snapshot)
		const snapshot =
			input.snapshot === undefined || foreignSnapshot !== undefined
				? undefined
				: yield* decodeSnapshot(input.snapshot).pipe(Effect.mapError(fail("snapshot.json does not decode")))
		// Hash the decoded content for ops, so reformatting the JSON is not an edit.
		const hashed = file === undefined ? input.migration : canonicalJson(file)
		const hash = yield* Effect.promise(() => sha256Hex(hashed))
		const sql =
			input.kind === "sql"
				? input.migration
						.split(STATEMENT_BREAKPOINT)
						.map((statement) => statement.trim())
						.filter((statement) => statement.replace(/^\s*--.*$/gm, "").trim().length > 0)
				: []
		return { name, kind: input.kind, hash, file, sql, snapshot, foreignSnapshot }
	})

/** drizzle-kit's snapshot: `ddl` rather than `entities`, and its own `version`. */
const foreignSnapshotOf = (text: string): LoadedMigration["foreignSnapshot"] => {
	let json: unknown
	try {
		json = JSON.parse(text)
	} catch {
		return undefined
	}
	return typeof json === "object" && json !== null && "ddl" in json && Array.isArray(json.ddl) && !("entities" in json)
		? { tool: "drizzle-kit", json }
		: undefined
}

/**
 * Each migration's parent migrations, from its snapshot's `prevIds`. A custom
 * migration copies its parent's entities, so several migrations can share one
 * snapshot id; a parent link resolves to the last of them by name that sorts
 * before the child.
 */
export const migrationParents = (
	migrations: ReadonlyArray<LoadedMigration>,
): ReadonlyMap<LoadedMigration, ReadonlyArray<LoadedMigration>> => {
	const byName = [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	const bySnapshotId = new Map<string, Array<LoadedMigration>>()
	for (const m of byName) {
		if (m.snapshot === undefined) continue
		const list = bySnapshotId.get(m.snapshot.id) ?? []
		list.push(m)
		bySnapshotId.set(m.snapshot.id, list)
	}
	return new Map(
		byName.map((m) => [
			m,
			(m.snapshot?.prevIds ?? []).flatMap((id) => {
				const holders = bySnapshotId.get(id)?.filter((h) => h !== m && h.name < m.name) ?? []
				return holders.length > 0 ? [holders.at(-1)!] : []
			}),
		]),
	)
}

/**
 * Order migrations by their snapshots' parent links, breaking ties between
 * independent branches by name. Folder names alone are not enough: two
 * migrations generated in the same second sort by their random suffix.
 * Migrations without a snapshot keep their place by name.
 */
export const orderMigrations = (
	migrations: ReadonlyArray<LoadedMigration>,
): Effect.Effect<ReadonlyArray<LoadedMigration>, MigrateSourceError> =>
	Effect.gen(function* () {
		const byName = [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		const names = new Set<string>()
		for (const m of byName) {
			if (names.has(m.name)) return yield* new MigrateSourceError({ migration: m.name, message: "duplicate migration name" })
			names.add(m.name)
		}
		const parents = migrationParents(byName)
		const parentsOf = (m: LoadedMigration): ReadonlyArray<LoadedMigration> => parents.get(m) ?? []
		const ordered: Array<LoadedMigration> = []
		const placed = new Set<LoadedMigration>()
		const visiting = new Set<LoadedMigration>()
		const visit = (m: LoadedMigration): boolean => {
			if (placed.has(m)) return true
			if (visiting.has(m)) return false
			visiting.add(m)
			for (const parent of parentsOf(m)) if (!visit(parent)) return false
			visiting.delete(m)
			placed.add(m)
			ordered.push(m)
			return true
		}
		for (const m of byName) {
			if (!visit(m)) return yield* new MigrateSourceError({ migration: m.name, message: "snapshot parents form a cycle" })
		}
		return ordered
	})

/** Migrations from plain data: a bundler glob, an embedded record, a test. */
export const fromRecord = (
	record: Readonly<Record<string, MigrationInput>>,
): Effect.Effect<ReadonlyArray<LoadedMigration>, MigrateSourceError> =>
	Effect.forEach(Object.entries(record), ([name, input]) => load(name, input)).pipe(Effect.flatMap(orderMigrations))

/** Migrations from `<directory>/<name>/{migration.json | migration.sql, snapshot.json}`. */
export const fromFileSystem = (
	directory: string,
): Effect.Effect<ReadonlyArray<LoadedMigration>, MigrateSourceError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const fail = (migration: string, message: string) => (cause: unknown) =>
			new MigrateSourceError({ migration, message, cause })
		const entries = yield* fs.readDirectory(directory).pipe(Effect.mapError(fail(directory, "cannot read the migrations directory")))
		const record: Record<string, MigrationInput> = {}
		for (const name of entries) {
			if (isStagingName(name)) continue
			const dir = path.join(directory, name)
			const info = yield* fs.stat(dir).pipe(Effect.mapError(fail(name, "cannot stat")))
			if (info.type !== "Directory") continue
			const read = (file: string) =>
				fs.exists(path.join(dir, file)).pipe(
					Effect.flatMap((exists) => (exists ? Effect.map(fs.readFileString(path.join(dir, file)), (text): string | undefined => text) : Effect.succeed(undefined))),
					Effect.mapError(fail(name, `cannot read ${file}`)),
				)
			const json = yield* read("migration.json")
			const sql = yield* read("migration.sql")
			if (json !== undefined && sql !== undefined) {
				return yield* new MigrateSourceError({ migration: name, message: "has both migration.json and migration.sql" })
			}
			const migration = json ?? sql
			if (migration === undefined) continue
			const snapshot = yield* read("snapshot.json")
			record[name] = {
				migration,
				kind: json !== undefined ? "ops" : "sql",
				...(snapshot !== undefined ? { snapshot } : undefined),
			}
		}
		return yield* fromRecord(record)
	})

/** The statements a migration runs, rendered for this deployment. */
export const stepsOf = (migration: LoadedMigration, render: RenderOptions = {}): ReadonlyArray<MigrationStep> =>
	migration.file === undefined
		? migration.sql.map((sql, i) => ({ id: String(i), sql }))
		: "dialect" in migration.file
			? migration.file.ops.flatMap((op, i) => renderPgOp(op).map((sql, j) => ({ id: `${i}.${j}`, sql })))
			: migration.file.ops.flatMap((op, i) => renderOp(op, render).map((sql, j) => ({ id: `${i}.${j}`, sql })))

/**
 * The dialect a set of migrations is for, read from their snapshots and
 * generated files. `undefined` for a folder of hand-written SQL alone, which
 * says nothing about its database.
 */
export const dialectOf = (migrations: ReadonlyArray<LoadedMigration>): SchemaDialect | undefined => {
	for (const m of migrations) {
		if (m.snapshot !== undefined) return m.snapshot.dialect
		if (m.file !== undefined) return "dialect" in m.file ? "postgres" : "clickhouse"
		if (m.foreignSnapshot !== undefined) return "postgres"
	}
	return undefined
}
