// Snapshots: the schema at one point in history, as data.

import { Effect } from "effect"
import type { MaterializedView, SchemaTable } from "./define"
import { definitionError, type ProblemSink, type SchemaDefinitionError } from "./problems"
import {
	canonicalJson,
	entityKey,
	sha256Hex,
	sortEntities,
	SNAPSHOT_VERSION,
	type AnySchemaEntity,
	type PgSnapshot,
	type ClickHouseSnapshot,
	type SchemaDialect,
	type SchemaEntity,
	type Snapshot,
} from "./entities"
import { enumProblems, type PgEnum, type PgSchemaTable } from "./pg-define"
import type { PgEnumEntity, PgSchemaEntity } from "./pg-entities"

/** Anything a schema module may export that `generate` collects. */
export type SchemaObject = SchemaTable<string, any> | MaterializedView<string> | PgSchemaTable<string, any> | PgEnum

export const isSchemaObject = (value: unknown): value is SchemaObject =>
	typeof value === "object" &&
	value !== null &&
	"ddl" in value &&
	"_tag" in value &&
	(value._tag === "Table" || value._tag === "MaterializedView" || value._tag === "PgEnum")

/** The dialect a definition was written for. */
export const dialectOfObject = (object: SchemaObject): SchemaDialect =>
	object._tag === "PgEnum" ? "postgres" : object._tag === "Table" && "dialect" in object.ddl ? object.ddl.dialect : "clickhouse"

/** Fail with every problem, or succeed with the sorted entities. */
const validated = <E extends AnySchemaEntity>(
	problems: ProblemSink,
	entities: ReadonlyArray<E>,
): Effect.Effect<ReadonlyArray<E>, SchemaDefinitionError> =>
	problems.length > 0 ? Effect.fail(definitionError(problems)) : Effect.succeed(sortEntities(entities))

/** The entities of a set of definitions, validated as one schema. Fails with every problem found. */
export const entitiesOf = (objects: ReadonlyArray<SchemaObject>): Effect.Effect<ReadonlyArray<SchemaEntity>, SchemaDefinitionError> => {
	const problems: ProblemSink = []
	const entities: Array<SchemaEntity> = []
	for (const object of objects) {
		problems.push(...object.problems)
		if (dialectOfObject(object) !== "clickhouse") {
			problems.push({ object: object.name, message: "is a Postgres table; use pgEntitiesOf" })
			continue
		}
		if (object._tag === "Table") {
			const ddl = object.ddl as SchemaTable<string, any>["ddl"]
			entities.push(ddl.table, ...ddl.columns, ...ddl.indexes)
		} else entities.push((object as MaterializedView<string>).ddl)
	}
	const seen = new Set<string>()
	const names = new Map<string, string>()
	for (const entity of entities) {
		const key = entityKey(entity)
		if (seen.has(key)) {
			problems.push({ object: key, message: "defined twice" })
		}
		seen.add(key)
		if (entity.kind === "table" || entity.kind === "materialized_view") {
			const other = names.get(entity.name)
			if (other !== undefined) {
				problems.push({
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
			problems.push({
				object: entity.name,
				message: `writes to ${entity.to}, which is not a table in this schema`,
			})
		}
	}
	return validated(problems, entities)
}

/**
 * The entities of a set of Postgres tables and enums, validated as one schema:
 * names are unique, index, unique-constraint and primary-key names do not
 * collide (Postgres keeps them in one namespace per schema), an enum is
 * declared one way, and every foreign key references a table and columns of
 * this schema. Enums a table's columns use come with it, exported or not.
 */
export const pgEntitiesOf = (objects: ReadonlyArray<SchemaObject>): Effect.Effect<ReadonlyArray<PgSchemaEntity>, SchemaDefinitionError> => {
	const problems: ProblemSink = []
	const tables: Array<PgSchemaTable<string, any>> = []
	const enumSources: Array<PgEnumEntity> = []
	for (const object of objects) {
		if (dialectOfObject(object) !== "postgres") {
			problems.push(...object.problems)
			problems.push({ object: object.name, message: "is a ClickHouse definition; use entitiesOf" })
			continue
		}
		if (object._tag === "PgEnum") {
			enumSources.push(object.ddl.enum)
			continue
		}
		problems.push(...object.problems)
		const table = object as PgSchemaTable<string, any>
		tables.push(table)
		enumSources.push(...table.ddl.enums)
	}
	const entities: Array<PgSchemaEntity> = []
	const enums = new Map<string, PgEnumEntity>()
	for (const entity of enumSources) {
		const key = entityKey(entity)
		const other = enums.get(key)
		if (other === undefined) {
			enums.set(key, entity)
			problems.push(...enumProblems(entity))
		} else if (other.values.join("\u0000") !== entity.values.join("\u0000")) {
			problems.push({
				object: entity.schema === null ? entity.name : `${entity.schema}.${entity.name}`,
				message: `is declared twice, with different values: ${JSON.stringify(other.values)} and ${JSON.stringify(entity.values)}`,
			})
		}
	}
	entities.push(...enums.values())
	const relations = new Map<string, string>()
	const claim = (name: string, what: string) => {
		const other = relations.get(name)
		if (other !== undefined) {
			problems.push({ object: name, message: `names both ${other} and ${what}; Postgres keeps them in one namespace` })
		}
		relations.set(name, what)
	}
	// A table is a type too (its row type), so an enum may not share its name.
	const types = new Set([...enums.values()].filter((e) => e.schema === null).map((e) => e.name))
	for (const { ddl } of tables) {
		claim(ddl.table.name, `table ${ddl.table.name}`)
		if (types.has(ddl.table.name)) problems.push({ object: ddl.table.name, message: "names both a table and an enum; Postgres keeps them in one namespace" })
		if (ddl.table.primaryKey !== null) claim(ddl.table.primaryKey.name, `the primary key of ${ddl.table.name}`)
		for (const index of ddl.indexes) claim(index.name, `an index on ${ddl.table.name}`)
		for (const unique of ddl.uniques) claim(unique.name, `a unique constraint on ${ddl.table.name}`)
		entities.push(ddl.table, ...ddl.columns, ...ddl.indexes, ...ddl.uniques, ...ddl.foreignKeys)
	}
	const columnsOf = new Map(tables.map(({ ddl }) => [ddl.table.name, new Set(ddl.columns.map((c) => c.name))]))
	const seenConstraints = new Set<string>()
	for (const { ddl } of tables) {
		for (const fk of ddl.foreignKeys) {
			const key = `${fk.table}.${fk.name}`
			if (seenConstraints.has(key)) problems.push({ object: key, message: "defined twice" })
			seenConstraints.add(key)
			const target = columnsOf.get(fk.foreignTable)
			if (target === undefined) {
				problems.push({ object: key, message: `references ${fk.foreignTable}, which is not a table in this schema` })
				continue
			}
			const missing = fk.foreignColumns.filter((c) => !target.has(c))
			if (missing.length > 0) {
				problems.push({ object: key, message: `references ${missing.join(", ")}, not columns of ${fk.foreignTable}` })
			}
		}
	}
	return validated(problems, entities)
}

/** A snapshot of `entities` with the given parents. Its id is the hash of the entities alone. */
export function makeSnapshot(entities: ReadonlyArray<SchemaEntity>, prevIds: ReadonlyArray<string>): Effect.Effect<ClickHouseSnapshot>
export function makeSnapshot(
	entities: ReadonlyArray<PgSchemaEntity>,
	prevIds: ReadonlyArray<string>,
	dialect: "postgres",
): Effect.Effect<PgSnapshot>
export function makeSnapshot(
	entities: ReadonlyArray<AnySchemaEntity>,
	prevIds: ReadonlyArray<string>,
	dialect?: SchemaDialect,
): Effect.Effect<Snapshot>
export function makeSnapshot(
	entities: ReadonlyArray<AnySchemaEntity>,
	prevIds: ReadonlyArray<string>,
	dialect: SchemaDialect = "clickhouse",
): Effect.Effect<Snapshot> {
	return Effect.promise(() => sha256Hex(canonicalJson(sortEntities(entities)))).pipe(
		Effect.map(
			(id) =>
				({
					version: SNAPSHOT_VERSION,
					dialect,
					id,
					prevIds: [...prevIds],
					entities: sortEntities(entities),
				}) as Snapshot,
		),
	)
}

/** Pretty, stable snapshot JSON for committing. */
export const serializeSnapshot = (snapshot: Snapshot): string => `${JSON.stringify(snapshot, null, "\t")}\n`
