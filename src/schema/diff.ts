// Diff two schemas into migration ops.
//
// Pure and offline, like drizzle-kit's `generate`. Two things stop it from
// writing a migration on its own:
//
// - Data loss (dropping a table or a column) needs a `confirm_data_loss` hint,
//   from a prompt or from `--hints`. Without one the change is reported as a
//   missing hint and nothing is written, the way drizzle-kit exits 2.
// - Changes ClickHouse cannot make with ALTER (engine, sorting key, partition
//   key, primary key, column type) are reported as unsupported. They need a
//   table rebuild, which this version does not generate.
//
// Renames are not detected yet: a renamed column reads as a drop plus an add,
// and the drop asks for confirmation, so a rename never loses data silently.

import { Schema } from "effect"
import {
	canonicalJson,
	entityKey,
	type ColumnEntity,
	type IndexEntity,
	type MaterializedViewEntity,
	type SchemaEntity,
	type TableEntity,
} from "./entities"
import type { MigrationOp } from "./ops"

export const Hint = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("confirm_data_loss"),
		kind: Schema.Literals(["table", "column"]),
		/** `table` or `table.column`. */
		entity: Schema.String,
	}),
])
export type Hint = typeof Hint.Type

export const Hints = Schema.Array(Hint)

export interface UnsupportedChange {
	readonly entity: string
	readonly message: string
}

export interface DiffResult<Op = MigrationOp> {
	readonly ops: ReadonlyArray<Op>
	readonly missingHints: ReadonlyArray<Hint>
	readonly unsupported: ReadonlyArray<UnsupportedChange>
}

const hintKey = (hint: Hint): string => `${hint.type}:${hint.kind}:${hint.entity}`

const byKind = <K extends SchemaEntity["kind"]>(entities: ReadonlyArray<SchemaEntity>, kind: K) =>
	new Map(
		entities
			.filter((e): e is Extract<SchemaEntity, { kind: K }> => e.kind === kind)
			.map((e) => [entityKey(e), e] as const),
	)

/** Key order is not a change; the snapshot hash ignores it too. */
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

const opOrder: Record<MigrationOp["op"], number> = {
	drop_view: 0,
	drop_index: 1,
	drop_column: 2,
	drop_table: 3,
	create_table: 4,
	add_column: 5,
	modify_column: 6,
	modify_ttl: 7,
	modify_settings: 8,
	modify_comment: 9,
	add_index: 10,
	create_view: 11,
}

export const diffSchemas = (
	prev: ReadonlyArray<SchemaEntity>,
	next: ReadonlyArray<SchemaEntity>,
	hints: ReadonlyArray<Hint> = [],
): DiffResult => {
	const given = new Set(hints.map(hintKey))
	const ops: Array<MigrationOp> = []
	const missingHints: Array<Hint> = []
	const unsupported: Array<UnsupportedChange> = []

	const confirm = (hint: Hint, op: MigrationOp): void => {
		if (given.has(hintKey(hint))) ops.push(op)
		else missingHints.push(hint)
	}

	const prevTables = byKind(prev, "table")
	const nextTables = byKind(next, "table")
	const prevColumns = byKind(prev, "column")
	const nextColumns = byKind(next, "column")
	const prevIndexes = byKind(prev, "index")
	const nextIndexes = byKind(next, "index")

	const columnsOf = (columns: Map<string, ColumnEntity>, table: string): ReadonlyArray<ColumnEntity> =>
		[...columns.values()].filter((c) => c.table === table).sort((a, b) => a.position - b.position)
	const indexesOf = (indexes: Map<string, IndexEntity>, table: string): ReadonlyArray<IndexEntity> =>
		[...indexes.values()].filter((i) => i.table === table)

	for (const [key, table] of nextTables) {
		if (!prevTables.has(key)) {
			ops.push({
				op: "create_table",
				table,
				columns: columnsOf(nextColumns, table.name),
				indexes: indexesOf(nextIndexes, table.name),
			})
		}
	}
	for (const [key, table] of prevTables) {
		if (!nextTables.has(key)) {
			confirm({ type: "confirm_data_loss", kind: "table", entity: table.name }, { op: "drop_table", name: table.name })
		}
	}

	for (const [key, after] of nextTables) {
		const before = prevTables.get(key)
		if (before === undefined) continue
		diffTable(before, after, ops, unsupported)

		const beforeColumns = columnsOf(prevColumns, after.name)
		const afterColumns = columnsOf(nextColumns, after.name)
		const beforeByName = new Map(beforeColumns.map((c) => [c.name, c]))
		const afterNames = new Set(afterColumns.map((c) => c.name))

		afterColumns.forEach((column, i) => {
			const old = beforeByName.get(column.name)
			if (old === undefined) {
				ops.push({ op: "add_column", column, after: i === 0 ? null : afterColumns[i - 1]!.name })
				return
			}
			if (old.type !== column.type) {
				unsupported.push({
					entity: `${after.name}.${column.name}`,
					message: `type ${old.type} -> ${column.type} rewrites data and is not generated yet`,
				})
				return
			}
			if (!same(old.default, column.default) || old.codec !== column.codec || old.comment !== column.comment) {
				ops.push({ op: "modify_column", from: old, to: column })
			}
		})
		for (const column of beforeColumns) {
			if (!afterNames.has(column.name)) {
				confirm(
					{ type: "confirm_data_loss", kind: "column", entity: `${after.name}.${column.name}` },
					{ op: "drop_column", table: after.name, name: column.name },
				)
			}
		}

		const beforeIndexes = new Map(indexesOf(prevIndexes, after.name).map((i) => [i.name, i]))
		const afterIndexes = indexesOf(nextIndexes, after.name)
		for (const index of afterIndexes) {
			const old = beforeIndexes.get(index.name)
			if (old !== undefined && same(old, index)) continue
			if (old !== undefined) ops.push({ op: "drop_index", table: after.name, name: index.name })
			ops.push({ op: "add_index", index })
		}
		for (const old of beforeIndexes.values()) {
			if (!afterIndexes.some((i) => i.name === old.name)) {
				ops.push({ op: "drop_index", table: after.name, name: old.name })
			}
		}
	}

	diffViews(byKind(prev, "materialized_view"), byKind(next, "materialized_view"), ops)

	// Dropping a table a kept view still reads would leave that view failing every insert.
	const droppedTables = new Set(ops.flatMap((op) => (op.op === "drop_table" ? [op.name] : [])))
	for (const view of byKind(next, "materialized_view").values()) {
		for (const source of view.sources) {
			if (droppedTables.has(source)) {
				unsupported.push({ entity: view.name, message: `reads ${source}, which this migration drops` })
			}
		}
	}

	return {
		ops: ops.map((op, i) => [op, i] as const).sort(([a, i], [b, j]) => opOrder[a.op] - opOrder[b.op] || i - j).map(([op]) => op),
		missingHints,
		unsupported,
	}
}

const diffTable = (
	before: TableEntity,
	after: TableEntity,
	ops: Array<MigrationOp>,
	unsupported: Array<UnsupportedChange>,
): void => {
	const rebuild = (what: string, from: unknown, to: unknown) =>
		unsupported.push({
			entity: after.name,
			message: `${what} ${JSON.stringify(from)} -> ${JSON.stringify(to)} needs a table rebuild, which is not generated yet`,
		})
	if (!same(before.engine, after.engine)) rebuild("engine", before.engine, after.engine)
	if (before.orderBy !== after.orderBy) rebuild("ORDER BY", before.orderBy, after.orderBy)
	if (before.partitionBy !== after.partitionBy) rebuild("PARTITION BY", before.partitionBy, after.partitionBy)
	if (before.primaryKey !== after.primaryKey) rebuild("PRIMARY KEY", before.primaryKey, after.primaryKey)
	if (before.ttl !== after.ttl) ops.push({ op: "modify_ttl", table: after.name, ttl: after.ttl })
	const set = Object.fromEntries(Object.entries(after.settings).filter(([k, v]) => before.settings[k] !== v))
	const reset = Object.keys(before.settings).filter((k) => !(k in after.settings))
	if (Object.keys(set).length > 0 || reset.length > 0) ops.push({ op: "modify_settings", table: after.name, set, reset })
	if (before.comment !== after.comment) ops.push({ op: "modify_comment", table: after.name, comment: after.comment })
}

/** A view's body is frozen at creation, so any change is a drop and a re-create. */
const diffViews = (
	before: Map<string, MaterializedViewEntity>,
	after: Map<string, MaterializedViewEntity>,
	ops: Array<MigrationOp>,
): void => {
	for (const [key, view] of after) {
		const old = before.get(key)
		if (old !== undefined && same(old, view)) continue
		if (old !== undefined) ops.push({ op: "drop_view", name: view.name })
		ops.push({ op: "create_view", view })
	}
	for (const [key, view] of before) {
		if (!after.has(key)) ops.push({ op: "drop_view", name: view.name })
	}
}
