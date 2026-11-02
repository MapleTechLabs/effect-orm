// Independent, shrinkable input data for the query oracle and database CTEs.
import fc from "fast-check"
import type { CoreContext } from "../core-cases"
import { fixtureRows } from "../core-cases"
import type { FuzzDialect } from "./dialects/types"
import { wireDateTime } from "./values"

export interface Order {
	readonly OrgId: string
	readonly Id: number
	readonly Customer: string
	readonly Amount: number
	readonly Status: string
	readonly Note: string | null
	readonly Created: number
}
export interface Customer {
	readonly OrgId: string
	readonly Name: string
	readonly Tier: string
}
export interface Fixture {
	readonly orders: ReadonlyArray<Order>
	readonly customers: ReadonlyArray<Customer>
}

export const coreFixture: Fixture = {
	orders: fixtureRows.orders.map(([OrgId, Id, Customer, Amount, Status, Note, Created]) => ({
		OrgId: OrgId as string, Id: Id as number, Customer: Customer as string, Amount: Amount as number,
		Status: Status as string, Note: Note as string | null, Created: Date.parse(`${(Created as string).replace(" ", "T")}Z`),
	})),
	customers: fixtureRows.customers.map(([OrgId, Name, Tier]) => ({ OrgId: OrgId as string, Name: Name as string, Tier: Tier as string })),
}

const org = fc.constantFrom("org_1", "org_2", "org_3")
const name = fc.constantFrom("acme", "globex", "initech", "umbrella", "it's", "")
/** Small shared pools deliberately produce matching keys, duplicates and missing joins. */
export const fixture: fc.Arbitrary<Fixture> = fc.record({
	orders: fc.array(fc.record({
		OrgId: org,
		Customer: name,
		Amount: fc.oneof(fc.constantFrom(0, 5, 7, 10, 20, 99), fc.integer({ min: -100, max: 120 })),
		Status: fc.constantFrom("paid", "open", "void", ""),
		Note: fc.option(fc.constantFrom("rush", "it's", "", "acme"), { nil: null }),
		Created: fc.integer({ min: 0, max: 4 }).map((i) => Date.UTC(2026, 0, 1) + i * 600_000),
	}), { maxLength: 10 }).map((rows) => rows.map((row, i) => ({ ...row, Id: i + 1 }))),
	customers: fc.array(fc.record({ OrgId: org, Name: name, Tier: fc.constantFrom("gold", "silver", "bronze", "platinum", "") }), { maxLength: 8 }),
})

const columns = {
	orders: [["OrgId", "String", "text"], ["Id", "UInt32", "int4"], ["Customer", "String", "text"], ["Amount", "Int64", "int8"], ["Status", "String", "text"], ["Note", "Nullable(String)", "text"], ["Created", "DateTime64(3, 'UTC')", "timestamptz"]],
	customers: [["OrgId", "String", "text"], ["Name", "String", "text"], ["Tier", "String", "text"]],
} as const

/** Values come from the restricted fixture pools, independently of the builder's literal writer. */
export const fixtureSource = (dialect: string, data: Fixture, table: keyof Fixture): string => {
	const defs = columns[table]
	const value = (v: unknown): string => v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`
	const select = (row: Order | Customer | undefined) => defs.map(([name, ch, pg]) => {
		const raw = row === undefined ? null : (row as unknown as Record<string, unknown>)[name]
		const v = name === "Created" && raw !== null ? wireDateTime(raw as number, true) : raw
		const type = dialect === "clickhouse" ? ch : dialect === "postgres" ? pg : name === "Id" || name === "Amount" ? "INTEGER" : "TEXT"
		// An empty relation still needs valid values for non-nullable ClickHouse casts.
		const empty = row === undefined && dialect === "clickhouse" ? (name === "Note" ? null : name === "Created" ? "2026-01-01 00:00:00.000" : type.startsWith("U") || type === "Int64" ? 0 : "") : v
		return `CAST(${value(empty)} AS ${type}) AS "${name}"`
	}).join(", ")
	if (dialect === "clickhouse" && data[table].length > 0) {
		// Match the core fixture's values() source. ClickHouse 26.2 incorrectly
		// pushes DISTINCT/OFFSET into UNION ALL sources made from constant SELECTs.
		const structure = defs.map(([name, type]) => `${name} ${type}`).join(", ")
		const tuples = data[table].map((row) => `(${defs.map(([name]) => {
			const raw = (row as unknown as Record<string, unknown>)[name]
			return value(name === "Created" ? wireDateTime(raw as number, true) : raw)
		}).join(", ")})`).join(", ")
		return `SELECT * FROM values('${structure.replaceAll("'", "\\'")}', ${tuples})`
	}
	if ((dialect === "sqlite" || dialect === "d1") && data[table].length > 0) {
		// D1 caps compound SELECTs at five terms; VALUES has no such row limit.
		const tuples = data[table].map((row) => `(${defs.map(([name]) => {
			const raw = (row as unknown as Record<string, unknown>)[name]
			return value(name === "Created" ? wireDateTime(raw as number, true) : raw)
		}).join(", ")})`).join(", ")
		return `SELECT ${defs.map(([name], i) => `column${i + 1} AS "${name}"`).join(", ")} FROM (VALUES ${tuples})`
	}
	return data[table].length === 0 ? `SELECT ${select(undefined)} WHERE 1 = 0` : data[table].map((row) => `SELECT ${select(row)}`).join(" UNION ALL ")
}

export const fixtureContext = (dialect: FuzzDialect, data: Fixture): CoreContext => ({
	...dialect.context,
	from: ((table) => dialect.module.from(table)
		.withCTE("orders", fixtureSource(dialect.name, data, "orders"))
		.withCTE("customers", fixtureSource(dialect.name, data, "customers"))) as CoreContext["from"],
})
