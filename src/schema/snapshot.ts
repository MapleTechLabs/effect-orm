// Snapshots: the schema at one point in history, as data.

import { Effect } from "effect"
import type { MaterializedView, SchemaTable } from "./define"
import { SchemaDefinitionDefect } from "./define"
import {
	canonicalJson,
	entityKey,
	sha256Hex,
	sortEntities,
	SNAPSHOT_VERSION,
	type SchemaEntity,
	type Snapshot,
} from "./entities"

/** Anything a schema module may export that `generate` collects. */
export type SchemaObject = SchemaTable<string, any> | MaterializedView<string>

export const isSchemaObject = (value: unknown): value is SchemaObject =>
	typeof value === "object" &&
	value !== null &&
	"ddl" in value &&
	"_tag" in value &&
	(value._tag === "Table" || value._tag === "MaterializedView")

/** The entities of a set of definitions, validated as one schema. */
export const entitiesOf = (objects: ReadonlyArray<SchemaObject>): ReadonlyArray<SchemaEntity> => {
	const entities: Array<SchemaEntity> = []
	for (const object of objects) {
		if (object._tag === "Table") entities.push(object.ddl.table, ...object.ddl.columns, ...object.ddl.indexes)
		else entities.push(object.ddl)
	}
	const seen = new Set<string>()
	const names = new Map<string, string>()
	for (const entity of entities) {
		const key = entityKey(entity)
		if (seen.has(key)) {
			throw new SchemaDefinitionDefect({ object: key, message: "defined twice" })
		}
		seen.add(key)
		if (entity.kind === "table" || entity.kind === "materialized_view") {
			const other = names.get(entity.name)
			if (other !== undefined) {
				throw new SchemaDefinitionDefect({
					object: entity.name,
					message: `a ${entity.kind} and a ${other} share one name`,
				})
			}
			names.set(entity.name, entity.kind)
		}
	}
	// A view whose target does not exist is accepted by ClickHouse at CREATE
	// time, and then every insert into its source fails with UNKNOWN_TABLE.
	for (const entity of entities) {
		if (entity.kind === "materialized_view" && names.get(entity.to) !== "table") {
			throw new SchemaDefinitionDefect({
				object: entity.name,
				message: `writes to ${entity.to}, which is not a table in this schema`,
			})
		}
	}
	return sortEntities(entities)
}

/** A snapshot of `entities` with the given parents. Its id is the hash of the entities alone. */
export const makeSnapshot = (
	entities: ReadonlyArray<SchemaEntity>,
	prevIds: ReadonlyArray<string>,
): Effect.Effect<Snapshot> =>
	Effect.promise(() => sha256Hex(canonicalJson(sortEntities(entities)))).pipe(
		Effect.map(
			(id): Snapshot => ({
				version: SNAPSHOT_VERSION,
				dialect: "clickhouse",
				id,
				prevIds: [...prevIds],
				entities: sortEntities(entities),
			}),
		),
	)

/** Pretty, stable snapshot JSON for committing. */
export const serializeSnapshot = (snapshot: Snapshot): string => `${JSON.stringify(snapshot, null, "\t")}\n`
