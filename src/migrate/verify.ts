// Drift: the live schema against the snapshot of the last applied migration.
//
// Not against the code's latest schema: a database three migrations behind is
// behind, not drifted. Expressions and types are normalized by the server
// (`formatQuery`, `defaultValueOfTypeName`), so `INTERVAL 30 DAY` and
// `toIntervalDay(30)`, or `DateTime64` and `DateTime64(3)`, compare equal.
//
// Checked: tables, engine family, sorting/partition/primary keys, columns
// (type, default), skipping indexes, views (target and body). Not checked yet:
// TTL, codecs, settings, comments. The server rewrites those in ways that need
// more than a formatter to compare.

import { Effect } from "effect"
import { quoteClickHouseString } from "../sql/sql-fragment"
import type { SchemaDialect, ClickHouseSnapshot, ColumnEntity, IndexEntity, MaterializedViewEntity, TableEntity } from "../schema/entities"
import { MigrationDriver } from "./driver"
import type { MigrateSourceError, MigrateSqlError } from "./errors"
import { LEDGER_TABLES, readApplied } from "./ledger"
import { readPgApplied } from "./pg-ledger"
import { verifyPg, type PgVerifyOptions } from "./pg-verify"
import { dialectOf, type LoadedMigration } from "./source"

export interface Drift {
	readonly entity: string
	readonly problem:
		| "missing"
		| "unexpected"
		| "engine"
		| "sorting_key"
		| "partition_key"
		| "primary_key"
		| "type"
		| "not_null"
		| "identity"
		| "default"
		| "index"
		| "foreign_key"
		| "view_target"
		| "view_body"
	readonly expected?: string
	readonly actual?: string
}

export interface VerifyResult {
	/** The migration whose snapshot was compared, if any applied migration has one. */
	readonly against: string | undefined
	readonly drift: ReadonlyArray<Drift>
}

const q = quoteClickHouseString
const squash = (text: string): string => text.replace(/\s+/g, " ").trim()
const unwrapTuple = (key: string | null): string => {
	if (key === null || key === "tuple()") return ""
	const trimmed = key.trim()
	return trimmed.startsWith("(") && trimmed.endsWith(")") ? trimmed.slice(1, -1) : trimmed
}
const engineFamily = (engine: string): string => engine.replace(/^(Replicated|Shared)(?=\w*MergeTree$)/, "")

/** Server-normalized forms of SQL snippets, keyed by the input. */
const canonical = (driver: typeof MigrationDriver.Service, kind: "expr" | "query", inputs: ReadonlySet<string>) =>
	Effect.gen(function* () {
		const list = [...inputs].filter((s) => s.length > 0)
		const out = new Map<string, string>()
		if (list.length === 0) return out
		const wrap = kind === "expr" ? "concat('SELECT ', x)" : "x"
		const rows = yield* driver.query(
			`SELECT arrayMap(x -> coalesce(formatQueryOrNull(${wrap}), x), [${list.map(q).join(", ")}]) AS out`,
		)
		const formatted = rows[0]?.out
		list.forEach((input, i) => out.set(input, squash(Array.isArray(formatted) ? String(formatted[i] ?? input) : input)))
		return out
	})

const canonicalTypes = (driver: typeof MigrationDriver.Service, types: ReadonlySet<string>) =>
	Effect.gen(function* () {
		const list = [...types]
		const out = new Map<string, string>()
		for (const type of list) {
			// One query per type: an unknown or argument-only type fails alone and keeps its text.
			const rows = yield* driver
				.query(`SELECT toTypeName(defaultValueOfTypeName(${q(type)})) AS t`)
				.pipe(Effect.orElseSucceed(() => [{ t: type }]))
			out.set(type, squash(String(rows[0]?.t ?? type)))
		}
		return out
	})

export interface VerifyOptions extends PgVerifyOptions {
	/** Read from the migrations when omitted. */
	readonly dialect?: SchemaDialect
}

/**
 * Compare the database with the snapshot of the last applied migration. The
 * dialect comes from the snapshots; see `pg-verify.ts` for how Postgres is
 * compared.
 */
export const verify = (
	migrations: ReadonlyArray<LoadedMigration>,
	options: VerifyOptions = {},
): Effect.Effect<VerifyResult, MigrateSqlError | MigrateSourceError, MigrationDriver> =>
	Effect.gen(function* () {
		const postgres = (options.dialect ?? dialectOf(migrations)) === "postgres"
		const appliedRows = yield* (postgres ? readPgApplied : readApplied).pipe(Effect.orElseSucceed(() => []))
		const appliedNames = new Set(appliedRows.map((row) => row.name))
		const against = [...migrations].reverse().find((m) => appliedNames.has(m.name) && m.snapshot !== undefined)
		const snapshot = against?.snapshot
		if (against === undefined || snapshot === undefined) return { against: undefined, drift: [] }
		if (snapshot.dialect === "postgres") return { against: against.name, drift: yield* verifyPg(snapshot, against.name, options) }
		return { against: against.name, drift: yield* verifyClickHouse(snapshot) }
	})

const verifyClickHouse = (snapshot: ClickHouseSnapshot): Effect.Effect<ReadonlyArray<Drift>, MigrateSqlError, MigrationDriver> =>
	Effect.gen(function* () {
		const driver = yield* MigrationDriver

		const db = String((yield* driver.query("SELECT currentDatabase() AS db"))[0]?.db ?? "default")
		const tables = yield* driver.query(
			`SELECT name, engine, sorting_key, partition_key, primary_key, as_select, create_table_query FROM system.tables WHERE database = currentDatabase() AND NOT is_temporary AND NOT startsWith(name, '.inner')`,
		)
		const columns = yield* driver.query(
			`SELECT table, name, type, default_kind, default_expression FROM system.columns WHERE database = currentDatabase()`,
		)
		const indexes = yield* driver.query(
			`SELECT table, name, type_full, expr, granularity FROM system.data_skipping_indices WHERE database = currentDatabase()`,
		)

		const expectedTables = snapshot.entities.filter((e): e is TableEntity => e.kind === "table")
		const expectedColumns = snapshot.entities.filter((e): e is ColumnEntity => e.kind === "column")
		const expectedIndexes = snapshot.entities.filter((e): e is IndexEntity => e.kind === "index")
		const expectedViews = snapshot.entities.filter((e): e is MaterializedViewEntity => e.kind === "materialized_view")

		const exprs = new Set<string>()
		for (const t of expectedTables) for (const k of [t.orderBy, t.partitionBy, t.primaryKey]) exprs.add(unwrapTuple(k))
		for (const c of expectedColumns) if (c.default !== null) exprs.add(c.default.expr)
		for (const i of expectedIndexes) exprs.add(i.expr)
		for (const row of tables) for (const k of ["sorting_key", "partition_key", "primary_key"]) exprs.add(String(row[k] ?? ""))
		for (const row of columns) exprs.add(String(row.default_expression ?? ""))
		for (const row of indexes) exprs.add(String(row.expr ?? ""))
		const expr = yield* canonical(driver, "expr", exprs)
		const qualified = new RegExp(`\\b${db.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`, "g")
		const views = new Set<string>(expectedViews.map((v) => v.select))
		for (const row of tables) if (row.engine === "MaterializedView") views.add(String(row.as_select ?? "").replace(qualified, ""))
		const query = yield* canonical(driver, "query", views)
		const types = yield* canonicalTypes(driver, new Set([...expectedColumns.map((c) => c.type), ...columns.map((c) => String(c.type))]))

		const norm = (map: Map<string, string>, value: string): string => (value.length === 0 ? "" : (map.get(value) ?? squash(value)))
		const drift: Array<Drift> = []
		const actualTables = new Map(tables.map((row) => [String(row.name), row]))
		const managed = new Set<string>(Object.values(LEDGER_TABLES))

		for (const t of expectedTables) {
			const row = actualTables.get(t.name)
			if (row === undefined) {
				drift.push({ entity: t.name, problem: "missing" })
				continue
			}
			if (engineFamily(String(row.engine)) !== t.engine.family) {
				drift.push({ entity: t.name, problem: "engine", expected: t.engine.family, actual: String(row.engine) })
			}
			const keys = [
				["sorting_key", t.orderBy],
				["partition_key", t.partitionBy],
				["primary_key", t.primaryKey ?? t.orderBy],
			] as const
			for (const [column, key] of keys) {
				const expected = norm(expr, unwrapTuple(key))
				const actual = norm(expr, String(row[column] ?? ""))
				if (expected !== actual) drift.push({ entity: t.name, problem: column, expected, actual })
			}
		}
		for (const v of expectedViews) {
			const row = actualTables.get(v.name)
			if (row === undefined) {
				drift.push({ entity: v.name, problem: "missing" })
				continue
			}
			const target = /\bTO\s+(\S+)/.exec(String(row.create_table_query ?? ""))?.[1]?.replace(qualified, "").replace(/`/g, "")
			if (target !== v.to) drift.push({ entity: v.name, problem: "view_target", expected: v.to, ...(target !== undefined ? { actual: target } : undefined) })
			const expected = norm(query, v.select)
			const actual = norm(query, String(row.as_select ?? "").replace(qualified, ""))
			if (expected !== actual) drift.push({ entity: v.name, problem: "view_body", expected, actual })
		}
		const expectedNames = new Set([...expectedTables.map((t) => t.name), ...expectedViews.map((v) => v.name)])
		for (const name of actualTables.keys()) {
			if (!expectedNames.has(name) && !managed.has(name)) drift.push({ entity: name, problem: "unexpected" })
		}

		const actualColumns = new Map(columns.map((row) => [`${String(row.table)}.${String(row.name)}`, row]))
		const tableNames = new Set(expectedTables.map((t) => t.name))
		for (const c of expectedColumns) {
			const key = `${c.table}.${c.name}`
			const row = actualColumns.get(key)
			if (row === undefined) {
				if (actualTables.has(c.table)) drift.push({ entity: key, problem: "missing" })
				continue
			}
			const expectedType = types.get(c.type) ?? c.type
			const actualType = types.get(String(row.type)) ?? String(row.type)
			if (expectedType !== actualType) drift.push({ entity: key, problem: "type", expected: expectedType, actual: actualType })
			const expectedDefault = c.default === null ? "" : `${c.default.kind} ${norm(expr, c.default.expr)}`
			const actualKind = String(row.default_kind ?? "")
			const actualDefault = actualKind.length === 0 ? "" : `${actualKind} ${norm(expr, String(row.default_expression ?? ""))}`
			if (expectedDefault !== actualDefault) drift.push({ entity: key, problem: "default", expected: expectedDefault, actual: actualDefault })
		}
		for (const [key, row] of actualColumns) {
			const table = String(row.table)
			if (tableNames.has(table) && !expectedColumns.some((c) => `${c.table}.${c.name}` === key)) {
				drift.push({ entity: key, problem: "unexpected" })
			}
		}

		const actualIndexes = new Map(indexes.map((row) => [`${String(row.table)}.${String(row.name)}`, row]))
		for (const i of expectedIndexes) {
			const key = `${i.table}.${i.name}`
			const row = actualIndexes.get(key)
			if (row === undefined) {
				if (actualTables.has(i.table)) drift.push({ entity: key, problem: "missing" })
				continue
			}
			const expected = `${norm(expr, i.expr)} TYPE ${squash(i.type)} GRANULARITY ${i.granularity}`
			const actual = `${norm(expr, String(row.expr ?? ""))} TYPE ${squash(String(row.type_full ?? ""))} GRANULARITY ${String(row.granularity ?? "")}`
			if (expected !== actual) drift.push({ entity: key, problem: "index", expected, actual })
		}
		for (const [key, row] of actualIndexes) {
			if (tableNames.has(String(row.table)) && !expectedIndexes.some((i) => `${i.table}.${i.name}` === key)) {
				drift.push({ entity: key, problem: "unexpected" })
			}
		}

		return drift
	})
