// Reading a drizzle-kit 1.0 SQLite snapshot (`snapshot.json`, version 7) as
// entities, so `generate --baseline --from-drizzle` can adopt a drizzle-kit
// folder the way it does for Postgres.
//
// Only what the entity model holds converts: tables, columns, primary keys,
// indexes and UNIQUE constraints. Anything else (foreign keys, checks, views,
// generated or AUTOINCREMENT columns, partial indexes) is reported, and nothing
// is written.
//
// One reading is deliberate. drizzle-kit 1.0 treats a primary key column as
// not null and leaves `notNull: false` (and the NOT NULL keyword) out of its
// output. It is read as not null here, which is what effect-orm declares and
// writes for a key column. A table drizzle-kit created then still accepts a
// NULL in a single text key column until the table is rebuilt.

import { sortEntities } from "./entities"
import { canonicalSqliteType, type SqliteSchemaEntity, type SqliteTableEntity } from "./sqlite-entities"
import { sqliteIdent } from "./sqlite-render"

export interface DrizzleSqliteImport {
	readonly entities: ReadonlyArray<SqliteSchemaEntity>
	/** Objects the snapshot holds that have no entity here. Empty when the import is complete. */
	readonly unsupported: ReadonlyArray<string>
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === "string" ? value : String(value))
const strings = (value: unknown): ReadonlyArray<string> => (Array.isArray(value) ? value.map(str) : [])

const indexPart = (part: unknown): string => {
	if (typeof part === "string") return sqliteIdent(part)
	if (!isRecord(part)) return str(part)
	return part.isExpression === true ? str(part.value) : sqliteIdent(str(part.value))
}

/** Convert a drizzle-kit 1.0 SQLite snapshot. */
export const fromDrizzleSqliteSnapshot = (json: unknown): DrizzleSqliteImport => {
	const unsupported: Array<string> = []
	if (!isRecord(json) || !Array.isArray(json.ddl)) {
		return { entities: [], unsupported: ["not a drizzle-kit snapshot: it has no ddl list"] }
	}
	if (json.dialect !== "sqlite" && json.dialect !== "turso") {
		unsupported.push(`dialect ${str(json.dialect)}: only SQLite snapshots convert here`)
	}
	const tables = new Map<string, { -readonly [K in keyof SqliteTableEntity]: SqliteTableEntity[K] }>()
	const entities: Array<SqliteSchemaEntity> = []
	const positions = new Map<string, number>()
	for (const raw of json.ddl as ReadonlyArray<unknown>) {
		if (!isRecord(raw)) continue
		const type = str(raw.entityType)
		const where = `${type} ${raw.table !== undefined ? `${str(raw.table)}.` : ""}${str(raw.name)}`
		switch (type) {
			case "tables":
				tables.set(str(raw.name), { kind: "table", name: str(raw.name), primaryKey: null })
				break
			case "columns": {
				const table = str(raw.table)
				if (raw.generated !== null && raw.generated !== undefined) unsupported.push(`${where}: a generated column`)
				if (raw.autoincrement === true) unsupported.push(`${where}: AUTOINCREMENT`)
				const position = positions.get(table) ?? 0
				positions.set(table, position + 1)
				entities.push({
					kind: "column",
					table,
					name: str(raw.name),
					position,
					type: canonicalSqliteType(str(raw.type)),
					notNull: raw.notNull === true,
					default: raw.default === null || raw.default === undefined ? null : str(raw.default),
				})
				break
			}
			case "pks": {
				const table = tables.get(str(raw.table))
				if (table === undefined) unsupported.push(`${where}: its table is not in the snapshot`)
				else table.primaryKey = { columns: strings(raw.columns) }
				break
			}
			case "indexes":
				if (typeof raw.where === "string" && raw.where.length > 0) unsupported.push(`${where}: a partial index`)
				entities.push({
					kind: "index",
					table: str(raw.table),
					name: str(raw.name),
					unique: raw.isUnique === true,
					columns: Array.isArray(raw.columns) ? raw.columns.map(indexPart) : [],
				})
				break
			case "uniques":
				entities.push({ kind: "unique", table: str(raw.table), name: str(raw.name), columns: strings(raw.columns) })
				break
			default:
				unsupported.push(where)
		}
	}
	const keyColumns = new Set([...tables.values()].flatMap((t) => (t.primaryKey?.columns ?? []).map((c) => `${t.name}.${c}`)))
	const columns = entities.map((e) => (e.kind === "column" && keyColumns.has(`${e.table}.${e.name}`) ? { ...e, notNull: true } : e))
	return { entities: sortEntities([...tables.values(), ...columns]), unsupported }
}
