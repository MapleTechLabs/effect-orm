// Diff two MySQL schemas into migration ops.
//
// Pure and offline, like `diffSqliteSchemas`, with the same data-loss rule:
// dropping a table or a column, or changing a column's type, needs a
// `confirm_data_loss` hint. MySQL alters in place, so every change is an
// ALTER TABLE of its own (see `mysql-ops.ts`). Renames are never guessed, but
// for a column renamed by case only: a `confirm_rename` hint turns a drop
// plus an add into a RENAME.

import { canonicalJson, entityKey } from "./entities"
import { hintKey, type DiffResult, type Hint, type UnsupportedChange } from "./diff"
import type { MysqlColumnEntity, MysqlSchemaEntity, MysqlUniqueEntity } from "./mysql-entities"
import type { MysqlMigrationOp } from "./mysql-ops"
import { mysqlIdent } from "./mysql-render"

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

const pick = <K extends MysqlSchemaEntity["kind"]>(entities: ReadonlyArray<MysqlSchemaEntity>, kind: K) =>
	entities.filter((e): e is Extract<MysqlSchemaEntity, { kind: K }> => e.kind === kind)

// Renames first, so later ops use the new names. Index, UNIQUE and primary
// key drops before column changes, so no column leaves a key it is still in,
// and no column becomes TEXT while an index still covers it. Column adds
// before column drops: MySQL cannot drop a table's last column. Keys and
// indexes last, once their columns exist with their new definitions.
const opOrder: Record<MysqlMigrationOp["op"], number> = {
	rename_table: 0,
	rename_column: 1,
	drop_index: 2,
	drop_unique: 3,
	drop_primary_key: 4,
	add_column: 5,
	modify_column: 6,
	drop_column: 7,
	drop_table: 8,
	create_table: 9,
	add_primary_key: 10,
	add_unique: 11,
	create_index: 12,
}

export const diffMysqlSchemas = (
	original: ReadonlyArray<MysqlSchemaEntity>,
	next: ReadonlyArray<MysqlSchemaEntity>,
	hints: ReadonlyArray<Hint> = [],
): DiffResult<MysqlMigrationOp> => {
	// MySQL compares column names without case: `Name` to `name` is the same column, renamed,
	// never a drop and an add (which would collide). No hint needed: nothing is lost.
	hints = [...hints, ...caseOnlyColumnRenames(original, next, hints)]
	const given = new Set(hints.map(hintKey))
	const ops: Array<MysqlMigrationOp> = []
	const missingHints: Array<Hint> = []
	const unsupported: Array<UnsupportedChange> = []
	const prev = applyRenames(original, next, hints, ops, unsupported)
	const confirm = (needed: ReadonlyArray<Hint>, op: MysqlMigrationOp): void => {
		const missing = needed.filter((hint) => !given.has(hintKey(hint)))
		if (missing.length === 0) ops.push(op)
		else missingHints.push(...missing)
	}

	const tablesOf = (entities: ReadonlyArray<MysqlSchemaEntity>) => new Map(pick(entities, "table").map((t) => [t.name, t]))
	const prevTables = tablesOf(prev)
	const nextTables = tablesOf(next)
	const columns = (entities: ReadonlyArray<MysqlSchemaEntity>, table: string) =>
		pick(entities, "column")
			.filter((c) => c.table === table)
			.sort((a, b) => a.position - b.position)

	for (const [name, table] of nextTables) {
		if (!prevTables.has(name)) ops.push({ op: "create_table", table, columns: columns(next, name), uniques: pick(next, "unique").filter((u) => u.table === name) })
	}
	for (const name of prevTables.keys()) {
		if (!nextTables.has(name)) confirm([{ type: "confirm_data_loss", kind: "table", entity: name }], { op: "drop_table", name })
	}

	for (const [name, after] of nextTables) {
		const before = prevTables.get(name)
		if (before === undefined) continue
		const old = new Map(columns(prev, name).map((c) => [c.name, c]))
		const kept = new Set(columns(next, name).map((c) => c.name))
		const dropHint = (column: string): Hint => ({ type: "confirm_data_loss", kind: "column", entity: `${name}.${column}` })
		for (const column of columns(next, name)) {
			const was = old.get(column.name)
			if (was === undefined) ops.push({ op: "add_column", column })
			else if (!same(definition(was), definition(column))) {
				// A new type converts the column's values (or truncates them): confirm it like a drop.
				const op: MysqlMigrationOp = { op: "modify_column", column, fill: !was.notNull && column.notNull }
				confirm(was.type === column.type ? [] : [dropHint(column.name)], op)
			}
		}
		for (const column of old.values()) {
			if (!kept.has(column.name)) confirm([dropHint(column.name)], { op: "drop_column", table: name, name: column.name })
		}
		if (!same(before.primaryKey, after.primaryKey)) {
			if (before.primaryKey !== null) ops.push({ op: "drop_primary_key", table: name })
			if (after.primaryKey !== null) ops.push({ op: "add_primary_key", table: name, columns: after.primaryKey.columns })
		}
	}

	// Indexes and UNIQUE constraints share a table's index namespace: drops run before adds.
	const diffParts = <E extends MysqlUniqueEntity | Extract<MysqlSchemaEntity, { kind: "index" }>>(
		before: ReadonlyArray<E>,
		after: ReadonlyArray<E>,
		add: (e: E) => MysqlMigrationOp,
		drop: (e: E) => MysqlMigrationOp,
	) => {
		const prevParts = new Map(before.map((e) => [entityKey(e), e]))
		const nextParts = new Map(after.map((e) => [entityKey(e), e]))
		for (const [key, part] of nextParts) {
			const was = prevParts.get(key)
			if (was !== undefined && same(was, part)) continue
			if (was !== undefined) ops.push(drop(was))
			ops.push(add(part))
		}
		for (const [key, part] of prevParts) {
			// A dropped table takes its indexes with it.
			if (!nextParts.has(key) && nextTables.has(part.table)) ops.push(drop(part))
		}
	}
	diffParts(pick(prev, "index"), pick(next, "index"), (index) => ({ op: "create_index", index }), (index) => ({ op: "drop_index", table: index.table, name: index.name }))
	diffParts(pick(prev, "unique"), pick(next, "unique"), (unique) => ({ op: "add_unique", unique }), (unique) => ({ op: "drop_unique", table: unique.table, name: unique.name }))
	// A table created in this migration has its UNIQUE constraints in its CREATE TABLE.
	const created = new Set(ops.flatMap((op) => (op.op === "create_table" ? [op.table.name] : [])))
	const result = ops.filter((op) => !(op.op === "add_unique" && created.has(op.unique.table)))

	return {
		ops: result
			.map((op, i) => [op, i] as const)
			.sort(([a, i], [b, j]) => opOrder[a.op] - opOrder[b.op] || i - j)
			.map(([op]) => op),
		missingHints,
		unsupported,
	}
}

/** What a column is, apart from its place in the table. */
const definition = (column: MysqlColumnEntity) => ({ type: column.type, notNull: column.notNull, default: column.default })

/**
 * `confirm_rename` hints for column names that differ only in case: a next
 * column with no exact match whose name, ignoring case, is an old one's that
 * is gone. Columns are matched in the table's new name.
 */
const caseOnlyColumnRenames = (prev: ReadonlyArray<MysqlSchemaEntity>, next: ReadonlyArray<MysqlSchemaEntity>, hints: ReadonlyArray<Hint>): Array<Hint> => {
	const source = new Map(hints.flatMap((h) => (h.type === "confirm_rename" && h.kind === "table" ? [[h.to, h.entity] as const] : [])))
	const columnsOf = (entities: ReadonlyArray<MysqlSchemaEntity>, table: string) => pick(entities, "column").filter((c) => c.table === table).map((c) => c.name)
	const hinted = new Set(hints.flatMap((h) => (h.type === "confirm_rename" && h.kind === "column" ? [h.entity] : [])))
	const renames: Array<Hint> = []
	for (const table of pick(next, "table").map((t) => t.name)) {
		const before = columnsOf(prev, source.get(table) ?? table)
		const after = columnsOf(next, table)
		for (const name of after) {
			if (before.includes(name)) continue
			const old = before.find((b) => b.toLowerCase() === name.toLowerCase() && !after.includes(b))
			if (old !== undefined && !hinted.has(`${table}.${old}`)) renames.push({ type: "confirm_rename", kind: "column", entity: `${table}.${old}`, to: name })
		}
	}
	return renames
}

/**
 * Apply the `confirm_rename` hints for tables and columns: an op for each, and
 * `prev` as it reads after them. A RENAME keeps the table's indexes and
 * constraints, and a renamed column's keys follow it, so they are renamed
 * here too. A hint that does not match the two schemas is
 * reported.
 */
const applyRenames = (
	prev: ReadonlyArray<MysqlSchemaEntity>,
	next: ReadonlyArray<MysqlSchemaEntity>,
	hints: ReadonlyArray<Hint>,
	ops: Array<MysqlMigrationOp>,
	unsupported: Array<UnsupportedChange>,
): ReadonlyArray<MysqlSchemaEntity> => {
	let entities = prev
	const has = (list: ReadonlyArray<MysqlSchemaEntity>, kind: "table" | "column", table: string, name?: string) =>
		list.some((e) => (kind === "table" ? e.kind === "table" && e.name === table : e.kind === "column" && e.table === table && e.name === name))
	for (const hint of hints) {
		if (hint.type !== "confirm_rename" || hint.kind !== "table") continue
		if (!has(entities, "table", hint.entity) || has(entities, "table", hint.to) || !has(next, "table", hint.to) || has(next, "table", hint.entity)) {
			unsupported.push({ entity: hint.entity, message: `cannot rename to ${hint.to}: the old table must exist only before, and the new one only after` })
			continue
		}
		ops.push({ op: "rename_table", from: hint.entity, to: hint.to })
		entities = entities.map((e) => (e.kind === "table" ? (e.name === hint.entity ? { ...e, name: hint.to } : e) : e.table === hint.entity ? { ...e, table: hint.to } : e))
	}
	for (const hint of hints) {
		if (hint.type !== "confirm_rename" || hint.kind !== "column") continue
		const dot = hint.entity.lastIndexOf(".")
		const table = hint.entity.slice(0, dot)
		const from = hint.entity.slice(dot + 1)
		if (dot <= 0 || !has(entities, "column", table, from) || has(entities, "column", table, hint.to) || !has(next, "column", table, hint.to) || has(next, "column", table, from)) {
			unsupported.push({ entity: hint.entity, message: `cannot rename to ${hint.to}: the old column must exist only before, and the new one only after` })
			continue
		}
		const renamed = entities.find((e): e is MysqlColumnEntity => e.kind === "column" && e.table === table && e.name === from)!
		ops.push({ op: "rename_column", from, column: { ...renamed, name: hint.to } })
		const rename = (name: string) => (name === from ? hint.to : name)
		const quoted = mysqlIdent(from)
		entities = entities.map((e): MysqlSchemaEntity => {
			if (e.kind === "table") return e.name === table && e.primaryKey !== null ? { ...e, primaryKey: { columns: e.primaryKey.columns.map(rename) } } : e
			if (e.table !== table) return e
			if (e.kind === "column") return { ...e, name: rename(e.name) }
			if (e.kind === "unique") return { ...e, columns: e.columns.map(rename) }
			return { ...e, columns: e.columns.map((part) => (part === quoted ? mysqlIdent(hint.to) : part)) }
		})
	}
	return entities
}
