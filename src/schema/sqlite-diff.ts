// Diff two SQLite schemas into migration ops.
//
// Pure and offline, like `diffPgSchemas`, with the same data-loss rule:
// dropping a table or a column needs a `confirm_data_loss` hint.

import { canonicalJson, entityKey } from "./entities"
import { hintKey, type DiffResult, type Hint } from "./diff"
import type { SqliteColumnEntity, SqliteIndexEntity, SqliteSchemaEntity, SqliteUniqueEntity } from "./sqlite-entities"
import type { SqliteMigrationOp } from "./sqlite-ops"

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

const pick = <K extends SqliteSchemaEntity["kind"]>(entities: ReadonlyArray<SqliteSchemaEntity>, kind: K) =>
	entities.filter((e): e is Extract<SqliteSchemaEntity, { kind: K }> => e.kind === kind)

const opOrder: Record<SqliteMigrationOp["op"], number> = {
	drop_index: 0,
	drop_table: 1,
	create_table: 2,
	create_index: 3,
	rename_table: 0,
	rename_column: 0,
	add_column: 0,
	drop_column: 0,
	rebuild_table: 0,
}

export const diffSqliteSchemas = (
	prev: ReadonlyArray<SqliteSchemaEntity>,
	next: ReadonlyArray<SqliteSchemaEntity>,
	hints: ReadonlyArray<Hint> = [],
): DiffResult<SqliteMigrationOp> => {
	const given = new Set(hints.map(hintKey))
	const ops: Array<SqliteMigrationOp> = []
	const missingHints: Array<Hint> = []
	const confirm = (hint: Hint, op: SqliteMigrationOp): void => {
		if (given.has(hintKey(hint))) ops.push(op)
		else missingHints.push(hint)
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

	const prevIndexes = new Map(pick(prev, "index").map((i) => [entityKey(i), i]))
	const nextIndexes = new Map(pick(next, "index").map((i) => [entityKey(i), i]))
	for (const [key, index] of nextIndexes) {
		const old = prevIndexes.get(key)
		if (old !== undefined && same(old, index)) continue
		if (old !== undefined) ops.push({ op: "drop_index", name: old.name })
		ops.push({ op: "create_index", index })
	}
	for (const [key, index] of prevIndexes) {
		// A dropped table takes its indexes with it.
		if (!nextIndexes.has(key) && nextTables.has(index.table)) ops.push({ op: "drop_index", name: index.name })
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

