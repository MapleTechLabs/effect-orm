// MySQL DDL rendering from entities: `CREATE TABLE` and `CREATE [UNIQUE] INDEX`.

import { mysqlDialect } from "../mysql/dialect"
import type { MysqlColumnEntity, MysqlIndexEntity, MysqlSchemaEntity, MysqlTableEntity, MysqlUniqueEntity } from "./mysql-entities"

/** An identifier, always backquoted, so mixed case and keywords survive. */
export const mysqlIdent = (name: string): string => mysqlDialect.quoteIdent(name)

export const mysqlIdentList = (names: ReadonlyArray<string>): string => names.map(mysqlIdent).join(", ")

/** One column's definition, as `CREATE TABLE`, `ADD COLUMN` and `MODIFY COLUMN` write it. */
export const renderMysqlColumnDefinition = (column: MysqlColumnEntity): string => {
	const parts = [mysqlIdent(column.name), column.type]
	if (column.notNull) parts.push("NOT NULL")
	if (column.default !== null) parts.push(`DEFAULT ${column.default}`)
	return parts.join(" ")
}

/** `CONSTRAINT <name> UNIQUE (...)`, in `CREATE TABLE` or after `ALTER TABLE ... ADD`. */
export const renderMysqlUnique = (unique: MysqlUniqueEntity): string => `CONSTRAINT ${mysqlIdent(unique.name)} UNIQUE (${mysqlIdentList(unique.columns)})`

export const renderMysqlCreateTable = (
	table: MysqlTableEntity,
	columns: ReadonlyArray<MysqlColumnEntity>,
	uniques: ReadonlyArray<MysqlUniqueEntity> = [],
): string => {
	const body = [...columns].sort((a, b) => a.position - b.position).map(renderMysqlColumnDefinition)
	if (table.primaryKey !== null) body.push(`PRIMARY KEY (${mysqlIdentList(table.primaryKey.columns)})`)
	for (const unique of uniques) body.push(renderMysqlUnique(unique))
	return `CREATE TABLE IF NOT EXISTS ${mysqlIdent(table.name)} (\n\t${body.join(",\n\t")}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
}

/** MySQL has no `CREATE INDEX IF NOT EXISTS` (MariaDB does), so none is written. */
export const renderMysqlCreateIndex = (index: MysqlIndexEntity): string =>
	`CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${mysqlIdent(index.name)} ON ${mysqlIdent(index.table)} (${index.columns.join(", ")})`

/** Every CREATE statement for a schema: tables, then indexes. */
export const renderMysqlSchema = (entities: ReadonlyArray<MysqlSchemaEntity>): ReadonlyArray<string> => {
	const columns = entities.filter((e): e is MysqlColumnEntity => e.kind === "column")
	const uniques = entities.filter((e): e is MysqlUniqueEntity => e.kind === "unique")
	return [
		...entities
			.filter((e): e is MysqlTableEntity => e.kind === "table")
			.map((table) =>
				renderMysqlCreateTable(
					table,
					columns.filter((c) => c.table === table.name),
					uniques.filter((u) => u.table === table.name),
				),
			),
		...entities.filter((e): e is MysqlIndexEntity => e.kind === "index").map(renderMysqlCreateIndex),
	]
}
