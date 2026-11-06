// MySQL and MariaDB migrations: any schema change, applied to a database with
// rows, gives the database a fresh create would, and keeps the rows.
//
// Two random schemas share a pool of table and column names, so any pair holds
// a mix of new, dropped, renamed and changed tables, columns, keys, UNIQUE
// constraints, defaults and indexes. The migration `diffMysqlSchemas` writes
// from one to the other runs, statement by statement, on a database seeded with
// rows that fit both. Then:
//
//   same shape   information_schema (COLUMNS, STATISTICS, TABLE_CONSTRAINTS,
//                CHECK_CONSTRAINTS, TABLES) matches a fresh create of the new
//                schema in another database (column order aside: ADD COLUMN appends)
//   rows kept    every seeded row is still there, each kept column holding its
//                value, and a new or newly NOT NULL column its default
//
// Live on each server whose EFFECT_ORM_MYSQL_URL / EFFECT_ORM_MARIADB_URL is set.
import fc from "fast-check"
import { DateTime, Effect, Schema } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import * as MySQL from "@maple-dev/effect-orm/mysql"
import { diffMysqlSchemas, mysqlEntitiesOf, renderMysqlOp, renderMysqlSchema, type MysqlSchemaEntity } from "@maple-dev/effect-orm/schema"
import { mariadbServer, mysqlServer, scratchDatabase, type MysqlServer, type ScratchDatabase } from "../mysql-support"
import { FuzzFailure, property, withContext } from "./harness"
import { nastyString, portableStrings, wellFormed } from "./values"

// Schema plans

const TYPES = ["int", "bigint", "double", "decimal", "varchar", "text", "boolean", "datetime", "json"] as const
type ColumnType = (typeof TYPES)[number]
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

/** TEXT and JSON cannot be in a key without a prefix length. */
const indexable = (type: ColumnType) => type !== "text" && type !== "json"
/** A key of its own needs distinct values; a boolean has two. */
const keyable = (column: ColumnPlan) => indexable(column.type) && column.type !== "boolean"

const columnPlan = (name: string): fc.Arbitrary<ColumnPlan> =>
	fc.constantFrom(...TYPES).chain((type) =>
		fc.record({
			name: fc.constant(name),
			type: fc.constant(type),
			nullable: fc.boolean(),
			default: fc.option(fc.constantFrom<Default>({ k: "literal" }, { k: "expr" }, ...(type === "datetime" ? [{ k: "now" } as const] : [])), { nil: undefined, freq: 2 }),
			unique: fc.integer({ min: 0, max: 4 }).map((n) => n === 0 && keyable({ name, type, nullable: false, unique: false })),
		}),
	)

const tablePlan = (name: string): fc.Arbitrary<TablePlan> =>
	fc
		// Shuffled, so a column shared by two schemas may sit at a different position.
		.shuffledSubarray([...COLUMNS], { minLength: 1 })
		.chain((names) => fc.tuple(...names.map(columnPlan)))
		.chain((columns) => {
			const keys = columns.filter((c) => !c.nullable && keyable(c)).map((c) => c.name)
			const indexed = columns.filter((c) => indexable(c.type)).map((c) => c.name)
			return fc.record({
				name: fc.constant(name),
				columns: fc.constant(columns),
				primaryKey: keys.length === 0 ? fc.constant([]) : fc.shuffledSubarray(keys, { maxLength: Math.min(2, keys.length) }),
				indexes:
					indexed.length === 0
						? fc.constant([])
						: fc
								.array(fc.record({ columns: fc.shuffledSubarray(indexed, { minLength: 1, maxLength: Math.min(2, indexed.length) }), unique: fc.boolean() }), { maxLength: 2 })
								// A unique index needs a column with distinct seeded values.
								.map((indexes) => indexes.map((index) => ({ ...index, unique: index.unique && index.columns.some((c) => keyable(columns.find((col) => col.name === c)!)) }))),
			})
		})

const schemaPlan: fc.Arbitrary<SchemaPlan> = fc.subarray([...TABLES], { minLength: 1 }).chain((names) => fc.tuple(...names.map(tablePlan)))

// Plans as MySQL.table definitions

const typeOf = (column: ColumnPlan) => {
	const base = {
		int: MySQL.int,
		bigint: MySQL.bigint,
		double: MySQL.double,
		decimal: MySQL.decimal(10, 2),
		varchar: MySQL.varchar(32),
		text: MySQL.text,
		boolean: MySQL.boolean,
		datetime: MySQL.datetime,
		json: MySQL.json(Schema.Unknown),
	}[column.type] as MySQL.MysqlType<string, any, any>
	return column.nullable ? MySQL.nullable(base) : base
}

const DEFAULT_AT = "2024-01-02 03:04:05.678"
const literalOf = (type: ColumnType): unknown =>
	({ int: 7, bigint: -7, double: 1.5, decimal: "1.50", varchar: "d", text: "it's\\d", boolean: true, datetime: DateTime.makeUnsafe(`${DEFAULT_AT.replace(" ", "T")}Z`), json: { k: "d" } })[type]
const exprOf = (type: ColumnType): string =>
	type === "varchar" || type === "text" ? "(lower('X'))" : type === "json" ? "(JSON_OBJECT('k', 'x'))" : type === "boolean" ? "(1 = 1)" : type === "datetime" ? `(CAST('${DEFAULT_AT}' AS DATETIME(3)))` : "(1 + 1)"

/** What a default reads back as, normalized; `undefined` where it is not predictable (the current time). */
const defaultValue = (column: ColumnPlan): unknown => {
	if (column.default === undefined || column.default.k === "now") return undefined
	if (column.default.k === "literal") return normalize(column.type, column.type === "datetime" ? DEFAULT_AT : literalOf(column.type))
	return normalize(column.type, { varchar: "x", text: "x", json: { k: "x" }, boolean: 1, datetime: DEFAULT_AT }[column.type as string] ?? 2)
}

const tablesOf = (plan: SchemaPlan) =>
	plan.map((table) =>
		MySQL.table(table.name, {
			columns: Object.fromEntries(
				table.columns.map((column) => [
					column.name,
					MySQL.column(typeOf(column), {
						...(column.default?.k === "literal" ? { default: literalOf(column.type) as never } : {}),
						...(column.default?.k === "expr" ? { defaultExpr: exprOf(column.type) } : {}),
						...(column.default?.k === "now" ? { defaultExpr: MySQL.dateTimeNow } : {}),
						...(column.unique ? { unique: true as const } : {}),
					} as never),
				]),
			),
			...(table.primaryKey.length > 0 ? { primaryKey: table.primaryKey as never } : {}),
			indexes: table.indexes.map((index, i) => (index.unique ? MySQL.uniqueIndex : MySQL.index)(`${table.name}_i${i}`, index.columns as never)),
		}),
	)

const entitiesOf = (plan: SchemaPlan): ReadonlyArray<MysqlSchemaEntity> => {
	const exit = Effect.runSyncExit(mysqlEntitiesOf(tablesOf(plan) as never))
	if (exit._tag === "Failure") throw new FuzzFailure("a generated schema was refused", { plan, cause: String(exit.cause) })
	return exit.value
}

// Values

/** A value as the oracle compares it: numbers as numbers, DATETIME as its text, JSON as canonical text. */
function normalize(type: ColumnType, value: unknown): unknown {
	if (value === null || value === undefined) return null
	switch (type) {
		case "int":
		case "bigint":
		case "double":
		case "decimal":
		case "boolean":
			return typeof value === "boolean" ? Number(value) : Number(value)
		case "varchar":
		case "text":
			return String(value)
		case "datetime":
			return value instanceof Date ? MySQL.mysqlDateTimeText(value.getTime()) : String(value)
		case "json":
			return canonical(typeof value === "string" ? JSON.parse(value) : value)
	}
}
const canonical = (value: unknown): string =>
	JSON.stringify(value, (_, v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v))

interface Payload {
	readonly text: string
	readonly int: number
	readonly bigint: number
	readonly double: number
	readonly cents: number
	readonly at: number
}

const payload = fc.record({
	text: nastyString(portableStrings).filter(wellFormed),
	int: fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 5 }),
	bigint: fc.oneof(fc.integer({ min: -(2 ** 31), max: 2 ** 31 }), fc.constantFrom(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 4)),
	// Dyadic fractions are exact through the text a DOUBLE is written and read as.
	double: fc.integer({ min: -1_000_000, max: 1_000_000 }).map((n) => n / 8),
	cents: fc.integer({ min: -9_999_999_000, max: 9_999_999_000 }),
	at: fc.integer({ min: Date.UTC(1000, 0, 1), max: Date.UTC(9999, 11, 31) - 10_000 }),
})

/** Types whose values convert into each other's without loss, when they are small integers. */
const numeric = (type: ColumnType) => type !== "datetime" && type !== "json"

/** The value a seeded row holds: distinct per row, so any key over it holds; a small integer when the type changes. */
const seedValue = (column: ColumnPlan, i: number, next: ColumnPlan | undefined, data: Payload): unknown => {
	if (next !== undefined && next.type !== column.type) return column.type === "varchar" || column.type === "text" ? String(i + 1) : i + 1
	switch (column.type) {
		case "int":
			return data.int + i
		case "bigint":
			return data.bigint + i
		case "double":
			return data.double + i
		case "decimal":
			return ((data.cents + i * 100) / 100).toFixed(2)
		case "varchar":
			// varchar(32) counts characters: keep well under it.
			return `${i}:${[...data.text].slice(0, 24).join("")}`
		case "text":
			return `${i}:${data.text}`
		case "boolean":
			return i % 2
		case "datetime":
			return MySQL.mysqlDateTimeText(data.at + i * 1000)
		case "json":
			return JSON.stringify({ v: data.text, i })
	}
}

/**
 * Whether rows can exist in both schemas. A new NOT NULL column without a
 * default has no value for old rows; a key over new columns only gives every
 * old row the same value; and a column whose type changes to or from DATETIME
 * or JSON has no value both types read the same. Those pairs are checked with
 * no rows.
 */
const rowsFit = (before: TablePlan, after: TablePlan): boolean => {
	const old = new Map(before.columns.map((c) => [c.name, c]))
	if (after.columns.some((c) => !old.has(c.name) && !c.nullable && c.default === undefined)) return false
	if (after.columns.some((c) => old.has(c.name) && old.get(c.name)!.type !== c.type && !(numeric(c.type) && numeric(old.get(c.name)!.type)))) return false
	const allNew = (cols: ReadonlyArray<string>) => cols.length > 0 && cols.every((c) => !old.has(c))
	return !(allNew(after.primaryKey) || after.columns.some((c) => c.unique && !old.has(c.name)) || after.indexes.some((index) => index.unique && allNew(index.columns)))
}

interface Seed {
	readonly table: TablePlan
	readonly rows: ReadonlyArray<Record<string, unknown>>
}

/** Rows for `before` that `after` accepts: NULL only where the new column allows it or fills it with a default. */
const seedRows = (before: SchemaPlan, after: SchemaPlan, count: number, nulls: ReadonlyArray<boolean>, data: Payload): ReadonlyArray<Seed> =>
	before.map((table) => {
		const next = after.find((t) => t.name === table.name)
		const n = next === undefined || rowsFit(table, next) ? count : 0
		// NULLs filled with one default would collide under a key of the new table.
		const uniqueLater = (name: string) =>
			next !== undefined &&
			(next.columns.some((c) => c.name === name && c.unique) || next.primaryKey.includes(name) || next.indexes.some((index) => index.unique && index.columns.includes(name)))
		const rows = Array.from({ length: n }, (_, i) =>
			Object.fromEntries(
				table.columns.map((column, j) => {
					const later = next?.columns.find((c) => c.name === column.name)
					const nullable =
						column.nullable &&
						!table.primaryKey.includes(column.name) &&
						(later === undefined || later.nullable || (later.default !== undefined && later.default.k !== "now" && !uniqueLater(column.name)))
					return [column.name, nullable && nulls[(i * 7 + j) % nulls.length] ? null : seedValue(column, i, later, data)]
				}),
			),
		)
		return { table, rows }
	})

/** The rows a table should hold after the migration, normalized; `undefined` cells are not predictable and not compared. */
const expectedRows = (seed: Seed, after: TablePlan): ReadonlyArray<Record<string, unknown>> =>
	seed.rows.map((row) =>
		Object.fromEntries(
			after.columns.map((column) => {
				const fill = defaultValue(column)
				if (!Object.hasOwn(row, column.name)) return [column.name, column.default === undefined ? null : fill]
				const value = row[column.name]
				// A column made NOT NULL with a default takes it for old NULLs.
				if (value === null && !column.nullable && column.default !== undefined) return [column.name, fill]
				const was = seed.table.columns.find((c) => c.name === column.name)!
				// A changed type converts the small integer it was seeded with.
				if (value !== null && was.type !== column.type) return [column.name, Number(value)]
				return [column.name, normalize(column.type, value)]
			}),
		),
	)

// Shape

/** What information_schema reports, minus column order (ADD COLUMN appends, as documented). */
const shapeOf = async (db: ScratchDatabase) => {
	const schema = `TABLE_SCHEMA = '${db.name}'`
	const constraintSchema = `CONSTRAINT_SCHEMA = '${db.name}'`
	const sorted = (rows: ReadonlyArray<Record<string, unknown>>) => [...rows].map((row) => JSON.stringify(row)).sort()
	return {
		tables: sorted(await db.query(`SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE ${schema}`, [])),
		columns: sorted(
			await db.query(
				`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS WHERE ${schema}`,
				[],
			),
		),
		indexes: sorted(await db.query(`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, NULLABLE, INDEX_TYPE FROM information_schema.STATISTICS WHERE ${schema}`, [])),
		constraints: sorted(await db.query(`SELECT TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE FROM information_schema.TABLE_CONSTRAINTS WHERE ${constraintSchema}`, [])),
		checks: sorted(await db.query(`SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE ${constraintSchema}`, [])),
	}
}

// Renames

/** Which table (if any) the migration renames, and which of its kept columns. */
interface RenamePlan {
	readonly table: boolean
	readonly column: number | null
	/** Rename the column by case only (`c0` to `C0`), with no hint: MySQL column names ignore case. */
	readonly caseOnly: boolean
}

/**
 * Rename one table the two schemas share, and one column both versions of it
 * have, in the new schema, with the `confirm_rename` hints for them. Seeding
 * and expected rows are worked out in the old names and mapped with `table` /
 * `column`.
 */
const withRenames = (before: SchemaPlan, after: SchemaPlan, plan: RenamePlan) => {
	const shared = after.find((t) => before.some((b) => b.name === t.name))
	const old = before.find((b) => b.name === shared?.name)
	const tableTo = shared !== undefined && plan.table ? `${shared.name}r` : undefined
	const kept = shared === undefined || old === undefined ? [] : shared.columns.filter((c) => old.columns.some((o) => o.name === c.name)).map((c) => c.name)
	const columnFrom = plan.column !== null && kept.length > 0 ? kept[plan.column % kept.length] : undefined
	const columnTo = columnFrom === undefined ? undefined : plan.caseOnly ? columnFrom.toUpperCase() : `${columnFrom}r`
	const table = (name: string) => (name === shared?.name && tableTo !== undefined ? tableTo : name)
	const column = (tableName: string, name: string) => (tableName === shared?.name && name === columnFrom ? columnTo! : name)
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
		...(columnFrom !== undefined && !plan.caseOnly ? [{ type: "confirm_rename" as const, kind: "column" as const, entity: `${table(shared!.name)}.${columnFrom}`, to: columnTo! }] : []),
	]
	return { renamed, hints, table, column }
}

// The property

type Input = readonly [SchemaPlan, SchemaPlan, number, ReadonlyArray<boolean>, RenamePlan, Payload]

interface Target {
	readonly fresh: ScratchDatabase
	readonly migrated: ScratchDatabase
}

const migrates = async ([before, after, count, nulls, renamePlan, data]: Input, target: Target) => {
	const { renamed, hints: renameHints, table, column } = withRenames(before, after, renamePlan)
	const from = entitiesOf(before)
	const to = entitiesOf(renamed)
	// Every drop and type change is confirmed (in old and new names): the property is about what
	// a migration does, not the confirmation gate.
	const hints = [
		...renameHints,
		...before.flatMap((t) => [
			{ type: "confirm_data_loss" as const, kind: "table" as const, entity: t.name },
			...t.columns.flatMap((c) =>
				[...new Set([t.name, table(t.name)])].flatMap((name) =>
					[...new Set([c.name, column(t.name, c.name)])].map((col) => ({ type: "confirm_data_loss" as const, kind: "column" as const, entity: `${name}.${col}` })),
				),
			),
		]),
	]
	const diff = diffMysqlSchemas(from, to, hints)
	if (diff.missingHints.length > 0 || diff.unsupported.length > 0) {
		throw new FuzzFailure("the diff needs more than every drop and rename confirmed", { renamed, missingHints: diff.missingHints, unsupported: diff.unsupported })
	}
	const migration = diff.ops.flatMap(renderMysqlOp)
	const seeds = seedRows(before, after, count, nulls, data)
	const context = { before, after: renamed, renameHints, migration, seeds }

	const { fresh, migrated } = target
	await Promise.all([fresh.reset(), migrated.reset()])
	for (const sql of renderMysqlSchema(to)) await fresh.query(sql, [])
	for (const sql of renderMysqlSchema(from)) await migrated.query(sql, [])
	for (const { table: t, rows } of seeds) {
		for (const row of rows) {
			const names = Object.keys(row)
			await withContext(context, () => migrated.query(`INSERT INTO \`${t.name}\` (${names.map((c) => `\`${c}\``).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, Object.values(row)))
		}
	}
	for (const sql of migration) {
		try {
			await migrated.query(sql, [])
		} catch (error) {
			throw new FuzzFailure(`the migration failed on rows that fit both schemas: ${(error as Error).message}`, { ...context, statement: sql })
		}
	}
	const [migratedShape, freshShape] = [await shapeOf(migrated), await shapeOf(fresh)]
	const tables: Array<{ name: string; want: ReadonlyArray<Record<string, unknown>>; rows: ReadonlyArray<Record<string, unknown>>; next: TablePlan }> = []
	for (const seed of seeds) {
		const next = after.find((t) => t.name === seed.table.name)
		if (next === undefined || seed.rows.length === 0) continue
		tables.push({ name: table(next.name), want: expectedRows(seed, next), rows: await migrated.query(`SELECT * FROM \`${table(next.name)}\``, []), next })
	}
	await withContext(context, () => {
		expect(migratedShape).toEqual(freshShape)
		for (const { name, want, rows, next } of tables) {
			const types = new Map(next.columns.map((c) => [c.name, c]))
			const expected = want.map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined).map(([k, v]) => [column(next.name, k), v])))
			const keys = Object.keys(expected[0] ?? {})
			const original = (key: string) => next.columns.find((c) => column(next.name, c.name) === key)!.name
			const actual = rows.map((row) =>
				Object.fromEntries(
					keys.map((k) => {
						const plan = types.get(original(k))!
						const was = before.find((t) => t.name === next.name)?.columns.find((c) => c.name === plan.name)
						// MySQL hands a column back under the name it was declared with; a case-only rename changes that.
						const value = row[k] ?? row[Object.keys(row).find((key) => key.toLowerCase() === k.toLowerCase())!]
						// A changed type was seeded with a small integer; a default filled in is compared as itself.
						const converted = was !== undefined && was.type !== plan.type && value !== null && !Number.isNaN(Number(value))
						return [k, converted ? Number(value) : normalize(plan.type, value)]
					}),
				),
			)
			const sorted = (list: ReadonlyArray<Record<string, unknown>>) => list.map((row) => JSON.stringify(keys.map((k) => row[k]))).sort()
			expect(sorted(actual), `rows of ${name}`).toEqual(sorted(expected))
		}
	})
}

const input = fc.tuple(
	schemaPlan,
	schemaPlan,
	fc.integer({ min: 0, max: 3 }),
	fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
	fc.record({ table: fc.boolean(), column: fc.option(fc.nat(), { nil: null }), caseOnly: fc.boolean() }),
	payload,
)

const opened: Array<ScratchDatabase> = []
afterAll(() => Promise.all(opened.map((db) => db.close())))

for (const server of [mysqlServer, mariadbServer] satisfies ReadonlyArray<MysqlServer>) {
	describe.skipIf(server.url === undefined)(`MySQL migrations on ${server.name}`, () => {
		let target: Promise<Target> | undefined
		const open = () =>
			(target ??= (async () => {
				const [fresh, migrated] = await Promise.all([scratchDatabase(server, "fuzz_fresh"), scratchDatabase(server, "fuzz_migrated")])
				opened.push(fresh, migrated)
				return { fresh, migrated }
			})())
		const name = `schema changes match a fresh create and keep the rows (${server.name})`
		it(name, () => property(name, input, async (value) => migrates(value as Input, await open()), { runs: 30 }), 1_800_000)
	})
}
