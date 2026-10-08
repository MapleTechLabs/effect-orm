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

/**
 * `INSERT INTO target (columns) SELECT select FROM from [WHERE] [GROUP BY]`, run in
 * windows of `windowDays` (default 1) on `timeColumn`, aligned to the epoch.
 * A window aligned at or coarser than a `groupBy` grain never splits a group.
 */
export const BackfillSpec = Schema.Struct({
	target: Schema.String,
	columns: Schema.Array(Schema.String),
	from: Schema.String,
	timeColumn: Schema.String,
	select: Schema.String,
	where: Schema.optionalKey(Schema.String),
	groupBy: Schema.optionalKey(Schema.String),
	windowDays: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})
export type BackfillSpec = typeof BackfillSpec.Type

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
	/** Written by hand into a generated file; `generate` never emits it. */
	Schema.Struct({ op: Schema.Literal("backfill"), backfill: BackfillSpec }),
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
export type OpLabel = "metadata" | "destructive" | "ingest gap" | "backfill"

export const labelOf = (op: MigrationOp): OpLabel => {
	switch (op.op) {
		case "drop_table":
		case "drop_column":
			return "destructive"
		case "drop_view":
			return "ingest gap"
		case "backfill":
			return "backfill"
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
		case "backfill":
			return [renderBackfill(op.backfill)]
	}
}

const DAY_SECONDS = 86_400

/**
 * One backfill statement: the whole source, or the half-open window `[from, to)` in
 * unix seconds. A window compares the raw column, not an alias of the same name.
 */
export const renderBackfill = (spec: BackfillSpec, window?: { readonly from: number; readonly to: number }): string => {
	const where = [
		...(spec.where !== undefined && spec.where.trim().length > 0 ? [`(${spec.where})`] : []),
		...(window === undefined
			? []
			: [`${ident(spec.timeColumn)} >= toDateTime(${window.from}) AND ${ident(spec.timeColumn)} < toDateTime(${window.to})`]),
	]
	return [
		`INSERT INTO ${ident(spec.target)} (${spec.columns.map(ident).join(", ")})`,
		`SELECT ${spec.select}`,
		`FROM ${ident(spec.from)}`,
		...(where.length > 0 ? [`WHERE ${where.join(" AND ")}`] : []),
		...(spec.groupBy !== undefined && spec.groupBy.trim().length > 0 ? [`GROUP BY ${spec.groupBy}`] : []),
		...(window === undefined ? [] : ["SETTINGS prefer_column_name_to_alias = 1"]),
	].join("\n")
}

/** The query reading a backfill source's time range as unix seconds `lo` and `hi`. */
export const renderBackfillBounds = (spec: BackfillSpec): string =>
	`SELECT toUnixTimestamp(min(${ident(spec.timeColumn)})) AS lo, toUnixTimestamp(max(${ident(spec.timeColumn)})) AS hi FROM ${ident(spec.from)}`

/** Epoch-aligned windows covering `[lo, hi]`, so the same data range always yields the same windows. */
export const backfillWindows = (spec: BackfillSpec, lo: number, hi: number): ReadonlyArray<{ readonly from: number; readonly to: number }> => {
	if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= 0) return []
	const size = (spec.windowDays ?? 1) * DAY_SECONDS
	const windows: Array<{ from: number; to: number }> = []
	for (let from = Math.floor(lo / size) * size; from <= hi; from += size) windows.push({ from, to: from + size })
	return windows
}
