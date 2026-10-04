// Postgres schema entities: the normalized, serializable form of a Postgres
// schema, as `entities.ts` is for ClickHouse.
//
// Types are stored in the spelling `format_type` reports (`integer`,
// `timestamp with time zone`, `real[]`), so a snapshot, a drizzle-kit snapshot
// and the live catalog all compare as text. Expressions (defaults, index keys,
// partial-index predicates) are SQL as written; `verify` normalizes both sides
// before comparing them.

import { Schema } from "effect"

export const PgTableEntity = Schema.Struct({
	kind: Schema.Literal("table"),
	name: Schema.String,
	/** The primary key constraint, or `null` for a table without one. */
	primaryKey: Schema.NullOr(Schema.Struct({ name: Schema.String, columns: Schema.Array(Schema.String) })),
})
export type PgTableEntity = typeof PgTableEntity.Type

/** An identity column's kind. */
export const PgIdentity = Schema.Literals(["always", "by default"])
export type PgIdentity = typeof PgIdentity.Type

export const PgColumnEntity = Schema.Struct({
	kind: Schema.Literal("column"),
	table: Schema.String,
	name: Schema.String,
	/** Declaration order, the order `CREATE TABLE` writes the columns in. */
	position: Schema.Number,
	/** As `format_type` spells it: `integer`, `timestamp with time zone`, `text[]`. */
	type: Schema.String,
	notNull: Schema.Boolean,
	/** The `DEFAULT` expression as SQL, or `null`. */
	default: Schema.NullOr(Schema.String),
	/** `GENERATED ALWAYS | BY DEFAULT AS IDENTITY`, with the sequence's default options; `null` for none. */
	identity: Schema.NullOr(PgIdentity),
})
export type PgColumnEntity = typeof PgColumnEntity.Type

export const PgIndexEntity = Schema.Struct({
	kind: Schema.Literal("index"),
	table: Schema.String,
	name: Schema.String,
	unique: Schema.Boolean,
	/** `btree`, `gin`, `hash`, ... */
	method: Schema.String,
	/** Key parts as SQL: a quoted column (`"org_id"`) or an expression. */
	columns: Schema.Array(Schema.String),
	/** A partial index's predicate, or `null`. */
	where: Schema.NullOr(Schema.String),
})
export type PgIndexEntity = typeof PgIndexEntity.Type

/** `ON DELETE` / `ON UPDATE` actions, as the catalog names them. */
export const PgReferentialAction = Schema.Literals(["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"])
export type PgReferentialAction = typeof PgReferentialAction.Type

export const PgForeignKeyEntity = Schema.Struct({
	kind: Schema.Literal("foreign_key"),
	table: Schema.String,
	name: Schema.String,
	columns: Schema.Array(Schema.String),
	foreignTable: Schema.String,
	foreignColumns: Schema.Array(Schema.String),
	onDelete: PgReferentialAction,
	onUpdate: PgReferentialAction,
})
export type PgForeignKeyEntity = typeof PgForeignKeyEntity.Type

export const PgSchemaEntity = Schema.Union([PgTableEntity, PgColumnEntity, PgIndexEntity, PgForeignKeyEntity])
export type PgSchemaEntity = typeof PgSchemaEntity.Type

/** Postgres truncates longer identifiers silently, which would make every later comparison miss. */
export const PG_MAX_IDENTIFIER = 63

const TYPE_ALIASES: Readonly<Record<string, string>> = {
	int2: "smallint",
	smallint: "smallint",
	int: "integer",
	int4: "integer",
	integer: "integer",
	int8: "bigint",
	bigint: "bigint",
	float4: "real",
	real: "real",
	float8: "double precision",
	"double precision": "double precision",
	bool: "boolean",
	boolean: "boolean",
	timestamptz: "timestamp with time zone",
	"timestamp with time zone": "timestamp with time zone",
	timestamp: "timestamp without time zone",
	"timestamp without time zone": "timestamp without time zone",
	timetz: "time with time zone",
	"time with time zone": "time with time zone",
	time: "time without time zone",
	"time without time zone": "time without time zone",
	varchar: "character varying",
	"character varying": "character varying",
	char: "character",
	character: "character",
	decimal: "numeric",
	numeric: "numeric",
}

/**
 * A type name as `format_type` writes it: `int4` is `integer`, `timestamptz[]`
 * is `timestamp with time zone[]`, `varchar(20)` is `character varying(20)`.
 * Names it does not know (`text`, `jsonb`, `uuid`, a custom type) are kept.
 */
export const canonicalPgType = (type: string): string => {
	const trimmed = type.trim().replace(/\s+/g, " ")
	const array = /^(.*?)((?:\s*\[\s*\d*\s*\])+)$/.exec(trimmed)
	if (array !== null) {
		const dimensions = (array[2]!.match(/\[/g) ?? []).length
		return `${canonicalPgType(array[1]!)}${"[]".repeat(dimensions)}`
	}
	const match = /^([a-z0-9_ ]+?)\s*(\(.*\))?$/i.exec(trimmed)
	if (match === null) return trimmed
	const base = match[1]!.toLowerCase()
	const args = match[2]?.replace(/\s+/g, "") ?? ""
	const alias = TYPE_ALIASES[base]
	if (alias === undefined) return `${base}${args}`
	// `timestamp(3) with time zone`: format_type puts the precision after `timestamp`.
	if (args.length > 0 && alias.startsWith("timestamp ")) return alias.replace("timestamp", `timestamp${args}`)
	if (args.length > 0 && alias.startsWith("time ")) return alias.replace("time", `time${args}`)
	return `${alias}${args}`
}
