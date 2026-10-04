// Postgres drift: the live schema against the snapshot of the last applied
// migration.
//
// Comparing SQL text is hopeless in Postgres: the catalog stores a default of
// `'open'` as `'open'::text`, a predicate `status in ('a', 'b')` as
// `(status = ANY (ARRAY['a'::text, 'b'::text]))`. So nothing is normalized
// here. The snapshot is built in a scratch schema, inside a transaction that
// is always rolled back, and the two catalogs are read with the same queries:
// the server deparses both sides, and equal definitions read back equal.
//
// Checked: tables, columns (type, NOT NULL, default), primary keys, indexes
// (uniqueness, method, keys, predicate), foreign keys (columns, target,
// actions). Not checked: anything the entity model does not hold (triggers,
// grants, check constraints), and tables outside the current schema.

import { Effect, Schema } from "effect"
import type { PgSnapshot } from "../schema/entities"
import { renderPgSchema } from "../schema/pg-ops"
import type { PgReferentialAction } from "../schema/pg-entities"
import { MigrationDriver } from "./driver"
import type { MigrateSourceError, MigrateSqlError } from "./errors"
import { LEDGER_TABLES } from "./ledger"
import { transactionOf } from "./pg-ledger"
import type { Drift } from "./verify"

const q = (value: string): string => `'${value.replace(/'/g, "''")}'`

interface CatalogTable {
	readonly primaryKey: { readonly name: string; readonly columns: ReadonlyArray<string> } | null
	readonly columns: Map<string, { readonly type: string; readonly notNull: boolean; readonly default: string | null; readonly identity: string }>
	readonly indexes: Map<string, { readonly unique: boolean; readonly method: string; readonly keys: ReadonlyArray<string>; readonly where: string | null }>
	readonly foreignKeys: Map<
		string,
		{
			readonly columns: ReadonlyArray<string>
			readonly foreignTable: string
			readonly foreignColumns: ReadonlyArray<string>
			readonly onDelete: PgReferentialAction
			readonly onUpdate: PgReferentialAction
		}
	>
}

const ACTIONS: Readonly<Record<string, PgReferentialAction>> = {
	a: "NO ACTION",
	r: "RESTRICT",
	c: "CASCADE",
	n: "SET NULL",
	d: "SET DEFAULT",
}

const jsonList = (value: unknown): ReadonlyArray<string> =>
	value === null || value === undefined ? [] : (JSON.parse(String(value)) as Array<unknown>).map(String)

/** Every table of `schema`, read from the catalog. */
const readCatalog = (schema: string) =>
	Effect.gen(function* () {
		const driver = yield* MigrationDriver
		const ns = `n.nspname = ${q(schema)}`
		const tables = yield* driver.query(
			`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${ns} AND c.relkind IN ('r', 'p')`,
		)
		const columns = yield* driver.query(
			`SELECT c.relname AS tbl, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS dflt, a.attidentity::text AS ident
			FROM pg_attribute a
			JOIN pg_class c ON c.oid = a.attrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
			WHERE ${ns} AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`,
		)
		const constraints = yield* driver.query(
			`SELECT con.conname AS name, c.relname AS tbl, con.contype AS type, fc.relname AS foreign_table,
				con.confdeltype AS on_delete, con.confupdtype AS on_update,
				(SELECT json_agg(att.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
					JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum)::text AS cols,
				(SELECT json_agg(att.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
					JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k.attnum)::text AS foreign_cols
			FROM pg_constraint con
			JOIN pg_class c ON c.oid = con.conrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			LEFT JOIN pg_class fc ON fc.oid = con.confrelid
			WHERE ${ns} AND con.contype IN ('p', 'f')`,
		)
		// Key parts one by one, with their sort order: pg_get_indexdef(oid, k, true)
		// writes a key without DESC / NULLS, which live in indoption.
		const indexes = yield* driver.query(
			`SELECT i.relname AS name, t.relname AS tbl, ix.indisunique AS is_unique, am.amname AS method,
				pg_get_expr(ix.indpred, ix.indrelid, true) AS predicate,
				(SELECT json_agg(
					pg_get_indexdef(ix.indexrelid, k, true)
					|| CASE WHEN ix.indoption[k - 1] & 1 = 1 THEN ' DESC' ELSE '' END
					|| CASE
						WHEN ix.indoption[k - 1] & 1 = 1 AND ix.indoption[k - 1] & 2 = 0 THEN ' NULLS LAST'
						WHEN ix.indoption[k - 1] & 1 = 0 AND ix.indoption[k - 1] & 2 = 2 THEN ' NULLS FIRST'
						ELSE '' END
					ORDER BY k) FROM generate_series(1, ix.indnkeyatts) k)::text AS keys
			FROM pg_index ix
			JOIN pg_class i ON i.oid = ix.indexrelid
			JOIN pg_class t ON t.oid = ix.indrelid
			JOIN pg_namespace n ON n.oid = t.relnamespace
			JOIN pg_am am ON am.oid = i.relam
			WHERE ${ns} AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid AND con.contype IN ('p', 'u', 'x'))`,
		)

		const out = new Map<string, CatalogTable>()
		for (const row of tables) {
			out.set(String(row.name), { primaryKey: null, columns: new Map(), indexes: new Map(), foreignKeys: new Map() })
		}
		for (const row of columns) {
			out.get(String(row.tbl))?.columns.set(String(row.name), {
				type: String(row.type),
				notNull: row.not_null === true || row.not_null === "t",
				default: row.dflt === null || row.dflt === undefined ? null : String(row.dflt),
				identity: row.ident === "a" ? "always" : row.ident === "d" ? "by default" : "none",
			})
		}
		for (const row of constraints) {
			const table = out.get(String(row.tbl))
			if (table === undefined) continue
			if (row.type === "p") {
				out.set(String(row.tbl), { ...table, primaryKey: { name: String(row.name), columns: jsonList(row.cols) } })
			} else {
				table.foreignKeys.set(String(row.name), {
					columns: jsonList(row.cols),
					foreignTable: String(row.foreign_table),
					foreignColumns: jsonList(row.foreign_cols),
					onDelete: ACTIONS[String(row.on_delete)] ?? "NO ACTION",
					onUpdate: ACTIONS[String(row.on_update)] ?? "NO ACTION",
				})
			}
		}
		for (const row of indexes) {
			out.get(String(row.tbl))?.indexes.set(String(row.name), {
				unique: row.is_unique === true || row.is_unique === "t",
				method: String(row.method),
				keys: jsonList(row.keys),
				where: row.predicate === null || row.predicate === undefined ? null : String(row.predicate),
			})
		}
		return out
	})

/** Rolls the scratch transaction back once its catalog is read. */
class Rollback extends Schema.TaggedError<Rollback>()("@maple-dev/effect-orm/VerifyRollback", {
	expected: Schema.Unknown,
}) {}

/** The snapshot as Postgres would store it: built in a scratch schema and rolled back. */
const expectedCatalog = (snapshot: PgSnapshot, migration: string) =>
	Effect.gen(function* () {
		const driver = yield* MigrationDriver
		const transaction = yield* transactionOf(driver, migration)
		const scratch = `_effect_orm_verify_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
		const result = yield* transaction(
			Effect.gen(function* () {
				yield* driver.execute(`CREATE SCHEMA "${scratch}"`)
				// pg_catalog stays implicitly first, so built-ins resolve as they do in the real schema.
				yield* driver.execute(`SET LOCAL search_path TO "${scratch}"`)
				for (const statement of renderPgSchema(snapshot.entities)) yield* driver.execute(statement)
				const expected = yield* readCatalog(scratch)
				return yield* new Rollback({ expected })
			}),
		).pipe(Effect.flip)
		if (result._tag !== "@maple-dev/effect-orm/VerifyRollback") return yield* Effect.fail(result)
		return result.expected as Map<string, CatalogTable>
	})

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const show = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value))

export interface PgVerifyOptions {
	/** Tables in the schema that are not this schema's business (another tool's ledger, say). */
	readonly ignoreTables?: ReadonlyArray<string>
}

export const verifyPg = (
	snapshot: PgSnapshot,
	migration: string,
	options: PgVerifyOptions = {},
): Effect.Effect<ReadonlyArray<Drift>, MigrateSqlError | MigrateSourceError, MigrationDriver> =>
	Effect.gen(function* () {
		const driver = yield* MigrationDriver
		const schema = String((yield* driver.query("SELECT current_schema() AS s"))[0]?.s ?? "public")
		const actual = yield* readCatalog(schema)
		const expected = yield* expectedCatalog(snapshot, migration)
		const ignored = new Set<string>([...Object.values(LEDGER_TABLES), ...(options.ignoreTables ?? [])])
		const drift: Array<Drift> = []
		const push = (entity: string, problem: Drift["problem"], expectedValue?: unknown, actualValue?: unknown) =>
			drift.push({
				entity,
				problem,
				...(expectedValue !== undefined ? { expected: show(expectedValue) } : undefined),
				...(actualValue !== undefined ? { actual: show(actualValue) } : undefined),
			})

		for (const [name, want] of expected) {
			const have = actual.get(name)
			if (have === undefined) {
				push(name, "missing")
				continue
			}
			if (!same(want.primaryKey, have.primaryKey)) push(name, "primary_key", want.primaryKey ?? "none", have.primaryKey ?? "none")
			for (const [column, w] of want.columns) {
				const h = have.columns.get(column)
				const key = `${name}.${column}`
				if (h === undefined) push(key, "missing")
				else {
					if (w.type !== h.type) push(key, "type", w.type, h.type)
					if (w.notNull !== h.notNull) push(key, "not_null", w.notNull ? "NOT NULL" : "NULL", h.notNull ? "NOT NULL" : "NULL")
					if (w.default !== h.default) push(key, "default", w.default ?? "none", h.default ?? "none")
					if (w.identity !== h.identity) push(key, "identity", w.identity, h.identity)
				}
			}
			for (const column of have.columns.keys()) if (!want.columns.has(column)) push(`${name}.${column}`, "unexpected")
			for (const [index, w] of want.indexes) {
				const h = have.indexes.get(index)
				if (h === undefined) push(`${name}.${index}`, "missing")
				else if (!same(w, h)) push(`${name}.${index}`, "index", w, h)
			}
			for (const index of have.indexes.keys()) if (!want.indexes.has(index)) push(`${name}.${index}`, "unexpected")
			for (const [fk, w] of want.foreignKeys) {
				const h = have.foreignKeys.get(fk)
				if (h === undefined) push(`${name}.${fk}`, "missing")
				else if (!same(w, h)) push(`${name}.${fk}`, "foreign_key", w, h)
			}
			for (const fk of have.foreignKeys.keys()) if (!want.foreignKeys.has(fk)) push(`${name}.${fk}`, "unexpected")
		}
		for (const name of actual.keys()) {
			if (!expected.has(name) && !ignored.has(name)) push(name, "unexpected")
		}
		return drift
	})
