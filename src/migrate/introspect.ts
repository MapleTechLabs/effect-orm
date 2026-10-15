// Reading a live ClickHouse database: the catalog rows `verify` compares, and
// the same rows as entities, for `effect-orm pull`.
//
// The entities are written the way a `table` definition would produce them,
// so a definition generated from them (`kit/codegen.ts`) yields them back
// exactly: a key is split into its parts and rejoined as `renderKey` joins
// them, and an engine loses its `Replicated` / `Shared` prefix and Keeper
// arguments, which are a render option here. Keys come from `engine_full`,
// as the table was declared; expressions keep the server's own text.
//
// Only what the entity model holds is read into entities. A table with an
// engine outside the MergeTree family, `Null` and `Memory` (a view, a
// dictionary, `Distributed`, `Kafka`), or with a name that is not a plain
// identifier, comes back as an external table, with its columns only. What a
// managed table has beyond the model (a sampling key, an `EPHEMERAL` column)
// is reported in `notes`, and so is every materialized view: its body is a
// query-DSL value, which SQL text cannot be turned into.

import { Effect } from "effect"
import type { ColumnDefault, ColumnEntity, EngineSpec, IndexEntity, SchemaEntity, TableEntity } from "../schema/entities"
import { sortEntities } from "../schema/entities"
import { MigrationDriver } from "./driver"
import type { MigrateSqlError } from "./errors"
import { LEDGER_TABLES } from "./ledger"

export type CatalogRow = Readonly<Record<string, unknown>>

/** The rows of `system.tables`, `system.columns` and `system.data_skipping_indices` for the current database. */
export interface ClickHouseCatalog {
	readonly database: string
	readonly tables: ReadonlyArray<CatalogRow>
	readonly columns: ReadonlyArray<CatalogRow>
	readonly indexes: ReadonlyArray<CatalogRow>
}

export const readClickHouseCatalog: Effect.Effect<ClickHouseCatalog, MigrateSqlError, MigrationDriver> = Effect.gen(function* () {
	const driver = yield* MigrationDriver
	const database = String((yield* driver.query("SELECT currentDatabase() AS db"))[0]?.db ?? "default")
	const tables = yield* driver.query(
		`SELECT name, engine, engine_full, sorting_key, partition_key, primary_key, sampling_key, as_select, create_table_query, comment FROM system.tables WHERE database = currentDatabase() AND NOT is_temporary AND NOT startsWith(name, '.inner') ORDER BY name`,
	)
	const columns = yield* driver.query(
		`SELECT table, name, type, default_kind, default_expression, compression_codec, comment, position FROM system.columns WHERE database = currentDatabase() ORDER BY table, position`,
	)
	const indexes = yield* driver.query(
		`SELECT table, name, type_full, expr, granularity FROM system.data_skipping_indices WHERE database = currentDatabase() ORDER BY table, name`,
	)
	return { database, tables, columns, indexes }
})

// SQL text, split at depth zero

/**
 * Split `text` wherever `at` matches outside parentheses, brackets and quotes.
 * `at` is tried at every top-level position and returns the length it
 * consumed, or 0.
 */
const splitTopLevel = (text: string, at: (rest: string) => number): Array<string> => {
	const parts: Array<string> = []
	let depth = 0
	let quote: string | undefined
	let start = 0
	for (let i = 0; i < text.length; i++) {
		const char = text[i]!
		if (quote !== undefined) {
			if (char === "\\") i++
			else if (char === quote) quote = undefined
			continue
		}
		if (char === "'" || char === '"' || char === "`") quote = char
		else if (char === "(" || char === "[") depth++
		else if (char === ")" || char === "]") depth--
		else if (depth === 0) {
			const length = at(text.slice(i))
			if (length > 0) {
				parts.push(text.slice(start, i))
				start = i + length
				i = start - 1
			}
		}
	}
	parts.push(text.slice(start))
	return parts
}

/** `a, f(b, c), d` as `["a", "f(b, c)", "d"]`; empty text is no parts. */
export const splitList = (text: string): Array<string> =>
	text.trim().length === 0 ? [] : splitTopLevel(text, (rest) => (rest[0] === "," ? 1 : 0)).map((part) => part.trim())

/** `Name(args)` as its name and argument list; `Name` alone has no arguments. */
export const splitCall = (text: string): { readonly name: string; readonly args: ReadonlyArray<string> | undefined } => {
	const trimmed = text.trim()
	const open = trimmed.indexOf("(")
	if (open < 0 || !trimmed.endsWith(")")) return { name: trimmed, args: undefined }
	return { name: trimmed.slice(0, open).trim(), args: splitList(trimmed.slice(open + 1, -1)) }
}

const CLAUSES = ["PARTITION BY", "PRIMARY KEY", "ORDER BY", "SAMPLE BY", "TTL", "SETTINGS"] as const
type Clause = (typeof CLAUSES)[number]

/** `engine_full` as its engine and the clauses after it. */
export const splitEngineFull = (engineFull: string): { readonly engine: string; readonly clauses: Partial<Record<Clause, string>> } => {
	const found: Array<Clause> = []
	const parts = splitTopLevel(engineFull, (rest) => {
		for (const clause of CLAUSES) {
			if (rest.startsWith(` ${clause} `)) {
				found.push(clause)
				return clause.length + 2
			}
		}
		return 0
	})
	const clauses: Partial<Record<Clause, string>> = {}
	found.forEach((clause, i) => {
		clauses[clause] = parts[i + 1]!.trim()
	})
	return { engine: parts[0]!.trim(), clauses }
}

const isQuoted = (text: string): boolean => text.startsWith("'") && text.endsWith("'")

/** An engine as the schema writes it: no `Replicated` / `Shared` prefix, no Keeper path and replica name. */
export const engineSpecOf = (engine: string): EngineSpec => {
	const call = splitCall(engine)
	const name = call.name.replace(/^`(.*)`$/, "$1")
	const args = call.args ?? []
	const shared = /^(Replicated|Shared)(?=\w*MergeTree$)/.exec(name)
	if (shared === null) return { family: name, params: args }
	const keeper = args.length >= 2 && isQuoted(args[0]!) && isQuoted(args[1]!) ? 2 : 0
	return { family: name.slice(shared[0].length), params: args.slice(keeper) }
}

/** Whether `table` can declare the engine; the rest are external tables. */
export const isModeledEngine = (family: string): boolean => family.endsWith("MergeTree") || family === "Null" || family === "Memory"

/** A key as `renderKey` writes one: a single part bare, several in parentheses. */
export const keyText = (parts: ReadonlyArray<string>): string => (parts.length === 1 ? parts[0]! : `(${parts.join(", ")})`)

/** A key's parts: `(a, f(b))` is two, `a` and `(a + b) * c` one. The inverse of `keyText`. */
export const keyParts = (text: string): Array<string> => {
	const trimmed = text.trim()
	if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return [trimmed]
	let depth = 0
	for (let i = 0; i < trimmed.length; i++) {
		if (trimmed[i] === "(") depth++
		else if (trimmed[i] === ")" && --depth === 0 && i < trimmed.length - 1) return [trimmed]
	}
	return splitList(trimmed.slice(1, -1))
}

const keyOf = (clause: string | undefined): string | null =>
	clause === undefined ? null : clause === "tuple()" ? "tuple()" : keyText(keyParts(clause))

/** `index_granularity = 8192` is the default the server writes into every MergeTree table's settings. */
const DEFAULT_SETTINGS: Readonly<Record<string, string>> = { index_granularity: "8192" }

const settingsOf = (text: string | undefined): Record<string, string> => {
	const settings: Record<string, string> = {}
	for (const part of splitList(text ?? "")) {
		const eq = part.indexOf("=")
		if (eq < 0) continue
		const key = part.slice(0, eq).trim()
		const value = part.slice(eq + 1).trim()
		if (DEFAULT_SETTINGS[key] !== value) settings[key] = value
	}
	return settings
}

const textOf = (value: unknown): string => (value === null || value === undefined ? "" : String(value))
const orNull = (text: string): string | null => (text.length === 0 ? null : text)

const DEFAULT_KINDS = new Set<string>(["DEFAULT", "MATERIALIZED", "ALIAS"])
/** The names a `table` definition accepts. */
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/

// Entities

/** A table `table` cannot declare, with the columns a query needs. */
export interface ExternalTable {
	readonly name: string
	readonly engine: string
	readonly columns: ReadonlyArray<ColumnEntity>
}

export interface IntrospectedSchema {
	readonly database: string
	/** Tables, their columns and their indexes, as `entitiesOf` would produce them. */
	readonly entities: ReadonlyArray<SchemaEntity>
	readonly external: ReadonlyArray<ExternalTable>
	/** What the database holds that the entities do not, one line each. */
	readonly notes: ReadonlyArray<string>
}

export interface IntrospectOptions {
	/** Only these tables. Default: every table but the migration ledger. */
	readonly tables?: ReadonlyArray<string>
}

/** The catalog as entities. Pure; see `introspectClickHouse`. */
export const entitiesFromCatalog = (catalog: ClickHouseCatalog, options: IntrospectOptions = {}): IntrospectedSchema => {
	const ledger = new Set<string>(Object.values(LEDGER_TABLES))
	const wanted = options.tables === undefined ? undefined : new Set(options.tables)
	const entities: Array<SchemaEntity> = []
	const external: Array<ExternalTable> = []
	const notes: Array<string> = []

	/** A managed table's columns; `EPHEMERAL` ones are left out, an insert-only input no query can read. */
	const columnsOf = (table: string): Array<ColumnEntity> =>
		catalog.columns
			.filter((row) => textOf(row.table) === table)
			.filter((row) => {
				const kind = textOf(row.default_kind)
				if (kind.length === 0 || DEFAULT_KINDS.has(kind)) return true
				notes.push(`${table}.${textOf(row.name)}: ${kind} columns are not modeled; left out`)
				return false
			})
			.map((row, position): ColumnEntity => {
				const kind = textOf(row.default_kind)
				const codec = textOf(row.compression_codec)
				return {
					kind: "column",
					table,
					name: textOf(row.name),
					position,
					type: textOf(row.type),
					default: kind.length === 0 ? null : { kind: kind as ColumnDefault["kind"], expr: textOf(row.default_expression) },
					codec: codec.length === 0 ? null : codec.replace(/^CODEC\((.*)\)$/s, "$1"),
					comment: orNull(textOf(row.comment)),
				}
			})
	const qualified = new RegExp(`\\b${catalog.database.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`, "g")

	for (const row of catalog.tables) {
		const name = textOf(row.name)
		if (ledger.has(name) || (wanted !== undefined && !wanted.has(name))) continue
		const engineName = textOf(row.engine)
		if (engineName === "MaterializedView") {
			const body = textOf(row.as_select).replace(qualified, "")
			notes.push(`${name}: materialized view not generated; write it with CH.materializedView. Its body: ${body}`)
			continue
		}
		const { engine, clauses } = splitEngineFull(textOf(row.engine_full))
		const spec = engineSpecOf(engine.length > 0 ? engine : engineName)
		if (!isModeledEngine(spec.family)) {
			external.push({ name, engine: engineName, columns: columnsOf(name) })
			continue
		}
		const unplain = [name, ...catalog.columns.filter((c) => textOf(c.table) === name).map((c) => textOf(c.name))].filter(
			(identifier) => !PLAIN.test(identifier),
		)
		if (unplain.length > 0) {
			notes.push(`${name}: generated as external; table definitions take plain identifiers only, not ${unplain.map((u) => JSON.stringify(u)).join(", ")}`)
			external.push({ name, engine: engineName, columns: columnsOf(name) })
			continue
		}
		const columns = columnsOf(name)
		const mergeTree = spec.family.endsWith("MergeTree")
		if (textOf(row.sampling_key).length > 0) notes.push(`${name}: SAMPLE BY ${textOf(row.sampling_key)} is not modeled; generated without it`)
		const table: TableEntity = {
			kind: "table",
			name,
			engine: spec,
			// From the clauses, not `sorting_key`: a VersionedCollapsingMergeTree's has its version appended.
			orderBy: mergeTree ? keyOf(clauses["ORDER BY"]) : null,
			partitionBy: clauses["PARTITION BY"] ?? null,
			primaryKey: mergeTree ? keyOf(clauses["PRIMARY KEY"]) : null,
			ttl: clauses.TTL ?? null,
			settings: settingsOf(clauses.SETTINGS),
			comment: orNull(textOf(row.comment)),
		}
		entities.push(table, ...columns)
		for (const index of catalog.indexes) {
			if (textOf(index.table) !== name) continue
			entities.push({
				kind: "index",
				table: name,
				name: textOf(index.name),
				expr: textOf(index.expr),
				type: textOf(index.type_full),
				granularity: Number(index.granularity),
			} satisfies IndexEntity)
		}
	}
	for (const name of wanted ?? []) {
		if (!catalog.tables.some((row) => textOf(row.name) === name)) notes.push(`${name}: no such table in ${catalog.database}`)
	}
	return { database: catalog.database, entities: sortEntities(entities), external, notes }
}

/** Read the current database as entities, for `effect-orm pull`. */
export const introspectClickHouse = (options: IntrospectOptions = {}): Effect.Effect<IntrospectedSchema, MigrateSqlError, MigrationDriver> =>
	Effect.map(readClickHouseCatalog, (catalog) => entitiesFromCatalog(catalog, options))
