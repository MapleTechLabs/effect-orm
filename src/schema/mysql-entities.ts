// MySQL / MariaDB schema entities: the normalized, serializable form of a
// MySQL schema, as `sqlite-entities.ts` is for SQLite.
//
// Types are stored as the declared type, lowercase (`varchar(36)`,
// `datetime(3)`). Expressions (defaults, index key parts) are SQL as written.

import { Schema } from "effect"

export const MysqlTableEntity = Schema.Struct({
	kind: Schema.Literal("table"),
	name: Schema.String,
	/** The primary key columns, or `null` for a table without one. MySQL names every primary key `PRIMARY`. */
	primaryKey: Schema.NullOr(Schema.Struct({ columns: Schema.Array(Schema.String) })),
})
export type MysqlTableEntity = typeof MysqlTableEntity.Type

export const MysqlColumnEntity = Schema.Struct({
	kind: Schema.Literal("column"),
	table: Schema.String,
	name: Schema.String,
	/** Declaration order, the order `CREATE TABLE` writes the columns in. */
	position: Schema.Number,
	/** The declared type, lowercase: `text`, `varchar(36)`, `bigint`, `datetime(3)`. */
	type: Schema.String,
	notNull: Schema.Boolean,
	/** The `DEFAULT` value as SQL: a literal, or an expression in parentheses. `null` for none. */
	default: Schema.NullOr(Schema.String),
})
export type MysqlColumnEntity = typeof MysqlColumnEntity.Type

/** An index, `CREATE [UNIQUE] INDEX`. Its name is unique within its table. */
export const MysqlIndexEntity = Schema.Struct({
	kind: Schema.Literal("index"),
	table: Schema.String,
	name: Schema.String,
	unique: Schema.Boolean,
	/** Key parts as SQL: quoted columns (`` `org_id` ``). */
	columns: Schema.Array(Schema.String),
})
export type MysqlIndexEntity = typeof MysqlIndexEntity.Type

/**
 * A `UNIQUE` constraint, `CONSTRAINT <name> UNIQUE (...)` in `CREATE TABLE`.
 * MySQL backs it with an index of the same name, in the table's index namespace.
 */
export const MysqlUniqueEntity = Schema.Struct({
	kind: Schema.Literal("unique"),
	table: Schema.String,
	name: Schema.String,
	columns: Schema.Array(Schema.String),
})
export type MysqlUniqueEntity = typeof MysqlUniqueEntity.Type

export const MysqlSchemaEntity = Schema.Union([MysqlTableEntity, MysqlColumnEntity, MysqlIndexEntity, MysqlUniqueEntity])
export type MysqlSchemaEntity = typeof MysqlSchemaEntity.Type

/** A declared type, normalized: lowercase, single spaces, no space after a comma (`decimal(10,2)`). */
export const canonicalMysqlType = (type: string): string =>
	type.trim().replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").replace(/\)(?=\w)/g, ") ").toLowerCase()

/** TEXT, BLOB and JSON: no index or key without a prefix length, and no literal DEFAULT on MySQL. */
export const isMysqlLobType = (type: string): boolean => /^(tiny|medium|long)?(text|blob)$|^json$/.test(canonicalMysqlType(type))
