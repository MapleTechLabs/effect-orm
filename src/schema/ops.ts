// Migration operations: what a generated migration stores.
//
// Generated migrations are ops, not SQL text, so the cluster name and
// replicated engines are applied when the migration runs rather than frozen
// into the committed file. `renderOp` is the only place an op becomes SQL.

import { Schema } from "effect"
import { ColumnEntity, IndexEntity, MaterializedViewEntity, TableEntity } from "./entities"
import { PgMigrationFile } from "./pg-ops"
import {
	ident,
	renderAlter,
	renderColumnDefinition,
	renderCreateMaterializedView,
	renderCreateTable,
	renderDropTable,
	renderDropView,
	renderIndexDefinition,
	renderSettings,
	type RenderOptions,
} from "./render"

export const MigrationOp = Schema.Union([
	Schema.Struct({
		op: Schema.Literal("create_table"),
		table: TableEntity,
		columns: Schema.Array(ColumnEntity),
		indexes: Schema.Array(IndexEntity),
	}),
	Schema.Struct({ op: Schema.Literal("drop_table"), name: Schema.String }),
	Schema.Struct({ op: Schema.Literal("create_view"), view: MaterializedViewEntity }),
	Schema.Struct({ op: Schema.Literal("drop_view"), name: Schema.String }),
	Schema.Struct({ op: Schema.Literal("add_column"), column: ColumnEntity, after: Schema.NullOr(Schema.String) }),
	Schema.Struct({ op: Schema.Literal("drop_column"), table: Schema.String, name: Schema.String }),
	/** Default, codec, or comment changed; the type is unchanged, so no data is rewritten. */
	Schema.Struct({ op: Schema.Literal("modify_column"), from: ColumnEntity, to: ColumnEntity }),
	Schema.Struct({ op: Schema.Literal("add_index"), index: IndexEntity }),
	Schema.Struct({ op: Schema.Literal("drop_index"), table: Schema.String, name: Schema.String }),
	Schema.Struct({ op: Schema.Literal("modify_ttl"), table: Schema.String, ttl: Schema.NullOr(Schema.String) }),
	Schema.Struct({
		op: Schema.Literal("modify_settings"),
		table: Schema.String,
		set: Schema.Record(Schema.String, Schema.String),
		reset: Schema.Array(Schema.String),
	}),
	Schema.Struct({ op: Schema.Literal("modify_comment"), table: Schema.String, comment: Schema.NullOr(Schema.String) }),
])
export type MigrationOp = typeof MigrationOp.Type

/** The file a generated ClickHouse migration is written to. */
export const ClickHouseMigrationFile = Schema.Struct({
	version: Schema.Literal("1"),
	ops: Schema.Array(MigrationOp),
})
export type ClickHouseMigrationFile = typeof ClickHouseMigrationFile.Type

/**
 * A generated `migration.json`, of either dialect. A Postgres file says
 * `"dialect": "postgres"`; a ClickHouse one predates the field and has none.
 */
export const MigrationFile = Schema.Union([PgMigrationFile, ClickHouseMigrationFile])
export type MigrationFile = typeof MigrationFile.Type

/** Labels the plan prints, so the expensive lines stand out. */
export type OpLabel = "metadata" | "destructive" | "ingest gap"

export const labelOf = (op: MigrationOp): OpLabel => {
	switch (op.op) {
		case "drop_table":
		case "drop_column":
			return "destructive"
		case "drop_view":
			return "ingest gap"
		default:
			return "metadata"
	}
}

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

/** The statements one op runs, in order. Every statement is safe to repeat. */
export const renderOp = (op: MigrationOp, options: RenderOptions = {}): ReadonlyArray<string> => {
	switch (op.op) {
		case "create_table":
			return [renderCreateTable(op.table, op.columns, op.indexes, options)]
		case "drop_table":
			return [renderDropTable(op.name, options)]
		case "create_view":
			return [renderCreateMaterializedView(op.view, options)]
		case "drop_view":
			return [renderDropView(op.name, options)]
		case "add_column":
			return [
				renderAlter(
					op.column.table,
					`ADD COLUMN IF NOT EXISTS ${renderColumnDefinition(op.column)}${op.after === null ? " FIRST" : ` AFTER ${ident(op.after)}`}`,
					options,
				),
			]
		case "drop_column":
			// A mutation: wait for it, so the step is journaled only once the parts are rewritten.
			return [`${renderAlter(op.table, `DROP COLUMN IF EXISTS ${ident(op.name)}`, options)} SETTINGS mutations_sync = 2`]
		case "modify_column": {
			const { from, to } = op
			const name = ident(to.name)
			const out: Array<string> = []
			if (from.default !== null && to.default === null) {
				out.push(renderAlter(to.table, `MODIFY COLUMN ${name} REMOVE DEFAULT`, options))
			}
			if (from.codec !== null && to.codec === null) {
				out.push(renderAlter(to.table, `MODIFY COLUMN ${name} REMOVE CODEC`, options))
			}
			if ((to.default !== null && JSON.stringify(from.default) !== JSON.stringify(to.default)) || (to.codec !== null && from.codec !== to.codec)) {
				const parts = [name, to.type]
				if (to.default !== null) parts.push(`${to.default.kind} ${to.default.expr}`)
				if (to.codec !== null) parts.push(`CODEC(${to.codec})`)
				out.push(renderAlter(to.table, `MODIFY COLUMN ${parts.join(" ")}`, options))
			}
			if (from.comment !== to.comment) {
				out.push(renderAlter(to.table, `COMMENT COLUMN ${name} ${quote(to.comment ?? "")}`, options))
			}
			return out
		}
		case "add_index":
			return [renderAlter(op.index.table, `ADD INDEX IF NOT EXISTS ${renderIndexDefinition(op.index).slice("INDEX ".length)}`, options)]
		case "drop_index":
			return [renderAlter(op.table, `DROP INDEX IF EXISTS ${ident(op.name)}`, options)]
		case "modify_ttl":
			// A TTL edit must not rewrite every part of a large table as a side effect.
			return [
				op.ttl === null
					? renderAlter(op.table, "REMOVE TTL", options)
					: `${renderAlter(op.table, `MODIFY TTL ${op.ttl}`, options)} SETTINGS materialize_ttl_after_modify = 0`,
			]
		case "modify_settings":
			return [
				...(Object.keys(op.set).length > 0 ? [renderAlter(op.table, `MODIFY SETTING ${renderSettings(op.set)}`, options)] : []),
				...op.reset.map((key) => renderAlter(op.table, `RESET SETTING ${key}`, options)),
			]
		case "modify_comment":
			return [renderAlter(op.table, `MODIFY COMMENT ${quote(op.comment ?? "")}`, options)]
	}
}
