// SQLite migrations: any schema change, applied to a database with rows, gives
// the database a fresh create would, and keeps the rows.
//
// Two random schemas share a pool of table and column names, so any pair holds
// a mix of new, dropped and changed tables, columns, keys, UNIQUE constraints,
// defaults and indexes. The migration `diffSqliteSchemas` writes from one to the
// other runs on a database seeded with rows that fit both, inside a transaction
// as D1 and drizzle's migrator run it. Then:
//
//   same shape   PRAGMA table_info / index_list / index_xinfo match a fresh
//                create of the new schema (column order aside: ADD COLUMN appends)
//   rows kept    every seeded row is still there (as a multiset: a rebuild
//                renumbers rowids), each kept column holding its value, and a
//                new or newly NOT NULL column its default
import { DatabaseSync } from "node:sqlite"
import fc from "fast-check"
import { Effect } from "effect"
import { Miniflare } from "miniflare"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import * as SQLite from "@maple-dev/effect-orm/sqlite"
import { diffSqliteSchemas, fromDrizzleSqliteSnapshot, renderSqliteOp, renderSqliteSchema, sqliteEntitiesOf, type SqliteSchemaEntity } from "@maple-dev/effect-orm/schema"
import { FuzzFailure, property, skip, withContext } from "./harness"

// Schema plans

type ColumnType = "text" | "integer" | "real" | "blob"
type Default = { readonly k: "literal" } | { readonly k: "expr" } | { readonly k: "now" }
interface ColumnPlan {
	readonly name: string
	readonly type: ColumnType
	readonly nullable: boolean
	readonly default?: Default
	readonly unique: boolean
}
interface TablePlan {
	readonly name: string
	readonly columns: ReadonlyArray<ColumnPlan>
	readonly primaryKey: ReadonlyArray<string>
	readonly indexes: ReadonlyArray<{ readonly columns: ReadonlyArray<string>; readonly unique: boolean }>
}
type SchemaPlan = ReadonlyArray<TablePlan>

const TABLES = ["t0", "t1"] as const
const COLUMNS = ["c0", "c1", "c2", "c3", "c4"] as const

const defaultFor = (type: ColumnType): fc.Arbitrary<Default | undefined> =>
	type === "blob"
		? fc.constant(undefined)
		: fc.option(fc.constantFrom<Default>({ k: "literal" }, { k: "expr" }, ...(type === "text" ? [{ k: "now" } as const] : [])), { nil: undefined, freq: 2 })

const columnPlan = (name: string): fc.Arbitrary<ColumnPlan> =>
	fc.constantFrom<ColumnType>("text", "integer", "real", "blob").chain((type) =>
		fc.record({
			name: fc.constant(name),
			type: fc.constant(type),
			nullable: fc.boolean(),
			default: defaultFor(type),
			unique: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
		}),
	)

const tablePlan = (name: string): fc.Arbitrary<TablePlan> =>
	fc
		// Shuffled, so a column shared by two schemas may sit at a different position.
		.shuffledSubarray([...COLUMNS], { minLength: 1 })
		.chain((names) => fc.tuple(...names.map(columnPlan)))
		.chain((columns) => {
			const keyable = columns.filter((c) => !c.nullable).map((c) => c.name)
			const names = columns.map((c) => c.name)
			return fc.record({
				name: fc.constant(name),
				columns: fc.constant(columns),
				primaryKey: keyable.length === 0 ? fc.constant([]) : fc.shuffledSubarray(keyable, { maxLength: Math.min(2, keyable.length) }),
				indexes: fc.array(fc.record({ columns: fc.shuffledSubarray(names, { minLength: 1, maxLength: Math.min(2, names.length) }), unique: fc.boolean() }), { maxLength: 2 }),
			})
		})

const schemaPlan: fc.Arbitrary<SchemaPlan> = fc
	.subarray([...TABLES], { minLength: 1 })
	.chain((names) => fc.tuple(...names.map(tablePlan)))

// Plans as SQLite.table definitions

const literalOf = (type: ColumnType): string | number => (type === "text" ? "d" : type === "integer" ? 7 : 1.5)
const exprOf = (type: ColumnType): string => (type === "text" ? "(lower('X'))" : "(1 + 1)")
/** What a default reads back as, or undefined where it is not predictable (the current time). */
const defaultValue = (column: ColumnPlan): unknown =>
	column.default?.k === "literal" ? literalOf(column.type) : column.default?.k === "expr" ? (column.type === "text" ? "x" : 2) : undefined

const typeOf = (column: ColumnPlan) => {
	const base = { text: SQLite.text, integer: SQLite.integer, real: SQLite.real, blob: SQLite.blob }[column.type] as SQLite.SqliteType<string, any, any>
	return column.nullable ? SQLite.nullable(base) : base
}

const tablesOf = (plan: SchemaPlan) =>
	plan.map((table) =>
		SQLite.table(table.name, {
			columns: Object.fromEntries(
				table.columns.map((column) => [
					column.name,
					SQLite.column(typeOf(column), {
						...(column.default?.k === "literal" ? { default: literalOf(column.type) as never } : {}),
						...(column.default?.k === "expr" ? { defaultExpr: exprOf(column.type) } : {}),
						...(column.default?.k === "now" ? { defaultExpr: "(CURRENT_TIMESTAMP)" } : {}),
						...(column.unique ? { unique: true as const } : {}),
					} as never),
				]),
			),
			...(table.primaryKey.length > 0 ? { primaryKey: table.primaryKey as never } : {}),
			indexes: table.indexes.map((index, i) => (index.unique ? SQLite.uniqueIndex : SQLite.index)(`${table.name}_i${i}`, index.columns as never)),
		}),
	)

const entitiesOf = (plan: SchemaPlan): ReadonlyArray<SqliteSchemaEntity> => {
	const exit = Effect.runSyncExit(sqliteEntitiesOf(tablesOf(plan) as never))
	if (exit._tag === "Failure") throw new FuzzFailure("a generated schema was refused", { plan, cause: String(exit.cause) })
	return exit.value
}

// Rows

/** A value for row `i` of a column: distinct per row, so UNIQUE and key constraints in either schema hold. */
const seedValue = (column: ColumnPlan, i: number): string | number =>
	column.type === "integer" ? i + 1 : column.type === "real" ? i + 0.5 : `v${i}`

const sqlValue = (value: unknown): string =>
	value === null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`

/**
 * Whether rows can exist in both schemas. A new NOT NULL column without a
 * default has no value for old rows, and a UNIQUE constraint over new columns
 * only gives every old row the same default, and a column that becomes the
 * rowid (a one-column integer key) takes integers only; the migration then
 * fails, as it should, so those pairs are checked with no rows.
 */
const rowsFit = (before: TablePlan, after: TablePlan): boolean => {
	const old = new Set(before.columns.map((c) => c.name))
	const added = after.columns.filter((c) => !old.has(c.name))
	if (added.some((c) => !c.nullable && c.default === undefined)) return false
	const allNew = (cols: ReadonlyArray<string>) => cols.length > 0 && cols.every((c) => !old.has(c))
	// A one-column `integer` key is the rowid: SQLite refuses a value that is not an integer there.
	const rowid = after.primaryKey.length === 1 ? after.columns.find((c) => c.name === after.primaryKey[0]) : undefined
	const was = before.columns.find((c) => c.name === rowid?.name)
	if (rowid?.type === "integer" && was !== undefined && was.type !== "integer") return false
	return !(
		allNew(after.primaryKey) ||
		after.columns.some((c) => c.unique && !old.has(c.name)) ||
		after.indexes.some((index) => index.unique && allNew(index.columns))
	)
}

interface Seed {
	readonly table: TablePlan
	readonly rows: ReadonlyArray<Record<string, unknown>>
}

/** Rows for `before` that `after` accepts: NULL only where the new column allows it or fills it with a default. */
const seedRows = (before: SchemaPlan, after: SchemaPlan, count: number, nulls: ReadonlyArray<boolean>): ReadonlyArray<Seed> =>
	before.map((table) => {
		const next = after.find((t) => t.name === table.name)
		const n = next === undefined || rowsFit(table, next) ? count : 0
		const keyed = new Set(table.primaryKey)
		// NULLs filled with one default would collide under a UNIQUE constraint of the new table.
		const uniqueLater = (name: string) =>
			next !== undefined &&
			(next.columns.some((c) => c.name === name && c.unique) ||
				next.primaryKey.includes(name) ||
				next.indexes.some((index) => index.unique && index.columns.includes(name)))
		const rows = Array.from({ length: n }, (_, i) =>
			Object.fromEntries(
				table.columns.map((column, j) => {
					const later = next?.columns.find((c) => c.name === column.name)
					const nullable =
						column.nullable &&
						!keyed.has(column.name) &&
						(later === undefined || later.nullable || (later.default !== undefined && later.default.k !== "now" && !uniqueLater(column.name)))
					return [column.name, nullable && nulls[(i * 7 + j) % nulls.length] ? null : seedValue(column, i)]
				}),
			),
		)
		return { table, rows }
	})

const insertsOf = (seeds: ReadonlyArray<Seed>) =>
	seeds.flatMap(({ table, rows }) =>
		rows.map((row) => `INSERT INTO "${table.name}" (${Object.keys(row).map((c) => `"${c}"`).join(", ")}) VALUES (${Object.values(row).map(sqlValue).join(", ")})`),
	)

/** The rows a table should hold after the migration, by row; `undefined` cells are not predictable and not compared. */
const expectedRows = (seed: Seed, after: TablePlan): ReadonlyArray<Record<string, unknown>> =>
	seed.rows.map((row) =>
		Object.fromEntries(
			after.columns.map((column) => {
				const fill = defaultValue(column)
				if (!Object.hasOwn(row, column.name)) return [column.name, column.default === undefined ? null : fill]
				const value = row[column.name]
				// A column made NOT NULL with a default takes it for old NULLs (COALESCE in the copy).
				if (value === null && !column.nullable && column.default !== undefined) return [column.name, fill]
				return [column.name, value]
			}),
		),
	)

// Engines

/** A database the migration runs on: node:sqlite in-process, or D1 in workerd. */
interface Engine {
	/** Statements one by one, as `renderSqliteSchema` output and seed rows are applied. */
	readonly exec: (statements: ReadonlyArray<string>) => Promise<void>
	/** One migration, atomically: a transaction on SQLite, one batch on D1 (as Alchemy applies it). */
	readonly migrate: (statements: ReadonlyArray<string>) => Promise<void>
	readonly all: (sql: string) => Promise<ReadonlyArray<Record<string, any>>>
}

const nodeEngine = (): Engine & { close: () => void } => {
	const db = new DatabaseSync(":memory:")
	const exec = async (statements: ReadonlyArray<string>) => {
		for (const sql of statements) db.exec(sql)
	}
	return {
		exec,
		migrate: (statements) => exec(["BEGIN", ...statements, "COMMIT"]),
		all: async (sql) => db.prepare(sql).all().map((row) => ({ ...row })),
		close: () => db.close(),
	}
}

interface D1Like {
	prepare(sql: string): { all(): Promise<{ results: Array<Record<string, any>> }> }
	batch(statements: ReadonlyArray<unknown>): Promise<unknown>
}

/** Two D1 databases (fresh and migrated) in one Miniflare, emptied between inputs. */
let d1: Promise<{ readonly mf: Miniflare; readonly dbs: ReadonlyArray<D1Like> }> | undefined
const d1Engines = async (): Promise<readonly [Engine, Engine]> => {
	const { dbs } = await (d1 ??= (async () => {
		const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('fuzz') } }", compatibilityDate: "2026-07-01", d1Databases: ["FRESH", "MIGRATED"] })
		return { mf, dbs: [(await mf.getD1Database("FRESH")) as unknown as D1Like, (await mf.getD1Database("MIGRATED")) as unknown as D1Like] }
	})())
	const engine = (db: D1Like): Engine => ({
		exec: async (statements) => {
			for (const sql of statements) await db.prepare(sql).all()
		},
		migrate: async (statements) => {
			if (statements.length > 0) await db.batch(statements.map((sql) => db.prepare(sql)))
		},
		all: async (sql) => (await db.prepare(sql).all()).results,
	})
	for (const db of dbs) {
		const tables = (await db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all()).results
		for (const { name } of tables) await db.prepare(`DROP TABLE "${name}"`).all()
	}
	return [engine(dbs[0]!), engine(dbs[1]!)]
}
afterAll(async () => {
	if (d1 !== undefined) await (await d1).mf.dispose()
})

// Shape

interface Shape {
	readonly [table: string]: { readonly columns: ReadonlyArray<unknown>; readonly indexes: ReadonlyArray<unknown> }
}

/**
 * What SQLite reports, minus what legitimately depends on history: column
 * order (ADD COLUMN appends, documented) and auto-index names and numbering.
 */
const shapeOf = async (db: Engine): Promise<Shape> => {
	const shape: Record<string, Shape[string]> = {}
	for (const { name } of await db.all("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")) {
		const columns = [...(await db.all(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${name}')`))].sort((a, b) => (a.name < b.name ? -1 : 1))
		const indexes = []
		for (const index of await db.all(`SELECT name, "unique", origin, partial FROM pragma_index_list('${name}')`)) {
			const keys = await db.all(`SELECT seqno, name, "desc", coll FROM pragma_index_xinfo('${index.name}') WHERE "key" = 1`)
			const label = String(index.name).startsWith("sqlite_autoindex_") ? `auto(${keys.map((k) => k.name).join(",")})` : index.name
			indexes.push({ ...index, name: label, keys })
		}
		shape[name] = { columns, indexes: indexes.sort((a, b) => (a.name < b.name ? -1 : 1)) }
	}
	return shape
}

// Renames

/** Which table (if any) the migration renames, and which of its kept columns. */
interface RenamePlan {
	readonly table: boolean
	readonly column: number | null
}

/**
 * Rename one table the two schemas share, and one column both versions of it
 * have, in the new schema, with the `confirm_rename` hints for them. Seeding
 * and expected rows are worked out in the old names and mapped with `table` /
 * `column`.
 */
const withRenames = (before: SchemaPlan, after: SchemaPlan, plan: RenamePlan | undefined) => {
	const shared = after.find((t) => before.some((b) => b.name === t.name))
	const old = before.find((b) => b.name === shared?.name)
	const tableTo = shared !== undefined && plan?.table === true ? `${shared.name}r` : undefined
	const kept = shared === undefined || old === undefined ? [] : shared.columns.filter((c) => old.columns.some((o) => o.name === c.name)).map((c) => c.name)
	const columnFrom = plan?.column != null && kept.length > 0 ? kept[plan.column % kept.length] : undefined
	const table = (name: string) => (name === shared?.name && tableTo !== undefined ? tableTo : name)
	const column = (tableName: string, name: string) => (tableName === shared?.name && name === columnFrom ? `${name}r` : name)
	const renamed: SchemaPlan = after.map((t) =>
		t !== shared
			? t
			: {
					name: table(t.name),
					columns: t.columns.map((c) => ({ ...c, name: column(t.name, c.name) })),
					primaryKey: t.primaryKey.map((c) => column(t.name, c)),
					indexes: t.indexes.map((index) => ({ ...index, columns: index.columns.map((c) => column(t.name, c)) })),
				},
	)
	const hints = [
		...(tableTo !== undefined ? [{ type: "confirm_rename" as const, kind: "table" as const, entity: shared!.name, to: tableTo }] : []),
		...(columnFrom !== undefined ? [{ type: "confirm_rename" as const, kind: "column" as const, entity: `${table(shared!.name)}.${columnFrom}`, to: `${columnFrom}r` }] : []),
	]
	return { renamed, hints, table, column }
}

// The property

type Input = readonly [SchemaPlan, SchemaPlan, number, ReadonlyArray<boolean>, RenamePlan?]

const migrates = async ([before, after, count, nulls, renamePlan]: Input, engines: () => Promise<readonly [Engine, Engine]>) => {
	const { renamed, hints: renameHints, table, column } = withRenames(before, after, renamePlan)
	const from = entitiesOf(before)
	const to = entitiesOf(renamed)
	// Every drop is confirmed (under the old and the new table name): the property is about what a
	// migration does, not the confirmation gate.
	const hints = [
		...renameHints,
		...before.flatMap((t) => [
			{ type: "confirm_data_loss" as const, kind: "table" as const, entity: t.name },
			...t.columns.flatMap((c) =>
				[...new Set([t.name, table(t.name)])].map((name) => ({ type: "confirm_data_loss" as const, kind: "column" as const, entity: `${name}.${c.name}` })),
			),
		]),
	]
	const diff = diffSqliteSchemas(from, to, hints)
	if (diff.missingHints.length > 0 || diff.unsupported.length > 0) {
		throw new FuzzFailure("the diff needs more than every drop and rename confirmed", { renamed, missingHints: diff.missingHints, unsupported: diff.unsupported })
	}
	const migration = diff.ops.flatMap(renderSqliteOp)
	const seeds = seedRows(before, after, count, nulls)

	const [fresh, migrated] = await engines()
	await fresh.exec(renderSqliteSchema(to))
	await migrated.exec([...renderSqliteSchema(from), ...insertsOf(seeds)])
	const context = { before, after: renamed, renameHints, migration, seeds }
	try {
		await migrated.migrate(migration)
	} catch (error) {
		throw new FuzzFailure(`the migration failed on rows that fit both schemas: ${(error as Error).message}`, context)
	}
	const [migratedShape, freshShape] = [await shapeOf(migrated), await shapeOf(fresh)]
	const tables: Array<{ name: string; want: ReadonlyArray<Record<string, unknown>>; rows: ReadonlyArray<Record<string, any>>; next: TablePlan }> = []
	for (const seed of seeds) {
		const next = after.find((t) => t.name === seed.table.name)
		if (next === undefined || seed.rows.length === 0) continue
		tables.push({ name: table(next.name), want: expectedRows(seed, next), rows: await migrated.all(`SELECT * FROM "${table(next.name)}"`), next })
	}
	await withContext(context, () => {
		expect(migratedShape).toEqual(freshShape)
		for (const { name, want, rows, next } of tables) {
			// A type change may convert a value (`'1'` to `1`); compared as text, it is the same value.
			const text = (v: unknown) => (v === null || v === undefined ? null : String(v))
			const expected = want.map((row) =>
				Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined).map(([k, v]) => [column(next.name, k), text(v)])),
			)
			// Compared as a multiset: a rebuild's copy may read the old rows in index order and renumber
			// their rowids, as SQLite's documented procedure (and drizzle-kit) does.
			const keys = Object.keys(expected[0] ?? {})
			const sorted = (list: ReadonlyArray<Record<string, unknown>>) => list.map((row) => JSON.stringify(keys.map((k) => row[k]))).sort()
			const actual = rows.map((row) => Object.fromEntries(keys.map((k) => [k, text(row[k])])))
			expect(sorted(actual), `rows of ${name}`).toEqual(sorted(expected))
		}
	})
}

const input = fc.tuple(
	schemaPlan,
	schemaPlan,
	fc.integer({ min: 0, max: 3 }),
	fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
	fc.record({ table: fc.boolean(), column: fc.option(fc.nat(), { nil: null }) }),
)

describe("SQLite migrations", () => {
	const engines = {
		sqlite: { runs: 200, open: async () => {
			const pair = [nodeEngine(), nodeEngine()] as const
			opened.push(...pair)
			return pair
		} },
		// D1 applies each migration as one batch, as Alchemy's D1 resource sends it.
		d1: { runs: 25, open: d1Engines },
	}
	const opened: Array<{ close: () => void }> = []
	afterEach(() => {
		for (const db of opened.splice(0)) db.close()
	})
	for (const [target, { runs, open }] of Object.entries(engines)) {
		const name = `migrations reach the fresh schema and keep the rows (${target})`
		it(name, () => property(name, input, (value) => (value[0].length === 0 ? skip("no tables") : migrates(value as Input, open)), { runs }), 600_000)
	}
})

// Adopting a drizzle-kit folder

/**
 * The snapshot drizzle-kit 1.0 writes for these entities (version 7, as in
 * src/kit/__fixtures__/drizzle-sqlite), including its one quirk: a primary key
 * column is written `notNull: false`.
 */
const drizzleSnapshot = (entities: ReadonlyArray<SqliteSchemaEntity>) => {
	const keyed = new Set(entities.flatMap((e) => (e.kind === "table" ? (e.primaryKey?.columns ?? []).map((c) => `${e.name}.${c}`) : [])))
	const unquote = (part: string) => /^"(.*)"$/.exec(part)?.[1]?.replaceAll('""', '"')
	const ddl = entities.flatMap((e): Array<Record<string, unknown>> => {
		switch (e.kind) {
			case "table":
				return [
					{ name: e.name, entityType: "tables" },
					...(e.primaryKey === null ? [] : [{ table: e.name, name: `${e.name}_pk`, columns: e.primaryKey.columns, nameExplicit: false, entityType: "pks" }]),
				]
			case "column":
				return [{ table: e.table, name: e.name, type: e.type, notNull: e.notNull && !keyed.has(`${e.table}.${e.name}`), autoincrement: false, default: e.default, generated: null, entityType: "columns" }]
			case "index":
				return [{
					table: e.table,
					name: e.name,
					columns: e.columns.map((part) => (unquote(part) === undefined ? { value: part, isExpression: true } : { value: unquote(part), isExpression: false })),
					isUnique: e.unique,
					where: null,
					origin: "manual",
					entityType: "indexes",
				}]
			case "unique":
				return [{ table: e.table, name: e.name, columns: e.columns, nameExplicit: false, entityType: "uniques" }]
			default:
				return []
		}
	})
	// drizzle-kit lists columns in table order; entities sort by key, so order them by position first.
	const position = (e: Record<string, unknown>) => (e.entityType === "columns" ? (entities.find((x) => x.kind === "column" && x.table === e.table && x.name === e.name) as { position: number }).position : 0)
	return { version: "7", dialect: "sqlite", id: "fuzz", prevIds: [], ddl: [...ddl].sort((a, b) => position(a) - position(b)), renames: [] }
}

describe("adopting a drizzle-kit SQLite folder", () => {
	const name = "a drizzle-kit snapshot of any schema imports with no change to generate (sqlite)"
	it(name, () =>
		property(
			name,
			schemaPlan,
			(plan) => {
				const entities = entitiesOf(plan)
				const snapshot = drizzleSnapshot(entities)
				const imported = fromDrizzleSqliteSnapshot(snapshot)
				const diff = diffSqliteSchemas(imported.entities, entities)
				return withContext({ plan, snapshot, imported: imported.entities, ops: diff.ops }, () => {
					expect(imported.unsupported).toEqual([])
					expect(diff.ops).toEqual([])
				})
			},
			{ runs: 300 },
		),
	)
})
