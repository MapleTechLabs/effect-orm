// Diff two Postgres schemas into migration ops.
//
// Pure and offline, like `diffSchemas` for ClickHouse, with the same data-loss
// rule: dropping a table, a column or an enum type needs a `confirm_data_loss`
// hint. Postgres can change almost anything else in place (a column's type, a
// key, a default); a change the data cannot take (a type cast that fails, NOT
// NULL over existing nulls) fails when the migration runs, inside its
// transaction, and leaves the database as it was.
//
// Enums are the exception. Postgres can add a label (`ADD VALUE`, placed with
// `BEFORE`) and rename one (`RENAME VALUE`), but not remove or reorder labels:
// that needs a new type and every column moved to it, so it is reported as
// unsupported. A rename is read only where it is unambiguous (the same labels
// in the same order but for one swapped in place) and still asks for a
// `confirm_rename` hint, since the rows holding the old label change meaning.
//
// Renames of tables and columns are not detected: a renamed column reads as a
// drop plus an add, and the drop asks for confirmation.

import { canonicalJson, entityKey } from "./entities"
import { hintKey, type DiffResult, type Hint, type UnsupportedChange } from "./diff"
import {
	pgTypeName,
	type PgColumnEntity,
	type PgEnumEntity,
	type PgForeignKeyEntity,
	type PgIndexEntity,
	type PgSchemaEntity,
	type PgTableEntity,
	type PgUniqueEntity,
} from "./pg-entities"
import type { PgMigrationOp } from "./pg-ops"

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

const byKind = <K extends PgSchemaEntity["kind"]>(entities: ReadonlyArray<PgSchemaEntity>, kind: K) =>
	new Map(
		entities
			.filter((e): e is Extract<PgSchemaEntity, { kind: K }> => e.kind === kind)
			.map((e) => [entityKey(e), e] as const),
	)

// Enum types and labels come first, so every column can use them; constraints
// and indexes go next, so a dropped column or table is not still referenced;
// new tables exist before the indexes and keys that need them, a unique key
// before a foreign key that references it, and a type is dropped once nothing
// uses it.
const opOrder: Record<PgMigrationOp["op"], number> = {
	create_enum: 0,
	rename_enum_value: 1,
	add_enum_value: 2,
	drop_foreign_key: 3,
	drop_unique: 4,
	drop_index: 5,
	drop_column: 6,
	drop_table: 7,
	create_table: 8,
	add_column: 9,
	alter_column: 10,
	set_primary_key: 11,
	add_unique: 12,
	create_index: 13,
	add_foreign_key: 14,
	drop_enum: 15,
}

export const diffPgSchemas = (
	prev: ReadonlyArray<PgSchemaEntity>,
	next: ReadonlyArray<PgSchemaEntity>,
	hints: ReadonlyArray<Hint> = [],
): DiffResult<PgMigrationOp> => {
	const given = new Set(hints.map(hintKey))
	const ops: Array<PgMigrationOp> = []
	const missingHints: Array<Hint> = []
	const unsupported: Array<UnsupportedChange> = []

	const confirm = (hint: Hint, op: PgMigrationOp): void => {
		if (given.has(hintKey(hint))) ops.push(op)
		else missingHints.push(hint)
	}

	const addedLabels = diffEnums(byKind(prev, "enum"), byKind(next, "enum"), ops, confirm, unsupported)

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
	diffNamed(byKind(prev, "unique"), byKind(next, "unique"), prevTables, ops, {
		drop: (u: PgUniqueEntity) => ({ op: "drop_unique", table: u.table, name: u.name }),
		create: (u: PgUniqueEntity) => ({ op: "add_unique", unique: u }),
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
		unsupported: [...unsupported, ...usesOfNewLabels(addedLabels, ops, [...byKind(next, "column").values()])],
	}
}

/** Labels added per enum, keyed by the enum's name as a column type spells it. */
type AddedLabels = Map<string, ReadonlyArray<string>>

const enumLabel = (e: PgEnumEntity): string => (e.schema === null ? e.name : `${e.schema}.${e.name}`)

const diffEnums = (
	before: Map<string, PgEnumEntity>,
	after: Map<string, PgEnumEntity>,
	ops: Array<PgMigrationOp>,
	confirm: (hint: Hint, op: PgMigrationOp) => void,
	unsupported: Array<UnsupportedChange>,
): AddedLabels => {
	const added: AddedLabels = new Map()
	for (const [key, entity] of after) {
		const old = before.get(key)
		if (old === undefined) {
			ops.push({ op: "create_enum", enum: entity })
			continue
		}
		if (same(old.values, entity.values)) continue
		const ref = { schema: entity.schema, name: entity.name }
		const oldSet = new Set(old.values)
		const newSet = new Set(entity.values)
		const kept = entity.values.filter((v) => oldSet.has(v))
		if (same(kept, old.values)) {
			// Only additions: each new label goes before the next label that already exists.
			const labels: Array<string> = []
			entity.values.forEach((value, i) => {
				if (oldSet.has(value)) return
				const before = entity.values.slice(i + 1).find((v) => oldSet.has(v)) ?? null
				ops.push({ op: "add_enum_value", ...ref, value, before })
				labels.push(value)
			})
			added.set(pgTypeName(entity.schema, entity.name), labels)
			continue
		}
		const swapped =
			old.values.length === entity.values.length &&
			old.values.every((v, i) => v === entity.values[i] || (!newSet.has(v) && !oldSet.has(entity.values[i]!)))
		if (swapped) {
			old.values.forEach((from, i) => {
				const to = entity.values[i]!
				if (from === to) return
				confirm(
					{ type: "confirm_rename", kind: "enum_value", entity: `${enumLabel(entity)}.${from}`, to },
					{ op: "rename_enum_value", ...ref, from, to },
				)
			})
			continue
		}
		const removed = old.values.filter((v) => !newSet.has(v))
		unsupported.push({
			entity: enumLabel(entity),
			message: `${removed.length > 0 ? `removing ${removed.map((v) => JSON.stringify(v)).join(", ")}` : "reordering labels"} needs the type rebuilt: create a new type, move every column to it, drop the old one. Write it with generate --custom`,
		})
	}
	for (const [key, entity] of before) {
		if (after.has(key)) continue
		confirm(
			{ type: "confirm_data_loss", kind: "enum", entity: enumLabel(entity) },
			{ op: "drop_enum", schema: entity.schema, name: entity.name },
		)
	}
	return added
}

/**
 * A label `ALTER TYPE ... ADD VALUE` adds cannot be used until its
 * transaction commits, and a migration is one transaction. A default or a
 * partial-index predicate naming it would fail when the migration runs, so it
 * is reported now: add the label in one migration, use it in the next.
 */
const usesOfNewLabels = (
	added: AddedLabels,
	ops: ReadonlyArray<PgMigrationOp>,
	columns: ReadonlyArray<PgColumnEntity>,
): ReadonlyArray<UnsupportedChange> => {
	if (added.size === 0) return []
	const out: Array<UnsupportedChange> = []
	const labelsOf = (type: string) => added.get(type.replace(/(\[\])+$/, "")) ?? []
	const mentions = (sql: string | null, labels: ReadonlyArray<string>) =>
		sql === null ? [] : labels.filter((label) => sql.includes(`'${label.replace(/'/g, "''")}'`))
	const report = (entity: string, labels: ReadonlyArray<string>) => {
		for (const label of labels) {
			out.push({
				entity,
				message: `uses ${JSON.stringify(label)}, which this migration adds; Postgres cannot use a new enum label in the transaction that adds it. Generate the label alone first, then this change`,
			})
		}
	}
	const changedColumns = ops.flatMap((op) =>
		op.op === "create_table" ? op.columns : op.op === "add_column" ? [op.column] : op.op === "alter_column" ? [op.to] : [],
	)
	for (const column of changedColumns) report(`${column.table}.${column.name}`, mentions(column.default, labelsOf(column.type)))
	for (const op of ops) {
		if (op.op !== "create_index") continue
		const labels = columns.filter((c) => c.table === op.index.table).flatMap((c) => labelsOf(c.type))
		report(`${op.index.table}.${op.index.name}`, [...new Set(mentions(op.index.where, labels))])
	}
	return out
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

const diffNamed = <E extends PgIndexEntity | PgUniqueEntity | PgForeignKeyEntity>(
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
		// Only an index or unique constraint of a dropped table can be left to the DROP
		// TABLE; a foreign key is dropped either way, because one pointing *at* the table blocks it.
		if (entity.kind !== "foreign_key" && dropped.has(entity.table) && prevTables.has(`table:${entity.table}`)) continue
		ops.push(make.drop(entity))
	}
}
