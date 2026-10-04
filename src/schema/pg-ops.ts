// Postgres migration operations and the DDL they render to.
//
// The Postgres counterpart of `ops.ts`. A Postgres migration runs inside one
// transaction, so its statements do not have to be safe to repeat; they still
// use `IF EXISTS` / `IF NOT EXISTS` where Postgres has it, so a migration
// replayed against a hand-fixed database does not trip over its own objects.

import { Schema } from "effect"
import { PgColumnEntity, PgForeignKeyEntity, PgIndexEntity, PgTableEntity, type PgSchemaEntity } from "./pg-entities"

const PrimaryKey = Schema.NullOr(Schema.Struct({ name: Schema.String, columns: Schema.Array(Schema.String) }))

export const PgMigrationOp = Schema.Union([
	Schema.Struct({ op: Schema.Literal("create_table"), table: PgTableEntity, columns: Schema.Array(PgColumnEntity) }),
	Schema.Struct({ op: Schema.Literal("drop_table"), name: Schema.String }),
	Schema.Struct({ op: Schema.Literal("add_column"), column: PgColumnEntity }),
	Schema.Struct({ op: Schema.Literal("drop_column"), table: Schema.String, name: Schema.String }),
	/** Type, nullability, or default changed. */
	Schema.Struct({ op: Schema.Literal("alter_column"), from: PgColumnEntity, to: PgColumnEntity }),
	Schema.Struct({ op: Schema.Literal("set_primary_key"), table: Schema.String, from: PrimaryKey, to: PrimaryKey }),
	Schema.Struct({ op: Schema.Literal("create_index"), index: PgIndexEntity }),
	Schema.Struct({ op: Schema.Literal("drop_index"), table: Schema.String, name: Schema.String }),
	Schema.Struct({ op: Schema.Literal("add_foreign_key"), foreignKey: PgForeignKeyEntity }),
	Schema.Struct({ op: Schema.Literal("drop_foreign_key"), table: Schema.String, name: Schema.String }),
])
export type PgMigrationOp = typeof PgMigrationOp.Type

/** A generated Postgres migration. `dialect` tells it apart from a ClickHouse `migration.json`. */
export const PgMigrationFile = Schema.Struct({
	version: Schema.Literal("1"),
	dialect: Schema.Literal("postgres"),
	ops: Schema.Array(PgMigrationOp),
})
export type PgMigrationFile = typeof PgMigrationFile.Type

/** An identifier, always double-quoted, so mixed case and keywords survive. */
export const pgIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`

const list = (names: ReadonlyArray<string>): string => names.map(pgIdent).join(", ")

export const renderPgColumnDefinition = (column: PgColumnEntity): string => {
	const parts = [pgIdent(column.name), column.type]
	if (column.notNull) parts.push("NOT NULL")
	if (column.default !== null) parts.push(`DEFAULT ${column.default}`)
	if (column.identity !== null) parts.push(`GENERATED ${column.identity.toUpperCase()} AS IDENTITY`)
	return parts.join(" ")
}

export const renderPgCreateTable = (table: PgTableEntity, columns: ReadonlyArray<PgColumnEntity>): string => {
	const body = [...columns].sort((a, b) => a.position - b.position).map(renderPgColumnDefinition)
	if (table.primaryKey !== null) {
		body.push(`CONSTRAINT ${pgIdent(table.primaryKey.name)} PRIMARY KEY (${list(table.primaryKey.columns)})`)
	}
	return `CREATE TABLE IF NOT EXISTS ${pgIdent(table.name)} (\n\t${body.join(",\n\t")}\n)`
}

export const renderPgCreateIndex = (index: PgIndexEntity): string =>
	`CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${pgIdent(index.name)} ON ${pgIdent(index.table)} USING ${index.method} (${index.columns.join(", ")})${index.where === null ? "" : ` WHERE ${index.where}`}`

export const renderPgAddForeignKey = (fk: PgForeignKeyEntity): string => {
	const actions = [
		...(fk.onDelete === "NO ACTION" ? [] : [`ON DELETE ${fk.onDelete}`]),
		...(fk.onUpdate === "NO ACTION" ? [] : [`ON UPDATE ${fk.onUpdate}`]),
	]
	return `ALTER TABLE ${pgIdent(fk.table)} ADD CONSTRAINT ${pgIdent(fk.name)} FOREIGN KEY (${list(fk.columns)}) REFERENCES ${pgIdent(fk.foreignTable)} (${list(fk.foreignColumns)})${actions.map((a) => ` ${a}`).join("")}`
}

const alter = (table: string, action: string): string => `ALTER TABLE ${pgIdent(table)} ${action}`

/**
 * Every CREATE statement for a schema: tables, then indexes, then foreign
 * keys, so every table a key references exists before the key.
 */
export const renderPgSchema = (entities: ReadonlyArray<PgSchemaEntity>): ReadonlyArray<string> => {
	const pick = <K extends PgSchemaEntity["kind"]>(kind: K) =>
		entities.filter((e): e is Extract<PgSchemaEntity, { kind: K }> => e.kind === kind)
	const columns = pick("column")
	return [
		...pick("table").map((table) => renderPgCreateTable(table, columns.filter((c) => c.table === table.name))),
		...pick("index").map(renderPgCreateIndex),
		...pick("foreign_key").map(renderPgAddForeignKey),
	]
}

/** Labels the plan prints. `rewrite`: a column type change, which rewrites the table under a lock. */
export type PgOpLabel = "metadata" | "destructive" | "rewrite"

export const labelOfPg = (op: PgMigrationOp): PgOpLabel => {
	switch (op.op) {
		case "drop_table":
		case "drop_column":
			return "destructive"
		case "alter_column":
			return op.from.type === op.to.type ? "metadata" : "rewrite"
		default:
			return "metadata"
	}
}

/** The statements one op runs, in order. */
export const renderPgOp = (op: PgMigrationOp): ReadonlyArray<string> => {
	switch (op.op) {
		case "create_table":
			return [renderPgCreateTable(op.table, op.columns)]
		case "drop_table":
			return [`DROP TABLE IF EXISTS ${pgIdent(op.name)}`]
		case "add_column":
			return [alter(op.column.table, `ADD COLUMN IF NOT EXISTS ${renderPgColumnDefinition(op.column)}`)]
		case "drop_column":
			return [alter(op.table, `DROP COLUMN IF EXISTS ${pgIdent(op.name)}`)]
		case "alter_column": {
			const { from, to } = op
			const name = pgIdent(to.name)
			const out: Array<string> = []
			const typeChanged = from.type !== to.type
			// The old default may not cast to the new type, so it goes before the type changes.
			if (from.default !== null && (to.default === null || (typeChanged && from.default !== to.default))) {
				out.push(alter(to.table, `ALTER COLUMN ${name} DROP DEFAULT`))
			}
			if (typeChanged) out.push(alter(to.table, `ALTER COLUMN ${name} SET DATA TYPE ${to.type} USING ${name}::${to.type}`))
			if (to.default !== null && (from.default !== to.default || typeChanged)) {
				out.push(alter(to.table, `ALTER COLUMN ${name} SET DEFAULT ${to.default}`))
			}
			if (from.notNull !== to.notNull) out.push(alter(to.table, `ALTER COLUMN ${name} ${to.notNull ? "SET" : "DROP"} NOT NULL`))
			if (from.identity !== to.identity) {
				out.push(
					from.identity === null
						? alter(to.table, `ALTER COLUMN ${name} ADD GENERATED ${to.identity!.toUpperCase()} AS IDENTITY`)
						: to.identity === null
							? alter(to.table, `ALTER COLUMN ${name} DROP IDENTITY IF EXISTS`)
							: alter(to.table, `ALTER COLUMN ${name} SET GENERATED ${to.identity.toUpperCase()}`),
				)
			}
			return out
		}
		case "set_primary_key":
			return [
				...(op.from === null ? [] : [alter(op.table, `DROP CONSTRAINT IF EXISTS ${pgIdent(op.from.name)}`)]),
				...(op.to === null ? [] : [alter(op.table, `ADD CONSTRAINT ${pgIdent(op.to.name)} PRIMARY KEY (${list(op.to.columns)})`)]),
			]
		case "create_index":
			return [renderPgCreateIndex(op.index)]
		case "drop_index":
			return [`DROP INDEX IF EXISTS ${pgIdent(op.name)}`]
		case "add_foreign_key":
			return [renderPgAddForeignKey(op.foreignKey)]
		case "drop_foreign_key":
			return [alter(op.table, `DROP CONSTRAINT IF EXISTS ${pgIdent(op.name)}`)]
	}
}
