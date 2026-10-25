// Postgres: an in-process PGlite, so it always runs.
import fc from "fast-check"
import { DateTime } from "effect"
import { PGlite } from "@electric-sql/pglite"
import * as PG from "@maple-dev/effect-orm/postgres"
import { postgresContext } from "../../core-cases"
import { finite, int32, nastyString, nullOr, utc, type LiteralType } from "../values"
import { runWith, type FuzzDialect, type StringRules } from "./types"

let pglite: PGlite | undefined
/** One in-process Postgres per test file; PGlite takes the time zone from the host otherwise. */
const database = (): PGlite => (pglite ??= new PGlite({ postgresqlconf: "timezone = 'UTC'" }))

// Literals

// Postgres `text` cannot hold U+0000, and PGlite's TextDecoder drops a leading BOM.
const strings: StringRules = { nul: false, leadingBom: false }
// PGlite hands timestamps to JS as `Date`s built with two-digit-year rules, so
// years 0–99 come back as 1900–1999 before the builder sees them.
const MIN_TS = Date.UTC(100, 0, 1)
const MAX_TS = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

/** The reference row, parsed by Postgres from jsonb rather than written by the builder. */
const json = (text: string) => `CAST('${text.replaceAll("'", "''")}' AS jsonb)`
const scalarSource = (sqlType: string) => (text: string) => `SELECT CAST(${json(text)}->>'v' AS ${sqlType}) AS "v"`
const arraySource = (sqlType: string) => (text: string) =>
	`SELECT CAST(ARRAY(SELECT jsonb_array_elements_text(${json(text)}->'v')) AS ${sqlType}[]) AS "v"`

const literal = (
	id: string,
	type: PG.PgType<string, any, any>,
	value: fc.Arbitrary<unknown>,
	options: { wire?: (value: unknown) => unknown; array?: boolean } = {},
): LiteralType => ({
	id: `postgres:${id}`,
	type,
	value,
	wire: options.wire ?? ((v) => v),
	source: options.array ? arraySource(type.sql.replace(/\[\]$/, "")) : scalarSource(type.sql),
	comparable: true,
})

const nasty = nastyString(strings)
const literals: ReadonlyArray<LiteralType> = [
	literal("text", PG.text, nasty),
	literal("int4", PG.int4, int32),
	literal("int8", PG.int8, fc.maxSafeInteger()),
	literal("float8", PG.float8, finite),
	literal("boolean", PG.bool, fc.boolean()),
	literal("timestamptz", PG.timestamptz, fc.integer({ min: MIN_TS, max: MAX_TS }).map(utc), {
		wire: (value) => new Date(DateTime.toEpochMillis(value as DateTime.Utc)).toISOString(),
	}),
	literal("nullable(text)", PG.nullable(PG.text), nullOr(nasty)),
	literal("nullable(int8)", PG.nullable(PG.int8), nullOr(fc.maxSafeInteger())),
	literal("text[]", PG.array(PG.text), fc.array(nasty, { maxLength: 4 }), { array: true }),
]

export const postgres: FuzzDialect = {
	name: "postgres",
	module: PG as never,
	context: postgresContext,
	strings,
	ilike: true,
	checkPlaceholders: (sql, count) => {
		const used = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))
		const expected = Array.from({ length: count }, (_, i) => i + 1)
		return used.size === expected.length && expected.every((n) => used.has(n))
			? undefined
			: `placeholders ${[...used].sort((a, b) => a - b).join(",")} do not match ${count} parameters`
	},
	literals,
	writes: {
		insertSelect: true,
		update: true,
		delete: true,
		onConflict: true,
		returning: true,
		defaultCells: true,
		scratch: {
			table: (name) =>
				PG.table(name, {
					external: true,
					columns: { Id: PG.int8, OrgId: PG.text, Name: PG.text, Note: PG.nullable(PG.text), Qty: PG.column(PG.int8, { default: 5 }) },
				}),
			create: (name) => [`CREATE TABLE "${name}" ("Id" int8 PRIMARY KEY, "OrgId" text NOT NULL, "Name" text NOT NULL, "Note" text, "Qty" int8 NOT NULL DEFAULT 5)`],
			drop: (name) => `DROP TABLE IF EXISTS "${name}"`,
			exec: async (sql) => {
				await database().exec(sql)
			},
		},
	},
	targets: [
		{
			name: "postgres",
			available: true,
			semantics: {
				missingJoinColumn: "null",
				integerDivision: "truncate",
				modulo: "truncate",
				nulls: { asc: "last", desc: "first" },
				emptyAggregate: "null",
				likeIgnoresCase: false,
			},
			run: (compiled) => runWith(compiled, async (sql, parameters) => (await database().query<Record<string, unknown>>(sql, [...parameters])).rows),
		},
	],
	close: async () => {
		await pglite?.close()
		pglite = undefined
	},
}
