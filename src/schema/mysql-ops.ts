// MySQL / MariaDB migration operations and the SQL they render to.
//
// MySQL alters a table in place: every change is an ALTER TABLE (or RENAME
// TABLE, CREATE / DROP INDEX), never a copy into a new table. Its DDL is not
// transactional: each statement commits on its own, so a migration that
// fails part way leaves the statements before it applied.

import { Schema } from "effect"
import { MysqlColumnEntity, MysqlIndexEntity, MysqlTableEntity, MysqlUniqueEntity } from "./mysql-entities"
import { mysqlIdent, mysqlIdentList, renderMysqlColumnDefinition, renderMysqlCreateIndex, renderMysqlCreateTable, renderMysqlUnique } from "./mysql-render"

export const MysqlMigrationOp = Schema.Union([
	Schema.Struct({
		op: Schema.Literal("create_table"),
		table: MysqlTableEntity,
		columns: Schema.Array(MysqlColumnEntity),
		uniques: Schema.Array(MysqlUniqueEntity),
	}),
	Schema.Struct({ op: Schema.Literal("drop_table"), name: Schema.String }),
	Schema.Struct({ op: Schema.Literal("rename_table"), from: Schema.String, to: Schema.String }),
	Schema.Struct({ op: Schema.Literal("add_column"), column: MysqlColumnEntity }),
	Schema.Struct({ op: Schema.Literal("drop_column"), table: Schema.String, name: Schema.String }),
	/** `column` under its new name, with the definition it had: a definition change is a `modify_column` of its own. */
	Schema.Struct({ op: Schema.Literal("rename_column"), from: Schema.String, column: MysqlColumnEntity }),
	/** The column as it will be: a new type, nullability or default. `fill` sets existing NULLs to the default first. */
	Schema.Struct({ op: Schema.Literal("modify_column"), column: MysqlColumnEntity, fill: Schema.Boolean }),
	Schema.Struct({ op: Schema.Literal("drop_primary_key"), table: Schema.String }),
	Schema.Struct({ op: Schema.Literal("add_primary_key"), table: Schema.String, columns: Schema.Array(Schema.String) }),
	Schema.Struct({ op: Schema.Literal("add_unique"), unique: MysqlUniqueEntity }),
	Schema.Struct({ op: Schema.Literal("drop_unique"), table: Schema.String, name: Schema.String }),
	Schema.Struct({ op: Schema.Literal("create_index"), index: MysqlIndexEntity }),
	Schema.Struct({ op: Schema.Literal("drop_index"), table: Schema.String, name: Schema.String }),
])
export type MysqlMigrationOp = typeof MysqlMigrationOp.Type

/** Labels the plan prints. `rewrite`: MySQL may copy the table to change a column. */
export type MysqlOpLabel = "metadata" | "destructive" | "rewrite"

export const labelOfMysql = (op: MysqlMigrationOp): MysqlOpLabel => {
	switch (op.op) {
		case "drop_table":
		case "drop_column":
			return "destructive"
		case "modify_column":
		case "add_primary_key":
		case "drop_primary_key":
			return "rewrite"
		default:
			return "metadata"
	}
}

/** The statements one op runs, in order. */
export const renderMysqlOp = (op: MysqlMigrationOp): ReadonlyArray<string> => {
	switch (op.op) {
		case "create_table":
			return [renderMysqlCreateTable(op.table, op.columns, op.uniques)]
		case "drop_table":
			return [`DROP TABLE IF EXISTS ${mysqlIdent(op.name)}`]
		case "rename_table":
			return [`RENAME TABLE ${mysqlIdent(op.from)} TO ${mysqlIdent(op.to)}`]
		case "add_column":
			return [`ALTER TABLE ${mysqlIdent(op.column.table)} ADD COLUMN ${renderMysqlColumnDefinition(op.column)}`]
		case "drop_column":
			return [`ALTER TABLE ${mysqlIdent(op.table)} DROP COLUMN ${mysqlIdent(op.name)}`]
		case "rename_column":
			// CHANGE, not RENAME COLUMN: MariaDB names a JSON column's CHECK (json_valid(...)) after the
			// column and keeps the old name through a RENAME COLUMN, but not through a CHANGE.
			return [`ALTER TABLE ${mysqlIdent(op.column.table)} CHANGE COLUMN ${mysqlIdent(op.from)} ${renderMysqlColumnDefinition(op.column)}`]
		case "modify_column": {
			const { column } = op
			const modify = (to: MysqlColumnEntity) => `ALTER TABLE ${mysqlIdent(column.table)} MODIFY COLUMN ${renderMysqlColumnDefinition(to)}`
			// Strict mode refuses NOT NULL over existing NULLs; they take the default, as a new row
			// would. The column takes its new type first, so the default is a value of it.
			return op.fill && column.default !== null
				? [
						modify({ ...column, notNull: false }),
						`UPDATE ${mysqlIdent(column.table)} SET ${mysqlIdent(column.name)} = ${column.default} WHERE ${mysqlIdent(column.name)} IS NULL`,
						modify(column),
					]
				: [modify(column)]
		}
		case "drop_primary_key":
			return [`ALTER TABLE ${mysqlIdent(op.table)} DROP PRIMARY KEY`]
		case "add_primary_key":
			return [`ALTER TABLE ${mysqlIdent(op.table)} ADD PRIMARY KEY (${mysqlIdentList(op.columns)})`]
		case "add_unique":
			return [`ALTER TABLE ${mysqlIdent(op.unique.table)} ADD ${renderMysqlUnique(op.unique)}`]
		case "drop_unique":
		case "drop_index":
			return [`DROP INDEX ${mysqlIdent(op.name)} ON ${mysqlIdent(op.table)}`]
		case "create_index":
			return [renderMysqlCreateIndex(op.index)]
	}
}

/** A migration.sql: each op's statements under a comment naming its label, one statement per breakpoint. */
export const renderMysqlMigrationSql = (ops: ReadonlyArray<MysqlMigrationOp>, breakpoint: string): string =>
	`${ops.flatMap((op) => renderMysqlOp(op).map((statement) => `-- ${labelOfMysql(op)}\n${statement};`)).join(`\n${breakpoint}\n`)}\n`
