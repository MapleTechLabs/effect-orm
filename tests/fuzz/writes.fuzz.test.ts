// Writes: random sequences of builder writes leave the table the model says.
//
// Each input gets a fresh scratch table on the dialect's first target (see
// `WriteSupport.scratch`), then runs a sequence of writes through the builder:
// multi-row inserts that leave defaulted or nullable columns out, INSERT …
// SELECT, ON CONFLICT DO NOTHING / DO UPDATE (with the existing and the
// proposed row), UPDATE and DELETE with a filter or `allRows()`, and RETURNING.
// After every write the table is read back and compared with a JS model of its
// rows, and RETURNING rows with the rows the model says the write touched.
//
// A write the dialect does not support (`WriteSupport`) is still generated, and
// must be refused at compile time: never run, never thrown.
import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"
import { classify } from "./build"
import { closeAll, dialects, type FuzzDialect } from "./dialects"
import type { WriteSupport } from "./dialects/types"
import { FuzzFailure, property, skip, withContext } from "./harness"
import { nastyString, wellFormed } from "./values"

afterAll(closeAll)

// Plans

interface Row {
	readonly Id: number
	readonly OrgId: string
	readonly Name: string
	readonly Note: string | null
	readonly Qty: number
}
/** A row to insert; `Note` and `Qty` may be left out (NULL, and the database default 5). */
interface NewRow {
	readonly Id: number
	readonly OrgId: string
	readonly Name: string
	readonly Note?: string | null
	readonly Qty?: number
}
type QtySet = { readonly k: "value"; readonly v: number } | { readonly k: "add"; readonly v: number } | { readonly k: "excluded" }
interface SetPlan {
	readonly Name?: string
	readonly Note?: string | null
	readonly Qty?: QtySet
}
type Where =
	| { readonly k: "id"; readonly op: "eq" | "lt" | "gt"; readonly v: number }
	| { readonly k: "name"; readonly v: string }
	| { readonly k: "note"; readonly isNull: boolean }
	| { readonly k: "org"; readonly v: string }
	| { readonly k: "and" | "or"; readonly a: Where; readonly b: Where }
type Conflict = { readonly action: "nothing"; readonly target: boolean } | { readonly action: "update"; readonly set: SetPlan }
type WriteOp =
	| { readonly k: "insert"; readonly rows: ReadonlyArray<NewRow>; readonly conflict?: Conflict; readonly returning: boolean }
	| { readonly k: "insertSelect"; readonly offset: number; readonly where: Where; readonly conflict?: Conflict; readonly returning: boolean }
	| { readonly k: "update"; readonly set: SetPlan; readonly where: Where | "all"; readonly returning: boolean }
	| { readonly k: "delete"; readonly where: Where | "all"; readonly returning: boolean }
export interface WritesInput {
	readonly ops: ReadonlyArray<WriteOp>
}

const DEFAULT_QTY = 5
const ids = fc.integer({ min: 1, max: 12 })
const org = fc.constantFrom("org_1", "org_2")

const generators = (dialect: FuzzDialect) => {
	const text = fc.oneof(
		{ weight: 3, arbitrary: fc.constantFrom("a", "b", "c", "it's", "x\\y") },
		{ weight: 1, arbitrary: nastyString(dialect.strings).filter(wellFormed) },
	)
	const newRow: fc.Arbitrary<NewRow> = fc.record(
		{ Id: ids, OrgId: org, Name: text, Note: fc.option(text, { nil: null }), Qty: fc.integer({ min: -5, max: 50 }) },
		{ requiredKeys: ["Id", "OrgId", "Name"] },
	)
	const qty = (excluded: boolean): fc.Arbitrary<QtySet> =>
		fc.oneof(
			fc.integer({ min: -5, max: 50 }).map((v): QtySet => ({ k: "value", v })),
			fc.integer({ min: -3, max: 3 }).map((v): QtySet => ({ k: "add", v })),
			...(excluded ? [fc.constant<QtySet>({ k: "excluded" })] : []),
		)
	const set = (excluded: boolean): fc.Arbitrary<SetPlan> =>
		fc
			.record({ Name: text, Note: fc.option(text, { nil: null }), Qty: qty(excluded) }, { requiredKeys: [] })
			.filter((s) => Object.keys(s).length > 0)
	const leaf: fc.Arbitrary<Where> = fc.oneof(
		fc.record({ k: fc.constant("id" as const), op: fc.constantFrom("eq" as const, "lt" as const, "gt" as const), v: ids }),
		fc.record({ k: fc.constant("name" as const), v: text }),
		fc.record({ k: fc.constant("note" as const), isNull: fc.boolean() }),
		fc.record({ k: fc.constant("org" as const), v: org }),
	)
	const where: fc.Arbitrary<Where> = fc.oneof(
		{ weight: 3, arbitrary: leaf },
		{ weight: 1, arbitrary: fc.record({ k: fc.constantFrom("and" as const, "or" as const), a: leaf, b: leaf }) },
	)
	const conflict: fc.Arbitrary<Conflict | undefined> = fc.option(
		fc.oneof(
			fc.record({ action: fc.constant("nothing" as const), target: fc.boolean() }),
			fc.record({ action: fc.constant("update" as const), set: set(true) }),
		),
		{ nil: undefined, freq: 2 },
	)
	const returning = fc.boolean()
	const op: fc.Arbitrary<WriteOp> = fc.oneof(
		{ weight: 3, arbitrary: fc.record({ k: fc.constant("insert" as const), rows: fc.array(newRow, { minLength: 1, maxLength: 4 }), conflict, returning }, { requiredKeys: ["k", "rows", "returning"] }) },
		{ weight: 1, arbitrary: fc.record({ k: fc.constant("insertSelect" as const), offset: fc.constantFrom(100, 1000, 10_000), where, conflict, returning }, { requiredKeys: ["k", "offset", "where", "returning"] }) },
		{ weight: 2, arbitrary: fc.record({ k: fc.constant("update" as const), set: set(false), where: fc.oneof({ weight: 4, arbitrary: where }, { weight: 1, arbitrary: fc.constant("all" as const) }), returning }) },
		{ weight: 1, arbitrary: fc.record({ k: fc.constant("delete" as const), where: fc.oneof({ weight: 4, arbitrary: where }, { weight: 1, arbitrary: fc.constant("all" as const) }), returning }) },
	)
	// The first write seeds rows, so later ones have something to change.
	const seed = fc.array(newRow, { minLength: 1, maxLength: 5 }).map((rows): WriteOp => ({ k: "insert", rows, returning: false }))
	return fc.tuple(seed, fc.array(op, { minLength: 1, maxLength: 5 })).map(([first, rest]): WritesInput => ({ ops: [first, ...rest] }))
}

// The model

const matches = (where: Where | "all", row: Row): boolean => {
	if (where === "all") return true
	switch (where.k) {
		case "id":
			return where.op === "eq" ? row.Id === where.v : where.op === "lt" ? row.Id < where.v : row.Id > where.v
		case "name":
			return row.Name === where.v
		case "note":
			return (row.Note === null) === where.isNull
		case "org":
			return row.OrgId === where.v
		case "and":
			return matches(where.a, row) && matches(where.b, row)
		case "or":
			return matches(where.a, row) || matches(where.b, row)
	}
}

const applySet = (set: SetPlan, row: Row, excluded?: Row): Row => ({
	...row,
	...(set.Name !== undefined ? { Name: set.Name } : {}),
	...(set.Note !== undefined ? { Note: set.Note } : {}),
	...(set.Qty === undefined
		? {}
		: { Qty: set.Qty.k === "value" ? set.Qty.v : set.Qty.k === "add" ? row.Qty + set.Qty.v : excluded!.Qty }),
})

const fullRow = (row: NewRow): Row => ({ Id: row.Id, OrgId: row.OrgId, Name: row.Name, Note: row.Note ?? null, Qty: row.Qty ?? DEFAULT_QTY })

/**
 * Rows inserted one by one, as the database does: a key that exists is a
 * conflict, skipped or updated. Returns the rows the statement inserted or
 * updated, which is what RETURNING gives.
 */
const insertRows = (state: Array<Row>, rows: ReadonlyArray<Row>, conflict: Conflict | undefined): Array<Row> => {
	const touched: Array<Row> = []
	for (const row of rows) {
		const at = state.findIndex((r) => r.Id === row.Id)
		if (at === -1) {
			state.push(row)
			touched.push(row)
		} else if (conflict?.action === "update") {
			state[at] = applySet(conflict.set, state[at]!, row)
			touched.push(state[at]!)
		}
	}
	return touched
}

/** Apply a write to the model; the rows RETURNING gives. */
const apply = (state: Array<Row>, op: WriteOp): Array<Row> => {
	switch (op.k) {
		case "insert":
			return insertRows(state, op.rows.map(fullRow), op.conflict)
		case "insertSelect":
			// The SELECT reads the table as it was before the statement.
			return insertRows(state, state.filter((row) => matches(op.where, row)).map((row) => ({ ...row, Id: row.Id + op.offset })), op.conflict)
		case "update": {
			const touched: Array<Row> = []
			for (const [i, row] of state.entries()) {
				if (!matches(op.where, row)) continue
				state[i] = applySet(op.set, row)
				touched.push(state[i]!)
			}
			return touched
		}
		case "delete": {
			const removed = state.filter((row) => matches(op.where, row))
			const kept = state.filter((row) => !matches(op.where, row))
			state.splice(0, state.length, ...kept)
			return removed
		}
	}
}

/**
 * Make a write valid for the table it meets: an insert without ON CONFLICT
 * gets fresh keys where its keys exist (a duplicate key is an error, not a
 * finding), and one with DO UPDATE no repeated key (Postgres refuses to update
 * a row twice in one statement).
 */
const repair = (state: ReadonlyArray<Row>, used: Set<number>, op: WriteOp): WriteOp => {
	const fresh = () => {
		let id = Math.max(0, ...used) + 1
		while (used.has(id)) id++
		return id
	}
	if (op.k === "insert") {
		const seen = new Set<number>()
		const rows = op.rows.map((row) => {
			const clash = op.conflict === undefined ? state.some((r) => r.Id === row.Id) || seen.has(row.Id) : op.conflict.action === "update" && seen.has(row.Id)
			const id = clash ? fresh() : row.Id
			seen.add(id)
			used.add(id)
			return id === row.Id ? row : { ...row, Id: id }
		})
		return { ...op, rows }
	}
	if (op.k === "insertSelect" && op.conflict === undefined) {
		const copies = state.filter((row) => matches(op.where, row)).map((row) => row.Id + op.offset)
		if (copies.some((id) => state.some((r) => r.Id === id))) skip("INSERT … SELECT would repeat a key")
		for (const id of copies) used.add(id)
	}
	if (op.k === "insertSelect") for (const row of state) used.add(row.Id + op.offset)
	return op
}

// Capabilities

/** The first feature `op` uses that the dialect does not support, if any. */
const unsupported = (support: WriteSupport, op: WriteOp): string | undefined => {
	if (op.k === "insertSelect" && !support.insertSelect) return "INSERT … SELECT"
	if (op.k === "update" && !support.update) return "UPDATE"
	if (op.k === "delete" && !support.delete) return "DELETE"
	if ((op.k === "insert" || op.k === "insertSelect") && op.conflict !== undefined && !support.onConflict) return "ON CONFLICT"
	if (op.returning && !support.returning) return "RETURNING"
	if (op.k === "insert" && !support.defaultCells && op.rows.length > 1) {
		for (const column of ["Note", "Qty"] as const) {
			const given = op.rows.filter((row) => Object.hasOwn(row, column)).length
			if (given > 0 && given < op.rows.length) return `DEFAULT for a missing ${column} in a multi-row VALUES`
		}
	}
	return undefined
}

// Builder calls

const whereCond = ($: any, where: Where): any => {
	switch (where.k) {
		case "id":
			return $.Id[where.op](where.v)
		case "name":
			return $.Name.eq(where.v)
		case "note":
			return where.isNull ? $.Note.isNull() : $.Note.isNotNull()
		case "org":
			return $.OrgId.eq(where.v)
		case "and":
		case "or":
			return whereCond($, where.a)[where.k](whereCond($, where.b))
	}
}

const setRecord = (set: SetPlan, $: any, excluded?: any): Record<string, unknown> => ({
	...(set.Name !== undefined ? { Name: set.Name } : {}),
	...(set.Note !== undefined ? { Note: set.Note } : {}),
	...(set.Qty === undefined ? {} : { Qty: set.Qty.k === "value" ? set.Qty.v : set.Qty.k === "add" ? $.Qty.add(set.Qty.v) : excluded.Qty }),
})

const buildWrite = (dialect: FuzzDialect, table: any, op: WriteOp): any => {
	const { insertInto, update, deleteFrom, from } = dialect.module
	let write: any
	const filtered = (w: any, where: Where | "all") => (where === "all" ? w.allRows() : w.where(($: any) => [whereCond($, where)]))
	switch (op.k) {
		case "insert":
			write = insertInto(table).values(op.rows.length === 1 ? (op.rows[0] as never) : (op.rows as never))
			break
		case "insertSelect":
			write = insertInto(table).select(
				(from(table) as any)
					.select(($: any) => ({ Id: $.Id.add(op.offset), OrgId: $.OrgId, Name: $.Name, Note: $.Note, Qty: $.Qty }))
					.where(($: any) => [whereCond($, op.where)]),
			)
			break
		case "update":
			write = filtered(update(table).set(($: any) => setRecord(op.set, $)), op.where)
			break
		case "delete":
			write = filtered(deleteFrom(table), op.where)
			break
	}
	if ((op.k === "insert" || op.k === "insertSelect") && op.conflict !== undefined) {
		const conflict = op.conflict
		write =
			conflict.action === "nothing"
				? write.onConflictDoNothing(conflict.target ? { target: ["Id"] } : {})
				: write.onConflictDoUpdate({ target: ["Id"], set: ($: any, excluded: any) => setRecord(conflict.set, $, excluded) })
	}
	return op.returning ? write.returning() : write
}

// The property

const byId = (rows: ReadonlyArray<Row>) => [...rows].sort((a, b) => a.Id - b.Id)
const asRows = (rows: ReadonlyArray<unknown>): Array<Row> =>
	rows.map((row) => {
		const r = row as Record<string, unknown>
		return { Id: Number(r.Id), OrgId: r.OrgId as string, Name: r.Name as string, Note: (r.Note ?? null) as string | null, Qty: Number(r.Qty) }
	})

let tables = 0

const writesMatchModel = async (dialect: FuzzDialect, input: WritesInput) => {
	const { scratch } = dialect.writes
	const target = dialect.targets[0]!
	const name = `fuzz_writes_${process.pid}_${tables++}`
	for (const sql of scratch.create(name)) await scratch.exec(sql)
	try {
		const table = scratch.table(name)
		const read = classify(() => dialect.module.compile((dialect.module.from(table) as any).select(), {}))
		if (read._tag !== "Compiled") throw new FuzzFailure("the scratch table's SELECT did not compile", { error: read.error })
		const state: Array<Row> = []
		const used = new Set<number>()
		for (const [step, planned] of input.ops.entries()) {
			const op = repair(state, used, planned)
			const missing = unsupported(dialect.writes, op)
			const result = classify(() => dialect.module.compile(buildWrite(dialect, table, op), {}))
			const context = { step, op, compiled: result._tag === "Compiled" ? { sql: result.compiled.sql, parameters: result.compiled.parameters } : result, before: byId(state) }
			if (result._tag === "Threw") throw new FuzzFailure("the builder threw instead of failing", context)
			if (missing !== undefined) {
				if (result._tag === "Compiled") throw new FuzzFailure(`${missing} compiled for ${dialect.name}, which does not support it`, context)
				continue
			}
			if (result._tag !== "Compiled") throw new FuzzFailure(`a supported write was not compiled (${result._tag})`, context)
			const touched = apply(state, op)
			const outcome = await target.run(result.compiled)
			const after = await target.run(read.compiled)
			await withContext({ ...context, outcome, expected: byId(state), returningExpected: op.returning ? byId(touched) : undefined, after }, () => {
				expect(outcome._tag).toBe("Rows")
				expect(after._tag).toBe("Rows")
				if (outcome._tag !== "Rows" || after._tag !== "Rows") return
				expect(byId(asRows(after.rows))).toEqual(byId(state))
				if (op.returning) expect(byId(asRows(outcome.rows))).toEqual(byId(touched))
			})
		}
	} finally {
		await scratch.exec(scratch.drop(name))
	}
}

describe("writes match the model", () => {
	for (const dialect of dialects) {
		const name = `writes match the model (${dialect.name})`
		it.skipIf(!dialect.targets[0]!.available)(name, () => property(name, generators(dialect), (input) => writesMatchModel(dialect, input), { runs: 40 }), 300_000)
	}
})
