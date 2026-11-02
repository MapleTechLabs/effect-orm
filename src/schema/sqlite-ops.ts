// SQLite migration operations and the SQL they render to.
//
// SQLite's ALTER TABLE can rename a table or a column, add a column and drop
// one, and little else. Any other change (a column's type, nullability or
// default, the primary key, a UNIQUE constraint) is a table rebuild: the
// procedure https://www.sqlite.org/lang_altertable.html#otheralter describes,
// as drizzle-kit writes it. Create the new table under a temporary name, copy
// the rows, drop the old table, rename the new one into place, and create its
// indexes again (dropping the table dropped them).

import { Schema } from "effect"
import { SqliteColumnEntity, SqliteIndexEntity, SqliteTableEntity, SqliteUniqueEntity } from "./sqlite-entities"
import { renderSqliteColumnDefinition, renderSqliteCreateIndex, renderSqliteCreateTable, sqliteIdent } from "./sqlite-render"

export const SqliteMigrationOp = Schema.Union([
	Schema.Struct({
		op: Schema.Literal("create_table"),
		table: SqliteTableEntity,
		columns: Schema.Array(SqliteColumnEntity),
		uniques: Schema.Array(SqliteUniqueEntity),
	}),
	Schema.Struct({ op: Schema.Literal("drop_table"), name: Schema.String }),
	Schema.Struct({ op: Schema.Literal("rename_table"), from: Schema.String, to: Schema.String }),
	Schema.Struct({ op: Schema.Literal("add_column"), column: SqliteColumnEntity }),
	Schema.Struct({ op: Schema.Literal("drop_column"), table: Schema.String, name: Schema.String }),
	Schema.Struct({ op: Schema.Literal("rename_column"), table: Schema.String, from: Schema.String, to: Schema.String }),
	/** The table as it will be, and the columns whose rows carry over (by their name in both tables). */
	Schema.Struct({
		op: Schema.Literal("rebuild_table"),
		table: SqliteTableEntity,
		columns: Schema.Array(SqliteColumnEntity),
		uniques: Schema.Array(SqliteUniqueEntity),
		copy: Schema.Array(Schema.String),
	}),
	Schema.Struct({ op: Schema.Literal("create_index"), index: SqliteIndexEntity }),
	Schema.Struct({ op: Schema.Literal("drop_index"), name: Schema.String }),
])
export type SqliteMigrationOp = typeof SqliteMigrationOp.Type

/** Labels the plan prints. `rebuild`: the table is copied into a new one. */
export type SqliteOpLabel = "metadata" | "destructive" | "rebuild"

export const labelOfSqlite = (op: SqliteMigrationOp): SqliteOpLabel => {
	switch (op.op) {
		case "drop_table":
		case "drop_column":
			return "destructive"
		case "rebuild_table":
			return "rebuild"
		default:
			return "metadata"
	}
}

/** The temporary name a rebuilt table is created under, drizzle-kit's. */
export const rebuildName = (table: string): string => `__new_${table}`

const list = (names: ReadonlyArray<string>): string => names.map(sqliteIdent).join(", ")

/**
 * What a rebuild copies into a column. A column that gains NOT NULL keeps its
 * default for existing NULLs: an explicit NULL in `INSERT ... SELECT` does not
 * take the column's default, so the copy would fail on the old NULLs.
 */
const copied = (column: SqliteColumnEntity | undefined, name: string): string =>
	column?.notNull === true && column.default !== null && column.default.toUpperCase() !== "NULL"
		? `COALESCE(${sqliteIdent(name)}, ${column.default})`
		: sqliteIdent(name)

/** The statements one op runs, in order. */
export const renderSqliteOp = (op: SqliteMigrationOp): ReadonlyArray<string> => {
	switch (op.op) {
		case "create_table":
			return [renderSqliteCreateTable(op.table, op.columns, op.uniques)]
		case "drop_table":
			return [`DROP TABLE IF EXISTS ${sqliteIdent(op.name)}`]
		case "rename_table":
			// SQLite refuses a rename to the same name in another case ("already another table"): go through a temporary one.
			return op.from.toLowerCase() === op.to.toLowerCase()
				? [`ALTER TABLE ${sqliteIdent(op.from)} RENAME TO ${sqliteIdent(`__rename_${op.to}`)}`, `ALTER TABLE ${sqliteIdent(`__rename_${op.to}`)} RENAME TO ${sqliteIdent(op.to)}`]
				: [`ALTER TABLE ${sqliteIdent(op.from)} RENAME TO ${sqliteIdent(op.to)}`]
		case "add_column":
			return [`ALTER TABLE ${sqliteIdent(op.column.table)} ADD COLUMN ${renderSqliteColumnDefinition(op.column)}`]
		case "drop_column":
			return [`ALTER TABLE ${sqliteIdent(op.table)} DROP COLUMN ${sqliteIdent(op.name)}`]
		case "rename_column":
			return [`ALTER TABLE ${sqliteIdent(op.table)} RENAME COLUMN ${sqliteIdent(op.from)} TO ${sqliteIdent(op.to)}`]
		case "rebuild_table": {
			const temporary = rebuildName(op.table.name)
			const created = renderSqliteCreateTable({ ...op.table, name: temporary }, op.columns.map((c) => ({ ...c, table: temporary })), op.uniques, { ifNotExists: false })
			return [
				"PRAGMA foreign_keys=OFF",
				created,
				// With no column in common the rows still carry over, every column taking its default:
				// only the dropped columns' data was confirmed lost, not the table's rows.
				op.copy.length === 0
					? `INSERT INTO ${sqliteIdent(temporary)}(rowid) SELECT rowid FROM ${sqliteIdent(op.table.name)}`
					: `INSERT INTO ${sqliteIdent(temporary)}(${list(op.copy)}) SELECT ${op.copy.map((name) => copied(op.columns.find((c) => c.name === name), name)).join(", ")} FROM ${sqliteIdent(op.table.name)}`,
				`DROP TABLE ${sqliteIdent(op.table.name)}`,
				`ALTER TABLE ${sqliteIdent(temporary)} RENAME TO ${sqliteIdent(op.table.name)}`,
				"PRAGMA foreign_keys=ON",
			]
		}
		case "create_index":
			return [renderSqliteCreateIndex(op.index)]
		case "drop_index":
			return [`DROP INDEX IF EXISTS ${sqliteIdent(op.name)}`]
	}
}

/** A migration.sql: each op's statements under a comment naming its label, one statement per breakpoint. */
export const renderSqliteMigrationSql = (ops: ReadonlyArray<SqliteMigrationOp>, breakpoint: string): string =>
	`${ops.flatMap((op) => renderSqliteOp(op).map((statement) => `-- ${labelOfSqlite(op)}\n${statement};`)).join(`\n${breakpoint}\n`)}\n`
