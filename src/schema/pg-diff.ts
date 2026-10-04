// Diff two Postgres schemas into migration ops.
//
// Pure and offline, like `diffSchemas` for ClickHouse, with the same data-loss
// rule: dropping a table or a column needs a `confirm_data_loss` hint. Postgres
// can change almost anything else in place (a column's type, a key, a default),
// so nothing is reported as unsupported; a change the data cannot take (a type
// cast that fails, NOT NULL over existing nulls) fails when the migration runs,
// inside its transaction, and leaves the database as it was.
//
// Renames are not detected: a renamed column reads as a drop plus an add, and
// the drop asks for confirmation.

import { canonicalJson, entityKey } from "./entities"
import type { DiffResult, Hint } from "./diff"
import type { PgColumnEntity, PgForeignKeyEntity, PgIndexEntity, PgSchemaEntity, PgTableEntity } from "./pg-entities"
import type { PgMigrationOp } from "./pg-ops"

const hintKey = (hint: Hint): string => `${hint.type}:${hint.kind}:${hint.entity}`

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

const byKind = <K extends PgSchemaEntity["kind"]>(entities: ReadonlyArray<PgSchemaEntity>, kind: K) =>
	new Map(
		entities
			.filter((e): e is Extract<PgSchemaEntity, { kind: K }> => e.kind === kind)
			.map((e) => [entityKey(e), e] as const),
	)

// Constraints and indexes go first, so a dropped column or table is not still
// referenced; new tables exist before the indexes and keys that need them.
const opOrder: Record<PgMigrationOp["op"], number> = {
	drop_foreign_key: 0,
	drop_index: 1,
	drop_column: 2,
	drop_table: 3,
	create_table: 4,
	add_column: 5,
	alter_column: 6,
	set_primary_key: 7,
	create_index: 8,
	add_foreign_key: 9,
}

export const diffPgSchemas = (
	prev: ReadonlyArray<PgSchemaEntity>,
	next: ReadonlyArray<PgSchemaEntity>,
	hints: ReadonlyArray<Hint> = [],
): DiffResult<PgMigrationOp> => {
	const given = new Set(hints.map(hintKey))
	const ops: Array<PgMigrationOp> = []
	const missingHints: Array<Hint> = []

	const confirm = (hint: Hint, op: PgMigrationOp): void => {
		if (given.has(hintKey(hint))) ops.push(op)
		else missingHints.push(hint)
	}

	const prevTables = byKind(prev, "table")
	const nextTables = byKind(next, "table")
	const prevColumns = byKind(prev, "column")
	const nextColumns = byKind(next, "column")

	const columnsOf = (columns: Map<string, PgColumnEntity>, table: string): ReadonlyArray<PgColumnEntity> =>
		[...columns.values()].filter((c) => c.table === table).sort((a, b) => a.position - b.position)

	for (const [key, table] of nextTables) {
		if (!prevTables.has(key)) ops.push({ op: "create_table", table, columns: columnsOf(nextColumns, table.name) })
	}
	for (const [key, table] of prevTables) {
		if (!nextTables.has(key)) {
			confirm({ type: "confirm_data_loss", kind: "table", entity: table.name }, { op: "drop_table", name: table.name })
		}
	}

	for (const [key, after] of nextTables) {
		const before = prevTables.get(key)
		if (before === undefined) continue
		diffColumns(columnsOf(prevColumns, after.name), columnsOf(nextColumns, after.name), after.name, ops, confirm)
		diffPrimaryKey(before, after, ops)
	}

	// Indexes and foreign keys are diffed whole, across tables: one that moved
	// tables, or belongs to a table that was dropped and re-created, is a drop
	// and a create like any other change.
	diffNamed(byKind(prev, "index"), byKind(next, "index"), prevTables, ops, {
		drop: (i: PgIndexEntity) => ({ op: "drop_index", table: i.table, name: i.name }),
		create: (i: PgIndexEntity) => ({ op: "create_index", index: i }),
	})
	diffNamed(byKind(prev, "foreign_key"), byKind(next, "foreign_key"), prevTables, ops, {
		drop: (fk: PgForeignKeyEntity) => ({ op: "drop_foreign_key", table: fk.table, name: fk.name }),
		create: (fk: PgForeignKeyEntity) => ({ op: "add_foreign_key", foreignKey: fk }),
	})

	return {
		ops: ops
			.map((op, i) => [op, i] as const)
			.sort(([a, i], [b, j]) => opOrder[a.op] - opOrder[b.op] || i - j)
			.map(([op]) => op),
		missingHints,
		unsupported: [],
	}
}

const diffColumns = (
	before: ReadonlyArray<PgColumnEntity>,
	after: ReadonlyArray<PgColumnEntity>,
	table: string,
	ops: Array<PgMigrationOp>,
	confirm: (hint: Hint, op: PgMigrationOp) => void,
): void => {
	const beforeByName = new Map(before.map((c) => [c.name, c]))
	const afterNames = new Set(after.map((c) => c.name))
	for (const column of after) {
		const old = beforeByName.get(column.name)
		if (old === undefined) ops.push({ op: "add_column", column })
		// Position alone is not a change: Postgres cannot reorder columns, and the
		// order only matters to a CREATE TABLE.
		else if (old.type !== column.type || old.notNull !== column.notNull || old.default !== column.default || old.identity !== column.identity) {
			ops.push({ op: "alter_column", from: old, to: column })
		}
	}
	for (const column of before) {
		if (!afterNames.has(column.name)) {
			confirm(
				{ type: "confirm_data_loss", kind: "column", entity: `${table}.${column.name}` },
				{ op: "drop_column", table, name: column.name },
			)
		}
	}
}

const diffPrimaryKey = (before: PgTableEntity, after: PgTableEntity, ops: Array<PgMigrationOp>): void => {
	if (!same(before.primaryKey, after.primaryKey)) {
		ops.push({ op: "set_primary_key", table: after.name, from: before.primaryKey, to: after.primaryKey })
	}
}

const diffNamed = <E extends PgIndexEntity | PgForeignKeyEntity>(
	before: Map<string, E>,
	after: Map<string, E>,
	prevTables: Map<string, PgTableEntity>,
	ops: Array<PgMigrationOp>,
	make: { readonly drop: (e: E) => PgMigrationOp; readonly create: (e: E) => PgMigrationOp },
): void => {
	const dropped = new Set(ops.flatMap((op) => (op.op === "drop_table" ? [op.name] : [])))
	// A table that is gone takes its indexes and keys with it; dropping them first is still
	// correct, and keeps a foreign key from another table from blocking the DROP TABLE.
	for (const [key, entity] of after) {
		const old = before.get(key)
		if (old !== undefined && same(old, entity)) continue
		if (old !== undefined) ops.push(make.drop(old))
		ops.push(make.create(entity))
	}
	for (const [key, entity] of before) {
		if (after.has(key)) continue
		// Only an index of a dropped table can be left to the DROP TABLE; a foreign
		// key is dropped either way, because one pointing *at* the table blocks it.
		if (entity.kind === "index" && dropped.has(entity.table) && prevTables.has(`table:${entity.table}`)) continue
		ops.push(make.drop(entity))
	}
}
