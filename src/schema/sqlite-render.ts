// SQLite DDL rendering from entities: `CREATE TABLE` and `CREATE [UNIQUE] INDEX`.

import { sqliteDialect } from "../sqlite/dialect"
import type { SqliteColumnEntity, SqliteIndexEntity, SqliteSchemaEntity, SqliteTableEntity, SqliteUniqueEntity } from "./sqlite-entities"

/** An identifier, always double-quoted, so mixed case and keywords survive. */
export const sqliteIdent = (name: string): string => sqliteDialect.quoteIdent(name)

const list = (names: ReadonlyArray<string>): string => names.map(sqliteIdent).join(", ")

/**
 * One column's definition. `primaryKey` writes the single-column key inline and
 * `unique` a one-column `UNIQUE` constraint, as drizzle-kit 1.0 does.
 */
export const renderSqliteColumnDefinition = (column: SqliteColumnEntity, primaryKey = false, unique = false): string => {
	const parts = [sqliteIdent(column.name), column.type]
	if (primaryKey) parts.push("PRIMARY KEY")
	if (unique) parts.push("UNIQUE")
	if (column.notNull) parts.push("NOT NULL")
	if (column.default !== null) parts.push(`DEFAULT ${column.default}`)
	return parts.join(" ")
}

export const renderSqliteCreateTable = (
	table: SqliteTableEntity,
	columns: ReadonlyArray<SqliteColumnEntity>,
	uniques: ReadonlyArray<SqliteUniqueEntity> = [],
): string => {
	const key = table.primaryKey?.columns ?? []
	const inline = key.length === 1 ? key[0] : undefined
	const inlineUnique = new Set(uniques.filter((u) => u.columns.length === 1).map((u) => u.columns[0]))
	const body = [...columns]
		.sort((a, b) => a.position - b.position)
		.map((column) => renderSqliteColumnDefinition(column, column.name === inline, inlineUnique.has(column.name)))
	if (key.length > 1) body.push(`PRIMARY KEY (${list(key)})`)
	for (const unique of uniques) if (unique.columns.length > 1) body.push(`UNIQUE (${list(unique.columns)})`)
	return `CREATE TABLE IF NOT EXISTS ${sqliteIdent(table.name)} (\n\t${body.join(",\n\t")}\n)`
}

export const renderSqliteCreateIndex = (index: SqliteIndexEntity): string =>
	`CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${sqliteIdent(index.name)} ON ${sqliteIdent(index.table)} (${index.columns.join(", ")})`

/** Every CREATE statement for a schema: tables, then indexes. */
export const renderSqliteSchema = (entities: ReadonlyArray<SqliteSchemaEntity>): ReadonlyArray<string> => {
	const columns = entities.filter((e): e is SqliteColumnEntity => e.kind === "column")
	const uniques = entities.filter((e): e is SqliteUniqueEntity => e.kind === "unique")
	return [
		...entities
			.filter((e): e is SqliteTableEntity => e.kind === "table")
			.map((table) =>
				renderSqliteCreateTable(
					table,
					columns.filter((c) => c.table === table.name),
					uniques.filter((u) => u.table === table.name),
				),
			),
		...entities.filter((e): e is SqliteIndexEntity => e.kind === "index").map(renderSqliteCreateIndex),
	]
}
