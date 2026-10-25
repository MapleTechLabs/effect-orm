// SQLite schema entities: the normalized, serializable form of a SQLite
// schema, as `entities.ts` is for ClickHouse and `pg-entities.ts` for Postgres.
//
// Types are stored as the declared type, lowercase (`text`, `integer`), which
// is what `PRAGMA table_info` reports back and what drizzle-kit writes.
// Expressions (defaults, index key parts) are SQL as written.

import { Schema } from "effect"

export const SqliteTableEntity = Schema.Struct({
	kind: Schema.Literal("table"),
	name: Schema.String,
	/**
	 * The primary key columns, or `null` for a table without one. SQLite keeps
	 * no name for the constraint, so none is stored.
	 */
	primaryKey: Schema.NullOr(Schema.Struct({ columns: Schema.Array(Schema.String) })),
})
export type SqliteTableEntity = typeof SqliteTableEntity.Type

export const SqliteColumnEntity = Schema.Struct({
	kind: Schema.Literal("column"),
	table: Schema.String,
	name: Schema.String,
	/** Declaration order, the order `CREATE TABLE` writes the columns in. */
	position: Schema.Number,
	/** The declared type, lowercase: `text`, `integer`, `real`, `blob`, `numeric`. */
	type: Schema.String,
	notNull: Schema.Boolean,
	/** The `DEFAULT` value as SQL: a literal, or an expression in parentheses. `null` for none. */
	default: Schema.NullOr(Schema.String),
})
export type SqliteColumnEntity = typeof SqliteColumnEntity.Type

/** An index, `CREATE [UNIQUE] INDEX`. A column's `unique` option is a unique index too, as drizzle-kit writes it. */
export const SqliteIndexEntity = Schema.Struct({
	kind: Schema.Literal("index"),
	table: Schema.String,
	name: Schema.String,
	unique: Schema.Boolean,
	/** Key parts as SQL: a quoted column (`"org_id"`) or an expression. */
	columns: Schema.Array(Schema.String),
})
export type SqliteIndexEntity = typeof SqliteIndexEntity.Type

export const SqliteSchemaEntity = Schema.Union([SqliteTableEntity, SqliteColumnEntity, SqliteIndexEntity])
export type SqliteSchemaEntity = typeof SqliteSchemaEntity.Type

/** The declared type of a column, as `PRAGMA table_info` reports it back. */
export const canonicalSqliteType = (type: string): string => type.trim().replace(/\s+/g, " ").toLowerCase()
