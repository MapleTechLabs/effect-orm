// Diff two SQLite schemas into migration ops.
//
// Pure and offline, like `diffPgSchemas`, with the same data-loss rule:
// dropping a table or a column needs a `confirm_data_loss` hint.

import { canonicalJson, entityKey } from "./entities"
import { hintKey, type DiffResult, type Hint } from "./diff"
import type { SqliteColumnEntity, SqliteIndexEntity, SqliteSchemaEntity, SqliteTableEntity, SqliteUniqueEntity } from "./sqlite-entities"
import type { SqliteMigrationOp } from "./sqlite-ops"

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

const pick = <K extends SqliteSchemaEntity["kind"]>(entities: ReadonlyArray<SqliteSchemaEntity>, kind: K) =>
	entities.filter((e): e is Extract<SqliteSchemaEntity, { kind: K }> => e.kind === kind)

// Indexes go first, so no dropped column is still indexed; new tables and
// columns exist before the indexes that need them; a rebuilt table's indexes
// are created after it.
const opOrder: Record<SqliteMigrationOp["op"], number> = {
	rename_table: 0,
	rename_column: 1,
	drop_index: 2,
	drop_column: 3,
	drop_table: 4,
	create_table: 5,
	add_column: 6,
	rebuild_table: 7,
	create_index: 8,
}

export const diffSqliteSchemas = (
	prev: ReadonlyArray<SqliteSchemaEntity>,
	next: ReadonlyArray<SqliteSchemaEntity>,
	hints: ReadonlyArray<Hint> = [],
): DiffResult<SqliteMigrationOp> => {
	const given = new Set(hints.map(hintKey))
	const ops: Array<SqliteMigrationOp> = []
	const missingHints: Array<Hint> = []
	/** Push `op` once every hint it needs was given; otherwise report the missing ones. */
	const confirm = (needed: Hint | ReadonlyArray<Hint>, op: SqliteMigrationOp): void => {
		const missing = (Array.isArray(needed) ? needed : [needed]).filter((hint) => !given.has(hintKey(hint)))
		if (missing.length === 0) ops.push(op)
		else missingHints.push(...missing)
	}

	const tablesOf = (entities: ReadonlyArray<SqliteSchemaEntity>) => new Map(pick(entities, "table").map((t) => [t.name, t]))
	const prevTables = tablesOf(prev)
	const nextTables = tablesOf(next)
	const partsOf = <E extends SqliteColumnEntity | SqliteUniqueEntity | SqliteIndexEntity>(list: ReadonlyArray<E>, table: string) =>
		list.filter((e) => e.table === table)
	const columns = (entities: ReadonlyArray<SqliteSchemaEntity>, table: string) =>
		partsOf(pick(entities, "column"), table).sort((a, b) => a.position - b.position)

	for (const [name, table] of nextTables) {
		if (!prevTables.has(name)) ops.push({ op: "create_table", table, columns: columns(next, name), uniques: partsOf(pick(next, "unique"), name) })
	}
	for (const name of prevTables.keys()) {
		if (!nextTables.has(name)) confirm({ type: "confirm_data_loss", kind: "table", entity: name }, { op: "drop_table", name })
	}

	for (const [name, after] of nextTables) {
		const before = prevTables.get(name)
		if (before === undefined) continue
		diffTable(
			{ table: before, columns: columns(prev, name), uniques: partsOf(pick(prev, "unique"), name) },
			{ table: after, columns: columns(next, name), uniques: partsOf(pick(next, "unique"), name) },
			ops,
			confirm,
		)
	}
	const rebuilt = new Set(ops.flatMap((op) => (op.op === "rebuild_table" ? [op.table.name] : [])))

	const prevIndexes = new Map(pick(prev, "index").map((i) => [entityKey(i), i]))
	const nextIndexes = new Map(pick(next, "index").map((i) => [entityKey(i), i]))
	for (const [key, index] of nextIndexes) {
		const old = prevIndexes.get(key)
		// A rebuilt table lost its indexes with the old table; all of them are created again.
		if (old !== undefined && same(old, index) && !rebuilt.has(index.table)) continue
		if (old !== undefined && !rebuilt.has(index.table)) ops.push({ op: "drop_index", name: old.name })
		ops.push({ op: "create_index", index })
	}
	for (const [key, index] of prevIndexes) {
		// A dropped table takes its indexes with it.
		if (!nextIndexes.has(key) && nextTables.has(index.table) && !rebuilt.has(index.table)) ops.push({ op: "drop_index", name: index.name })
	}

	return {
		ops: ops
			.map((op, i) => [op, i] as const)
			.sort(([a, i], [b, j]) => opOrder[a.op] - opOrder[b.op] || i - j)
			.map(([op]) => op),
		missingHints,
		unsupported: [],
	}
}


interface TableState {
	readonly table: SqliteTableEntity
	readonly columns: ReadonlyArray<SqliteColumnEntity>
	readonly uniques: ReadonlyArray<SqliteUniqueEntity>
}

/** What a column is, apart from its place in the table. */
const definition = (column: SqliteColumnEntity) => ({ type: column.type, notNull: column.notNull, default: column.default })

/**
 * Can `ALTER TABLE ADD COLUMN` add it? Not to a key or a UNIQUE constraint,
 * not NOT NULL without a default, and not with an expression default, which
 * SQLite refuses there.
 */
const addable = (column: SqliteColumnEntity, after: TableState): boolean =>
	!(after.table.primaryKey?.columns ?? []).includes(column.name) &&
	!after.uniques.some((u) => u.columns.includes(column.name)) &&
	(!column.notNull || (column.default !== null && column.default.toUpperCase() !== "NULL")) &&
	(column.default === null || !/^\s*\(|^\s*current_(time|date|timestamp)\b/i.test(column.default))

/** Can `ALTER TABLE DROP COLUMN` drop it? Not from a key or a UNIQUE constraint. */
const droppable = (name: string, before: TableState): boolean =>
	!(before.table.primaryKey?.columns ?? []).includes(name) && !before.uniques.some((u) => u.columns.includes(name))

/**
 * One table's changes: ALTER TABLE where SQLite allows it, otherwise a
 * rebuild. A rebuild copies every column the two tables share.
 */
const diffTable = (
	before: TableState,
	after: TableState,
	ops: Array<SqliteMigrationOp>,
	confirm: (needed: Hint | ReadonlyArray<Hint>, op: SqliteMigrationOp) => void,
): void => {
	const name = after.table.name
	const old = new Map(before.columns.map((c) => [c.name, c]))
	const kept = new Set(after.columns.map((c) => c.name))
	const added = after.columns.filter((c) => !old.has(c.name))
	const dropped = before.columns.filter((c) => !kept.has(c.name))
	const changed = after.columns.filter((c) => old.has(c.name) && !same(definition(old.get(c.name)!), definition(c)))
	const needsRebuild =
		changed.length > 0 ||
		!same(before.table.primaryKey, after.table.primaryKey) ||
		!same(byName(before.uniques), byName(after.uniques)) ||
		added.some((c) => !addable(c, after)) ||
		dropped.some((c) => !droppable(c.name, before))
	const dropHint = (column: string): Hint => ({ type: "confirm_data_loss", kind: "column", entity: `${name}.${column}` })
	if (needsRebuild) {
		const rebuild: SqliteMigrationOp = {
			op: "rebuild_table",
			table: after.table,
			columns: after.columns,
			uniques: after.uniques,
			copy: after.columns.filter((c) => old.has(c.name)).map((c) => c.name),
		}
		confirm(dropped.map((c) => dropHint(c.name)), rebuild)
		return
	}
	for (const column of added) ops.push({ op: "add_column", column })
	for (const column of dropped) confirm(dropHint(column.name), { op: "drop_column", table: name, name: column.name })
}

const byName = (uniques: ReadonlyArray<SqliteUniqueEntity>) =>
	[...uniques].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
