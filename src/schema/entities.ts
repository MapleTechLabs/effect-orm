// Schema entities: the normalized, serializable form of a ClickHouse schema,
// and the snapshot envelope both dialects share (Postgres entities live in
// `pg-entities.ts`).
//
// A `defineTable` value is code; a snapshot is data. Everything downstream of
// the definitions (DDL rendering, diffing, the migrator's drift check) reads
// these entities, never the definitions, so a snapshot taken months ago renders
// and diffs exactly as it did when it was written.

import { Schema } from "effect"
import { PgSchemaEntity } from "./pg-entities"

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

const snapshotFields = {
	version: Schema.Literal(SNAPSHOT_VERSION),
	/** sha256 of the canonical entity list; two branches reaching one schema agree. */
	id: Schema.String,
	prevIds: Schema.Array(Schema.String),
}

export const ClickHouseSnapshot = Schema.Struct({
	...snapshotFields,
	dialect: Schema.Literal("clickhouse"),
	entities: Schema.Array(SchemaEntity),
})
export type ClickHouseSnapshot = typeof ClickHouseSnapshot.Type

export const PgSnapshot = Schema.Struct({
	...snapshotFields,
	dialect: Schema.Literal("postgres"),
	entities: Schema.Array(PgSchemaEntity),
})
export type PgSnapshot = typeof PgSnapshot.Type

/** The schema at one point in history. `dialect` says which entity set it holds. */
export const Snapshot = Schema.Union([ClickHouseSnapshot, PgSnapshot])
export type Snapshot = typeof Snapshot.Type

/** The dialects a schema can be written for. */
export type SchemaDialect = Snapshot["dialect"]

/** An entity of either dialect. Everything dialect-neutral (keys, ordering, hashing, the branch graph) takes this. */
export type AnySchemaEntity = SchemaEntity | PgSchemaEntity

/** A stable key per entity, unique within a snapshot: `<kind>:<name>`, or `<kind>:<table>.<name>` for a table's parts. */
export const entityKey = (entity: AnySchemaEntity): string =>
	"table" in entity ? `${entity.kind}:${entity.table}.${entity.name}` : `${entity.kind}:${entity.name}`

const kindOrder: Record<AnySchemaEntity["kind"], number> = {
	table: 0,
	column: 1,
	index: 2,
	foreign_key: 3,
	materialized_view: 4,
}

/** Tables, then columns in declaration order, then indexes, foreign keys, views. Deterministic. */
export const sortEntities = <E extends AnySchemaEntity>(entities: ReadonlyArray<E>): ReadonlyArray<E> =>
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
