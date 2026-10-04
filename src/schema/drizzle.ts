// Reading a drizzle-kit (v1, snapshot version 8) Postgres snapshot as entities.
//
// Adopting effect-orm in a folder drizzle-kit wrote starts from a baseline: a
// snapshot of the schema the database already has. drizzle-kit's last
// snapshot is exactly that, so `generate --baseline --from-drizzle` converts
// it rather than trusting the TypeScript definitions to match the database.
// The first `generate` after it then shows, as ordinary ops, every place the
// definitions and the database disagree.
//
// Only what the entity model holds converts: tables, columns, primary keys,
// indexes, foreign keys in the `public` schema. Anything else (enums,
// sequences, views, policies, check and unique constraints, identity and
// generated columns, other schemas) is reported, and nothing is written.

import { canonicalPgType, type PgIdentity, type PgReferentialAction, type PgSchemaEntity, type PgTableEntity } from "./pg-entities"
import { sortEntities } from "./entities"

export interface DrizzleImport {
	readonly entities: ReadonlyArray<PgSchemaEntity>
	/** Objects the snapshot holds that have no entity here. Empty when the import is complete. */
	readonly unsupported: ReadonlyArray<string>
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === "string" ? value : String(value))
const strings = (value: unknown): ReadonlyArray<string> => (Array.isArray(value) ? value.map(str) : [])

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`

const ACTIONS: ReadonlyArray<PgReferentialAction> = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"]
const action = (value: unknown): PgReferentialAction => {
	const upper = typeof value === "string" ? value.toUpperCase() : "NO ACTION"
	return ACTIONS.find((a) => a === upper) ?? "NO ACTION"
}

/** drizzle-kit writes a default as SQL text, or (in some versions) as `{ value, type }`. */
const defaultOf = (value: unknown): string | null => {
	if (value === null || value === undefined) return null
	if (typeof value === "string") return value
	if (isRecord(value) && "value" in value) return str(value.value)
	return str(value)
}

const indexPart = (part: unknown): string => {
	if (typeof part === "string") return quote(part)
	if (!isRecord(part)) return str(part)
	let sql = part.isExpression === true ? str(part.value) : quote(str(part.value))
	if (typeof part.opclass === "string" && part.opclass.length > 0) sql += ` ${part.opclass}`
	const asc = part.asc !== false
	if (!asc) sql += " DESC"
	// Postgres's defaults: NULLS LAST ascending, NULLS FIRST descending.
	if (asc && part.nullsFirst === true) sql += " NULLS FIRST"
	if (!asc && part.nullsFirst === false) sql += " NULLS LAST"
	return sql
}

const MAX: Readonly<Record<string, string>> = { smallint: "32767", integer: "2147483647", bigint: "9223372036854775807" }

/**
 * An identity's kind, or `"!<reason>"` when its sequence has options the
 * entity does not hold (anything but Postgres's defaults and the default name).
 */
const identityOf = (value: unknown, table: string, column: string, type: string): PgIdentity | null | `!${string}` => {
	if (value === null || value === undefined) return null
	if (!isRecord(value)) return "!an identity column drizzle-kit wrote in an unknown form"
	const kind = value.type === "always" ? "always" : value.type === "byDefault" ? "by default" : undefined
	if (kind === undefined) return `!an identity of type ${str(value.type)}`
	const defaults: Record<string, unknown> = {
		name: `${table}_${column}_seq`,
		increment: "1",
		startWith: "1",
		minValue: "1",
		maxValue: MAX[canonicalPgType(type)],
		cache: 1,
		cycle: false,
	}
	const custom = Object.entries(defaults).filter(([key, expected]) => key in value && value[key] !== undefined && value[key] !== null && String(value[key]) !== String(expected))
	return custom.length > 0 ? `!an identity whose sequence sets ${custom.map(([k]) => k).join(", ")}` : kind
}

/** Convert a drizzle-kit Postgres snapshot (`snapshot.json`, version 8). */
export const fromDrizzleSnapshot = (json: unknown): DrizzleImport => {
	const unsupported: Array<string> = []
	if (!isRecord(json) || !Array.isArray(json.ddl)) {
		return { entities: [], unsupported: ["not a drizzle-kit snapshot: it has no ddl list"] }
	}
	if (json.dialect !== undefined && json.dialect !== "postgres" && json.dialect !== "postgresql") {
		unsupported.push(`dialect ${str(json.dialect)}: only Postgres snapshots convert`)
	}
	const tables = new Map<string, { name: string; primaryKey: PgTableEntity["primaryKey"] }>()
	const entities: Array<PgSchemaEntity> = []
	const positions = new Map<string, number>()

	for (const raw of json.ddl as ReadonlyArray<unknown>) {
		if (!isRecord(raw)) continue
		const type = str(raw.entityType)
		const schema = raw.schema === undefined ? "public" : str(raw.schema)
		const where = `${type} ${raw.table !== undefined ? `${str(raw.table)}.` : ""}${str(raw.name)}`
		if (type === "schemas") {
			if (str(raw.name) !== "public") unsupported.push(`schema ${str(raw.name)}`)
			continue
		}
		if (schema !== "public") {
			unsupported.push(`${where} (schema ${schema})`)
			continue
		}
		switch (type) {
			case "tables": {
				if (raw.isRlsEnabled === true) unsupported.push(`${where}: row-level security`)
				tables.set(str(raw.name), { name: str(raw.name), primaryKey: null })
				break
			}
			case "columns": {
				const table = str(raw.table)
				if (raw.typeSchema !== null && raw.typeSchema !== undefined) unsupported.push(`${where}: an enum or custom type`)
				if (raw.generated !== null && raw.generated !== undefined) unsupported.push(`${where}: a generated column`)
				const identity = identityOf(raw.identity, str(raw.table), str(raw.name), str(raw.type))
				if (typeof identity === "string" && identity.startsWith("!")) unsupported.push(`${where}: ${identity.slice(1)}`)
				const position = positions.get(table) ?? 0
				positions.set(table, position + 1)
				const dimensions = typeof raw.dimensions === "number" ? raw.dimensions : 0
				entities.push({
					kind: "column",
					table,
					name: str(raw.name),
					position,
					type: canonicalPgType(`${str(raw.type)}${"[]".repeat(dimensions)}`),
					notNull: raw.notNull === true,
					default: defaultOf(raw.default),
					identity: identity === "always" || identity === "by default" ? identity : null,
				})
				break
			}
			case "pks": {
				const table = tables.get(str(raw.table))
				if (table === undefined) unsupported.push(`${where}: its table comes later in the snapshot`)
				else table.primaryKey = { name: str(raw.name), columns: strings(raw.columns) }
				break
			}
			case "indexes": {
				if (typeof raw.with === "string" && raw.with.length > 0) unsupported.push(`${where}: WITH (${raw.with})`)
				entities.push({
					kind: "index",
					table: str(raw.table),
					name: str(raw.name),
					unique: raw.isUnique === true,
					method: typeof raw.method === "string" && raw.method.length > 0 ? raw.method.toLowerCase() : "btree",
					columns: Array.isArray(raw.columns) ? raw.columns.map(indexPart) : [],
					where: typeof raw.where === "string" && raw.where.length > 0 ? raw.where : null,
				})
				break
			}
			case "fks": {
				if (raw.schemaTo !== undefined && raw.schemaTo !== "public") unsupported.push(`${where}: references schema ${str(raw.schemaTo)}`)
				entities.push({
					kind: "foreign_key",
					table: str(raw.table),
					name: str(raw.name),
					columns: strings(raw.columns),
					foreignTable: str(raw.tableTo),
					foreignColumns: strings(raw.columnsTo),
					onDelete: action(raw.onDelete),
					onUpdate: action(raw.onUpdate),
				})
				break
			}
			default:
				unsupported.push(where)
		}
	}
	for (const table of tables.values()) entities.push({ kind: "table", ...table })
	return { entities: sortEntities(entities), unsupported }
}
