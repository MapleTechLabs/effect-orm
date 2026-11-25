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

// The order ops run in. Renames of tables first, so later ops use the new
// names. Index, UNIQUE and primary key drops next, so no column leaves a key
// it is still in, and no column becomes TEXT while an index still covers it.
// Generated columns that read a column about to be renamed or replaced are
// dropped before it (MySQL refuses either while a generated column reads it),
// then column renames. Base columns are added before the column changes,
// which run in declaration order, so a generated column is added, changed or
// added back only once the columns it reads are in place. Column adds before
// column drops: MySQL cannot drop a table's last column. Keys and indexes
// last, once their columns exist with their new definitions.
const Phase = {
	RenameTable: 0,
	DropKeys: 1,
	DropDependents: 2,
	RenameColumn: 3,
	AddBase: 4,
	ChangeColumns: 5,
	DropColumns: 6,
	DropTable: 7,
	CreateTable: 8,
	AddKeys: 9,
} as const
type Phase = (typeof Phase)[keyof typeof Phase]

const phaseOf: Record<MysqlMigrationOp["op"], Phase> = {
	rename_table: Phase.RenameTable,
	drop_index: Phase.DropKeys,
	drop_unique: Phase.DropKeys,
	drop_primary_key: Phase.DropKeys,
	rename_column: Phase.RenameColumn,
	add_column: Phase.AddBase,
	modify_column: Phase.ChangeColumns,
	replace_column: Phase.ChangeColumns,
	drop_column: Phase.DropColumns,
	drop_table: Phase.DropTable,
	create_table: Phase.CreateTable,
	add_primary_key: Phase.AddKeys,
	add_unique: Phase.AddKeys,
	create_index: Phase.AddKeys,
}

// Within the key drops and adds, the order they always ran in.
const keyOrder: Partial<Record<MysqlMigrationOp["op"], number>> = { drop_index: 0, drop_unique: 1, drop_primary_key: 2, add_primary_key: 0, add_unique: 1, create_index: 2 }

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
	// The phase an op runs in, when that is not its kind's.
	const phases = new Map<MysqlMigrationOp, Phase>()
	const missingHints: Array<Hint> = []
	const unsupported: Array<UnsupportedChange> = []
	const prev = applyRenames(original, next, hints, ops, unsupported)
	const confirm = (needed: ReadonlyArray<Hint>, op: MysqlMigrationOp, phase?: Phase): boolean => {
		const missing = needed.filter((hint) => !given.has(hintKey(hint)))
		if (missing.length > 0) {
			missingHints.push(...missing)
			return false
		}
		ops.push(op)
		if (phase !== undefined) phases.set(op, phase)
		return true
	}

	const tablesOf = (entities: ReadonlyArray<MysqlSchemaEntity>) => new Map(pick(entities, "table").map((t) => [t.name, t]))
	const prevTables = tablesOf(prev)
	const nextTables = tablesOf(next)
	const columns = (entities: ReadonlyArray<MysqlSchemaEntity>, table: string) =>
		pick(entities, "column")
			.filter((c) => c.table === table)
			.sort((a, b) => a.position - b.position)
	// A column's name before this migration's column renames, keyed `<table>.<new name>`.
	const renamedFrom = new Map(ops.flatMap((op) => (op.op === "rename_column" ? [[`${op.column.table}.${op.column.name}`, op.from] as const] : [])))

	for (const [name, table] of nextTables) {
		if (!prevTables.has(name)) ops.push({ op: "create_table", table, columns: columns(next, name), uniques: pick(next, "unique").filter((u) => u.table === name) })
	}
	for (const name of prevTables.keys()) {
		if (!nextTables.has(name)) confirm([{ type: "confirm_data_loss", kind: "table", entity: name }], { op: "drop_table", name })
	}

	// Columns dropped and added again (`<table>.<column>`): their indexes and UNIQUE constraints go first and come back after.
	const rebuilt = new Set<string>()
	for (const [name, after] of nextTables) {
		const before = prevTables.get(name)
		if (before === undefined) continue
		const was = columns(prev, name)
		const now = columns(next, name)
		const old = new Map(was.map((c) => [c.name, c]))
		const kept = new Set(now.map((c) => c.name))
		const dropHint = (column: string): Hint => ({ type: "confirm_data_loss", kind: "column", entity: `${name}.${column}` })
		const uniqueOn = (column: string) =>
			pick(next, "unique").some((u) => u.table === name && u.columns.includes(column)) ||
			pick(next, "index").some((i) => i.table === name && i.unique && i.columns.includes(mysqlIdent(column)))
		// Where a column goes: after the one declared before it, which exists by the time it runs.
		const placeOf = (column: MysqlColumnEntity): string | null => {
			const index = now.findIndex((c) => c.name === column.name)
			return index === 0 ? null : now[index - 1]!.name
		}

		// Columns renamed or dropped and added again: a generated column reading one is dropped
		// first and added back after, and so is one reading that, and so on.
		const moved = new Set<string>(was.flatMap((c) => (renamedFrom.has(`${name}.${c.name}`) ? [c.name] : [])))
		for (const column of now) {
			const prior = old.get(column.name)
			if (prior !== undefined && changeOf(prior, column) === "replace") moved.add(column.name)
		}
		// A column that is itself renamed or replaced still counts: renaming it, or dropping and
		// adding it back in one statement, would leave the column it reads with a reader. It is
		// dropped with the others and added back after, as it will be.
		const dependents: Array<MysqlColumnEntity> = []
		const isDependent = (column: string) => dependents.some((c) => c.name === column)
		for (let grew = true; grew; ) {
			grew = false
			for (const column of was) {
				if (column.generated === undefined || isDependent(column.name)) continue
				const reads = [...moved].filter((read) => read !== column.name && readsColumn(column, read, renamedFrom.get(`${name}.${read}`)))
				if (reads.length === 0) continue
				moved.add(column.name)
				dependents.push(column)
				grew = true
			}
		}
		// Dropped in an earlier phase, by the name it has then (before the column renames), the
		// last declared first: a generated column is read only by generated ones declared after it.
		const dependentNames = new Set(dependents.map((c) => c.name))
		for (const column of [...dependents].sort((a, b) => b.position - a.position)) {
			const from = renamedFrom.get(`${name}.${column.name}`)
			const dropName = from ?? column.name
			const drop: MysqlMigrationOp = { op: "drop_column", table: name, name: dropName }
			const ok = confirm(kept.has(column.name) ? [] : [dropHint(column.name)], drop, Phase.DropDependents)
			if (!ok) continue
			rebuilt.add(`${name}.${column.name}`)
			// Its rename is moot: it is added back under its new name.
			if (from !== undefined) {
				const rename = ops.findIndex((op) => op.op === "rename_column" && op.column.table === name && op.column.name === column.name)
				if (rename >= 0) ops.splice(rename, 1)
			}
		}
		// A generated column made base while it reads a moved column would lose its values.
		for (const column of now) {
			if (dependentNames.has(column.name) && column.generated === undefined) {
				unsupported.push({
					entity: `${name}.${column.name}`,
					message: "it stops being generated in the migration that renames or replaces a column it reads; make it a base column in a migration of its own",
				})
			}
		}

		// Base columns first, appended: a generated column may read a base column declared after it.
		for (const column of now) {
			if (!old.has(column.name) && column.generated === undefined) ops.push({ op: "add_column", column })
		}
		// Then every other change, in declaration order: a generated column reads only generated columns declared before it.
		for (const column of now) {
			const prior = old.get(column.name)
			if (prior === undefined) {
				if (column.generated !== undefined) phases.set(pushed({ op: "add_column", column, after: placeOf(column) }), Phase.ChangeColumns)
				continue
			}
			if (dependentNames.has(column.name)) {
				if (rebuilt.has(`${name}.${column.name}`)) phases.set(pushed({ op: "add_column", column, after: placeOf(column) }), Phase.ChangeColumns)
				continue
			}
			const change = changeOf(prior, column)
			if (change === "same") continue
			const from = generatedKind(prior)
			if (change === "replace") {
				if (from === "virtual" && column.generated === undefined && uniqueOn(column.name)) {
					unsupported.push({
						entity: `${name}.${column.name}`,
						message: "a VIRTUAL column made base under a UNIQUE key would be filled with its default on every row; make it STORED in one migration, then base in the next",
					})
					continue
				}
				// A base column's values are lost, either way; a generated one's are computed again.
				const lossy = from === "base" || column.generated === undefined
				if (confirm(lossy ? [dropHint(column.name)] : [], { op: "replace_column", column, was: from, after: placeOf(column) })) rebuilt.add(`${name}.${column.name}`)
				continue
			}
			// MODIFY: a new type converts a base column's values (or truncates them), and a base
			// column made STORED loses its values to the computed ones. Confirm either like a drop.
			const lossy = from === "base" && (prior.type !== column.type || column.generated !== undefined)
			confirm(lossy ? [dropHint(column.name)] : [], { op: "modify_column", column, fill: !prior.notNull && column.notNull })
		}
		// Generated columns before base ones, and the last declared first: a generated column
		// may read any base column, but only generated ones declared before it.
		const dropped = was.filter((c) => !kept.has(c.name) && !dependentNames.has(c.name))
		const dropOrder = [...dropped.filter((c) => c.generated !== undefined).reverse(), ...dropped.filter((c) => c.generated === undefined)]
		for (const column of dropOrder) confirm([dropHint(column.name)], { op: "drop_column", table: name, name: column.name })
		if (!same(before.primaryKey, after.primaryKey)) {
			if (before.primaryKey !== null) ops.push({ op: "drop_primary_key", table: name })
			if (after.primaryKey !== null) ops.push({ op: "add_primary_key", table: name, columns: after.primaryKey.columns })
		}
	}

	const coversRebuilt = (part: MysqlUniqueEntity | Extract<MysqlSchemaEntity, { kind: "index" }>) =>
		part.columns.some((column) => rebuilt.has(`${part.table}.${part.kind === "index" ? column.replace(/^`|`$/g, "").replace(/``/g, "`") : column}`))
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
			if (was !== undefined && same(was, part) && !coversRebuilt(was)) continue
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

	const rank = (op: MysqlMigrationOp) => [phases.get(op) ?? phaseOf[op.op], keyOrder[op.op] ?? 0] as const
	return {
		ops: result
			.map((op, i) => [op, rank(op), i] as const)
			.sort(([, [pa, ka], i], [, [pb, kb], j]) => pa - pb || ka - kb || i - j)
			.map(([op]) => op),
		missingHints,
		unsupported,
	}

	function pushed(op: MysqlMigrationOp): MysqlMigrationOp {
		ops.push(op)
		return op
	}
}

/**
 * How a column changes: not at all, in place (`MODIFY COLUMN`), or dropped and
 * added again. MySQL cannot MODIFY a column into or out of VIRTUAL; between
 * base and STORED it can, keeping the values.
 */
const changeOf = (was: MysqlColumnEntity, now: MysqlColumnEntity): "same" | "modify" | "replace" => {
	const from = generatedKind(was)
	const to = generatedKind(now)
	if (from !== to && (from === "virtual" || to === "virtual")) return "replace"
	return same(definition(was), definition(now)) ? "same" : "modify"
}

/**
 * Whether a generated column may read `column`: from what its DSL expression
 * read, or, for SQL written as a string, whenever its text names the column
 * (by its new name, or the one it had before a rename).
 */
const readsColumn = (generated: MysqlColumnEntity, column: string, formerly: string | undefined): boolean => {
	const reads = generated.generated?.reads
	if (reads !== undefined) return reads.includes(column)
	const expr = generated.generated?.expr ?? ""
	return [column, formerly].some((name) => name !== undefined && new RegExp(`(^|[^\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w$]|$)`, "i").test(expr))
}

/** What a column is, apart from its place in the table. What a generated expression reads follows from its text. */
const definition = (column: MysqlColumnEntity) => ({
	type: column.type,
	notNull: column.notNull,
	default: column.default,
	generated: column.generated === undefined ? null : { expr: column.generated.expr, stored: column.generated.stored },
})

/** Whether a column is generated, and how. */
const generatedKind = (column: MysqlColumnEntity): "base" | "stored" | "virtual" =>
	column.generated === undefined ? "base" : column.generated.stored ? "stored" : "virtual"

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
			if (e.kind === "column") {
				const reads = e.generated?.reads
				return { ...e, name: rename(e.name), ...(e.generated !== undefined && reads !== undefined ? { generated: { ...e.generated, reads: reads.map(rename) } } : undefined) }
			}
			if (e.kind === "unique") return { ...e, columns: e.columns.map(rename) }
			return { ...e, columns: e.columns.map((part) => (part === quoted ? mysqlIdent(hint.to) : part)) }
		})
	}
	return entities
}
