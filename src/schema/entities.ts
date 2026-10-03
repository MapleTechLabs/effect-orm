// Schema entities: the normalized, serializable form of a ClickHouse schema.
//
// A `defineTable` value is code; a snapshot is data. Everything downstream of
// the definitions (DDL rendering, diffing, the migrator's drift check) reads
// these entities, never the definitions, so a snapshot taken months ago renders
// and diffs exactly as it did when it was written.

import { Schema } from "effect"

/** `DEFAULT`, `MATERIALIZED`, or `ALIAS`, with its SQL expression. */
export const ColumnDefault = Schema.Struct({
	kind: Schema.Literals(["DEFAULT", "MATERIALIZED", "ALIAS"]),
	expr: Schema.String,
})
export type ColumnDefault = typeof ColumnDefault.Type

export const ColumnEntity = Schema.Struct({
	kind: Schema.Literal("column"),
	table: Schema.String,
	name: Schema.String,
	/** Declaration order, which `ADD COLUMN ... AFTER` preserves. */
	position: Schema.Number,
	type: Schema.String,
	default: Schema.NullOr(ColumnDefault),
	codec: Schema.NullOr(Schema.String),
	comment: Schema.NullOr(Schema.String),
})
export type ColumnEntity = typeof ColumnEntity.Type

export const EngineSpec = Schema.Struct({
	/** The MergeTree family member without a `Replicated` prefix, or `Null` / `Memory`. */
	family: Schema.String,
	/** Engine arguments as SQL, e.g. `["Version"]` for `ReplacingMergeTree(Version)`. */
	params: Schema.Array(Schema.String),
})
export type EngineSpec = typeof EngineSpec.Type

export const TableEntity = Schema.Struct({
	kind: Schema.Literal("table"),
	name: Schema.String,
	engine: EngineSpec,
	orderBy: Schema.NullOr(Schema.String),
	partitionBy: Schema.NullOr(Schema.String),
	primaryKey: Schema.NullOr(Schema.String),
	ttl: Schema.NullOr(Schema.String),
	settings: Schema.Record(Schema.String, Schema.String),
	comment: Schema.NullOr(Schema.String),
})
export type TableEntity = typeof TableEntity.Type

export const IndexEntity = Schema.Struct({
	kind: Schema.Literal("index"),
	table: Schema.String,
	name: Schema.String,
	expr: Schema.String,
	type: Schema.String,
	granularity: Schema.Number,
})
export type IndexEntity = typeof IndexEntity.Type

export const MaterializedViewEntity = Schema.Struct({
	kind: Schema.Literal("materialized_view"),
	name: Schema.String,
	/** Target table the view writes to (`TO <to>`). */
	to: Schema.String,
	/** Tables the body reads; a write to any of them runs the view. */
	sources: Schema.Array(Schema.String),
	select: Schema.String,
})
export type MaterializedViewEntity = typeof MaterializedViewEntity.Type

export const SchemaEntity = Schema.Union([TableEntity, ColumnEntity, IndexEntity, MaterializedViewEntity])
export type SchemaEntity = typeof SchemaEntity.Type

/** The snapshot format version this build writes and reads. */
export const SNAPSHOT_VERSION = "1"

/** The parent id of a first migration. */
export const ORIGIN_ID = "0000000000000000000000000000000000000000000000000000000000000000"

export const Snapshot = Schema.Struct({
	version: Schema.Literal(SNAPSHOT_VERSION),
	dialect: Schema.Literal("clickhouse"),
	/** sha256 of the canonical entity list; two branches reaching one schema agree. */
	id: Schema.String,
	prevIds: Schema.Array(Schema.String),
	entities: Schema.Array(SchemaEntity),
})
export type Snapshot = typeof Snapshot.Type

/** A stable key per entity, unique within a snapshot. */
export const entityKey = (entity: SchemaEntity): string => {
	switch (entity.kind) {
		case "table":
			return `table:${entity.name}`
		case "materialized_view":
			return `materialized_view:${entity.name}`
		case "column":
			return `column:${entity.table}.${entity.name}`
		case "index":
			return `index:${entity.table}.${entity.name}`
	}
}

const kindOrder: Record<SchemaEntity["kind"], number> = { table: 0, column: 1, index: 2, materialized_view: 3 }

/** Tables, then columns in declaration order, then indexes, then views. Deterministic. */
export const sortEntities = (entities: ReadonlyArray<SchemaEntity>): ReadonlyArray<SchemaEntity> =>
	[...entities].sort((a, b) => {
		const byKind = kindOrder[a.kind] - kindOrder[b.kind]
		if (byKind !== 0) return byKind
		if (a.kind === "column" && b.kind === "column") {
			return a.table === b.table ? a.position - b.position : a.table < b.table ? -1 : 1
		}
		const ka = entityKey(a)
		const kb = entityKey(b)
		return ka < kb ? -1 : ka > kb ? 1 : 0
	})

/** JSON with object keys sorted, so equal values serialize to equal bytes. */
export const canonicalJson = (value: unknown): string =>
	JSON.stringify(value, (_key, v: unknown) =>
		v !== null && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: v,
	)

/** Hex sha256 through Web Crypto, available on Node, Bun, Deno, and Workers. */
export const sha256Hex = async (text: string): Promise<string> => {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
