// Fresh-create and migrated Postgres schemas must agree, including retained rows.
import fc from "fast-check"
import { Effect } from "effect"
import { PGlite } from "@electric-sql/pglite"
import { afterAll, describe, expect, it } from "vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { diffPgSchemas, pgEntitiesOf, renderPgOp, renderPgSchema } from "@maple-dev/effect-orm/schema"
import { FuzzFailure, property, withContext } from "./harness"
import { nastyString, portableStrings, wellFormed } from "./values"

interface Column {
	readonly name: string
	readonly nullable: boolean
	readonly default: boolean
}
interface Table {
	readonly name: string
	readonly columns: ReadonlyArray<Column>
	readonly indexed: boolean
	readonly unique: boolean
}
const columnNames = ["text", "number", "flag", "json", "array"] as const
const tablePlan = (name: string) => fc.record({
	name: fc.constant(name),
	columns: fc.shuffledSubarray([...columnNames], { minLength: 1 }).chain((names) => fc.tuple(...names.map((name) => fc.record({ name: fc.constant(name), nullable: fc.boolean(), default: fc.boolean() })))),
	indexed: fc.boolean(),
	unique: fc.boolean(),
})
const schemaPlan = fc.subarray(["t0", "t1"]).chain((names) => fc.tuple(...names.map(tablePlan)))
const text = nastyString(portableStrings).filter(wellFormed)
const input = fc.record({ before: schemaPlan, after: schemaPlan, text, count: fc.integer({ min: 0, max: 4 }), number: fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 5 }) })

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const defaults: Record<string, unknown> = { text: "it's\\default", number: 7, flag: true, json: { default: [null, true] }, array: ["a", "b'c"] }
const types = { text: PG.text, number: PG.int4, flag: PG.bool, json: PG.jsonb(), array: PG.array(PG.text) }
const entitiesOf = (tables: ReadonlyArray<Table>) => Effect.runSync(pgEntitiesOf(tables.map((table) => PG.table(table.name, {
	columns: {
		id: PG.int4,
		...Object.fromEntries(table.columns.map((column) => {
			const base = types[column.name as keyof typeof types]
			return [column.name, PG.column(column.nullable ? PG.nullable(base) : base, (column.default ? { default: defaults[column.name] } : {}) as never)]
		})),
	},
	primaryKey: ["id"],
	indexes: table.indexed ? [(table.unique ? PG.uniqueIndex : PG.index)(`${table.name}_idx`, ["id"])] : [],
}))))

let db: PGlite | undefined
const getDatabase = () => (db ??= new PGlite())
afterAll(async () => { await db?.close() })

const shape = async (database: PGlite) => ({
	columns: (await database.query(`SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, column_name`)).rows,
	indexes: (await database.query<{ tablename: string; indexname: string; indexdef: string }>(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY tablename, indexname`)).rows.map((row) => ({ ...row, indexdef: row.indexdef.replace(/(?:fresh|migrated)\./g, "") })),
})
const wireValue = (column: string, value: unknown): string => {
	if (value === null) return "NULL"
	if (column === "json") return `${quote(JSON.stringify(value))}::jsonb`
	if (column === "array") return `ARRAY[${(value as string[]).map(quote).join(", ")}]::text[]`
	return typeof value === "string" ? quote(value) : String(value)
}

describe("Postgres migrations", () => {
	const name = "postgres schema transitions match fresh creation and retain rows"
	it(name, () => property(name, input, async ({ before, after, text, count, number }) => {
		const database = getDatabase()
		const from = entitiesOf(before)
		const to = entitiesOf(after)
		const initial = diffPgSchemas(from, to)
		const diff = diffPgSchemas(from, to, initial.missingHints)
		const migration = diff.ops.flatMap(renderPgOp)
		const seeds = before.map((table) => {
			const next = after.find((next) => next.name === table.name)
			// Postgres cannot fill a newly NOT NULL column without a default for existing rows.
			const fits = next === undefined || next.columns.every((column) => table.columns.some((old) => old.name === column.name) || column.nullable || column.default)
			return { table, rows: Array.from({ length: fits ? count : 0 }, (_, i) => ({
				id: i,
				...Object.fromEntries(table.columns.map((column) => [column.name, column.nullable && (next?.columns.find((next) => next.name === column.name)?.nullable ?? true) && i % 3 === 0 ? null : column.name === "text" ? `${i}:${text}` : column.name === "number" ? number + i : column.name === "flag" ? i % 2 === 0 : column.name === "json" ? { value: text, nested: [i, null, true] } : [text, String(i)]])),
			})) }
		})
		await withContext({ before, after, migration, seeds }, async () => {
			expect(diff.unsupported).toEqual([])
			expect(diff.missingHints).toEqual([])
			await database.exec('DROP SCHEMA IF EXISTS fresh CASCADE; DROP SCHEMA IF EXISTS migrated CASCADE; CREATE SCHEMA fresh; CREATE SCHEMA migrated; SET search_path TO fresh')
			for (const sql of renderPgSchema(to)) await database.exec(sql)
			const fresh = await shape(database)
			await database.exec("SET search_path TO migrated")
			for (const sql of renderPgSchema(from)) await database.exec(sql)
			for (const { table, rows } of seeds) for (const row of rows) {
				const entries = Object.entries(row)
				await database.exec(`INSERT INTO "${table.name}" (${entries.map(([column]) => `"${column}"`).join(", ")}) VALUES (${entries.map(([column, value]) => wireValue(column, value)).join(", ")})`)
			}
			await database.exec("BEGIN")
			try {
				for (const sql of migration) await database.exec(sql)
				await database.exec("COMMIT")
			} catch (error) {
				await database.exec("ROLLBACK")
				throw new FuzzFailure(`Postgres migration failed: ${String(error)}`, { migration, seeds })
			}
			expect(await shape(database)).toEqual(fresh)
			for (const { table, rows } of seeds) {
				const next = after.find((next) => next.name === table.name)
				if (next === undefined) continue
				const expected = rows.map((row) => ({ id: row.id, ...Object.fromEntries(next.columns.map((column) => [column.name, Object.hasOwn(row, column.name) ? (row as Record<string, unknown>)[column.name] : column.default ? defaults[column.name] : null])) }))
				expect((await database.query(`SELECT * FROM "${table.name}" ORDER BY id`)).rows).toEqual(expected)
			}
		})
	}, { runs: 60 }), 300_000)
})

