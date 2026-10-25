// Typed JSON paths on a jsonb column, against PGlite: each query is compiled by
// the builder and run, so a test passes only if Postgres accepts the SQL and the
// rows decode through the schema the path reads off the column.

import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import type { CompiledQuery } from "../ch/compile"
import { clickhouseDialect } from "../ch/dialect"
import * as PG from "../postgres"

const db = new PGlite()

const Profile = Schema.Struct({
	city: Schema.String,
	zip: Schema.optionalKey(Schema.String),
	visits: Schema.NumberFromString,
})

const Payload = Schema.Struct({
	profile: Profile,
	tags: Schema.Array(Schema.String),
	scores: Schema.Record(Schema.String, Schema.Number),
	archived: Schema.optional(Schema.NullOr(Profile)),
})

const docs = PG.table("docs", {
	columns: { id: PG.int4, org: PG.text, payload: PG.jsonb(Payload), extra: PG.nullable(PG.jsonb()) },
	primaryKey: ["id"],
})

beforeAll(async () => {
	await db.exec(`
		CREATE TABLE docs (id int4 PRIMARY KEY, org text, payload jsonb NOT NULL, extra jsonb);
		INSERT INTO docs VALUES
			(1, 'o', '{"profile": {"city": "Kyiv", "zip": "01001", "visits": "3"}, "tags": ["a", "b"], "scores": {"x": 1}}', '{"k": 1}'),
			(2, 'o', '{"profile": {"city": "Lviv", "visits": "10"}, "tags": [], "scores": {}}', NULL);
	`)
})

afterAll(async () => {
	await db.close()
})

const run = async <O>(compiled: CompiledQuery<O>): Promise<ReadonlyArray<O>> => {
	const result = await db.query<Record<string, unknown>>(compiled.sql, [...compiled.parameters])
	return Effect.runPromise(compiled.decodeRows(result.rows))
}

describe("jsonb paths", () => {
	it("reads a nested field with ->, decoded by the field's schema", async () => {
		const compiled = PG.compileUnsafe(
			PG.from(docs)
				.select(($) => ({ id: $.id, city: PG.jsonPath($.payload, "profile", "city"), visits: PG.jsonPath($.payload, "profile", "visits") }))
				.orderBy(["id", "asc"]),
			{},
		)
		expect(compiled.sql).toContain(`("docs"."payload" -> 'profile' -> 'city') AS "city"`)
		expect(compiled.rowSchemaSource).toBe("derived")
		expect(await run(compiled)).toEqual([
			{ id: 1, city: "Kyiv", visits: 3 },
			{ id: 2, city: "Lviv", visits: 10 },
		])
	})
})

describe("jsonb paths: missing values", () => {
	it("reads an absent key, an array element and a record value as null when absent", async () => {
		const compiled = PG.compileUnsafe(
			PG.from(docs)
				.select(($) => ({
					zip: PG.jsonPath($.payload, "profile", "zip"),
					firstTag: PG.jsonPath($.payload, "tags", 0),
					x: PG.jsonPath($.payload, "scores", "x"),
					archivedCity: PG.jsonPath($.payload, "archived", "city"),
				}))
				.orderBy(($) => [[$.id, "asc"]]),
			{},
		)
		expect(compiled.sql).toContain(`("docs"."payload" -> 'tags' -> 0)`)
		expect(await run(compiled)).toEqual([
			{ zip: "01001", firstTag: "a", x: 1, archivedCity: null },
			{ zip: null, firstTag: null, x: null, archivedCity: null },
		])
	})
})

describe("jsonb path filters", () => {
	it("compares a path with a value encoded by the field's schema and bound as JSON", async () => {
		const compiled = PG.compileUnsafe(
			PG.from(docs)
				.select("id")
				.where(($) => [PG.jsonPath($.payload, "profile", "city").eq("Lviv"), PG.jsonPath($.payload, "profile", "visits").eq(10)]),
			{},
		)
		expect(compiled.sql).toContain(`("docs"."payload" -> 'profile' -> 'city') = $1`)
		// `visits` is a NumberFromString: 10 is stored, and compared, as "10".
		expect(compiled.parameters).toEqual(['"Lviv"', '"10"'])
		expect(await run(compiled)).toEqual([{ id: 2 }])
	})

	it("reads a path as text with ->> for LIKE", async () => {
		const compiled = PG.compileUnsafe(
			PG.from(docs)
				.select(($) => ({ id: $.id, city: PG.jsonPathText($.payload, "profile", "city") }))
				.where(($) => [PG.jsonPathText($.payload, "profile", "city").like("K%")]),
			{},
		)
		expect(compiled.sql).toContain(`("docs"."payload" -> 'profile' ->> 'city')`)
		expect(await run(compiled)).toEqual([{ id: 1, city: "Kyiv" }])
	})

	it("filters with @> on the document or on a path", async () => {
		const compiled = PG.compileUnsafe(
			PG.from(docs)
				.select("id")
				.where(($) => [PG.jsonContains($.payload, { profile: { city: "Kyiv" }, tags: ["b"] }), PG.jsonContains(PG.jsonPath($.payload, "tags"), ["a"])]),
			{},
		)
		expect(compiled.sql).toContain(`("docs"."payload" @> $1::jsonb)`)
		expect(compiled.parameters).toEqual(['{"profile":{"city":"Kyiv"},"tags":["b"]}', '["a"]'])
		expect(await run(compiled)).toEqual([{ id: 1 }])
	})

	it("takes any keys on a jsonb column with no schema, and reads unknown", async () => {
		const compiled = PG.compileUnsafe(
			PG.from(docs)
				.select(($) => ({ id: $.id, k: PG.jsonPath($.extra, "k") }))
				.orderBy(["id", "asc"]),
			{},
		)
		expect(await run(compiled)).toEqual([
			{ id: 1, k: 1 },
			{ id: 2, k: null },
		])
	})
})

describe("jsonb path failures", () => {
	it("is a defect for a path the schema does not have, and for a ClickHouse compile", () => {
		// @ts-expect-error -- not a field of the profile
		const wrong = PG.from(docs).select(($) => ({ v: PG.jsonPath($.payload, "profile", "town") }))
		expect(() => PG.compileUnsafe(wrong, {})).toThrow(/jsonPath \["profile","town"\]: the column's schema has no such path \(at \["profile","town"\]: no field "town"\)/)

		const ok = PG.from(docs).select(($) => ({ v: PG.jsonPath($.payload, "profile", "city") }))
		expect(() => PG.compileUnsafe(ok, {}, { dialect: clickhouseDialect })).toThrow(/jsonPath\(\) is a Postgres function/)
	})

	it("refuses a path through a field whose stored form is not its type", () => {
		const Renamed = Schema.Struct({ inner: Schema.Struct({ a: Schema.String }).pipe(Schema.encodeKeys({ a: "A" })) })
		const t = PG.table("r", { columns: { id: PG.int4, doc: PG.jsonb(Renamed) }, primaryKey: ["id"] })
		const query = PG.from(t).select(($) => ({ v: PG.jsonPath($.doc, "inner", "a") }))
		expect(() => PG.compileUnsafe(query, {})).toThrow(/its stored form is a transformation of its type/)
	})
})

describe("jsonb values that are not JSON", () => {
	it("fails the compile with InvalidLiteral instead of throwing", () => {
		const query = PG.from(docs)
			.select("id")
			.where(($) => [PG.jsonContains($.extra, { n: 1n })])
		expect(() => PG.compileUnsafe(query, {})).toThrow(/jsonContains: an object is not a valid value/)
	})
})

describe("jsonb_set", () => {
	it("sets one path in an UPDATE, encoded by the field's schema, and returns the decoded document", async () => {
		const compiled = PG.compileUnsafe(
			PG.update(docs)
				.set(($) => ({ payload: PG.jsonSet(PG.jsonSet($.payload, ["profile", "visits"], 11), ["tags", 0], "z") }))
				.where(($) => [$.id.eq(1)])
				.returning(($) => ({ payload: $.payload })),
			{},
		)
		expect(compiled.sql).toBe(
			`UPDATE "docs" SET "payload" = jsonb_set(jsonb_set("payload", ARRAY['profile', 'visits'], $1::jsonb), ARRAY['tags', 0::text], $2::jsonb)\nWHERE "id" = $3\nRETURNING "payload" AS "payload"`,
		)
		expect(compiled.parameters).toEqual(['"11"', '"z"', 1])
		const [row] = await run(compiled)
		expect(row?.payload.profile).toEqual({ city: "Kyiv", zip: "01001", visits: 11 })
		expect(row?.payload.tags).toEqual(["z", "b"])
	})
})
