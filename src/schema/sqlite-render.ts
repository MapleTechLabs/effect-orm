// SQLite DDL rendering from entities: `CREATE TABLE` and `CREATE [UNIQUE] INDEX`.

import { sqliteDialect } from "../sqlite/dialect"
import type { SqliteColumnEntity, SqliteIndexEntity, SqliteSchemaEntity, SqliteTableEntity } from "./sqlite-entities"

/** An identifier, always double-quoted, so mixed case and keywords survive. */
export const sqliteIdent = (name: string): string => sqliteDialect.quoteIdent(name)

const list = (names: ReadonlyArray<string>): string => names.map(sqliteIdent).join(", ")

/** One column's definition. `primaryKey` writes the single-column key inline, as drizzle-kit does. */
export const renderSqliteColumnDefinition = (column: SqliteColumnEntity, primaryKey = false): string => {
	const parts = [sqliteIdent(column.name), column.type]
	if (primaryKey) parts.push("PRIMARY KEY")
	if (column.notNull) parts.push("NOT NULL")
	if (column.default !== null) parts.push(`DEFAULT ${column.default}`)
	return parts.join(" ")
}

export const renderSqliteCreateTable = (table: SqliteTableEntity, columns: ReadonlyArray<SqliteColumnEntity>): string => {
	const key = table.primaryKey?.columns ?? []
	const inline = key.length === 1 ? key[0] : undefined
	const body = [...columns]
		.sort((a, b) => a.position - b.position)
		.map((column) => renderSqliteColumnDefinition(column, column.name === inline))
	if (key.length > 1) body.push(`PRIMARY KEY (${list(key)})`)
	return `CREATE TABLE IF NOT EXISTS ${sqliteIdent(table.name)} (\n\t${body.join(",\n\t")}\n)`
}

export const renderSqliteCreateIndex = (index: SqliteIndexEntity): string =>
	`CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${sqliteIdent(index.name)} ON ${sqliteIdent(index.table)} (${index.columns.join(", ")})`

/** Every CREATE statement for a schema: tables, then indexes. */
export const renderSqliteSchema = (entities: ReadonlyArray<SqliteSchemaEntity>): ReadonlyArray<string> => {
	const columns = entities.filter((e): e is SqliteColumnEntity => e.kind === "column")
	return [
		...entities
			.filter((e): e is SqliteTableEntity => e.kind === "table")
			.map((table) => renderSqliteCreateTable(table, columns.filter((c) => c.table === table.name))),
		...entities.filter((e): e is SqliteIndexEntity => e.kind === "index").map(renderSqliteCreateIndex),
	]
}
