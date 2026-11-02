// Schema properties exercise codec composition without a database. SQL-domain
// generators stay separate: a wire number schema is wider than an SQL integer.
import { Arbitrary, Effect, Exit, Schema } from "effect"
import { TestSchema } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as PG from "@maple-dev/effect-orm/postgres"
import * as SQLite from "@maple-dev/effect-orm/sqlite"
import { dialects } from "./dialects"
import { effectOptions, property, withContext } from "./harness"
import { normalize } from "./values"

const boundedText = Schema.String.check(Schema.isMaxLength(32))
const Id = Schema.NonEmptyString.check(Schema.isMaxLength(16)).pipe(Schema.brand("FuzzId"))
const payload = Schema.Struct({
	id: Id,
	message: boundedText,
	values: Schema.Array(Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: -1000, maximum: 1000 })))).check(Schema.isMaxLength(6)),
	metadata: Schema.Record(boundedText, Schema.NullOr(boundedText)),
})
const composed = CH.array(CH.nullable(CH.brand(CH.string, Id)))
const transformed = CH.custom("String", Schema.FiniteFromString)
const cases = {
	"ClickHouse numeric wire": CH.int64.schema,
	"Postgres numeric wire": PG.int8.schema,
	"ClickHouse nullable branded arrays": composed.schema,
	"ClickHouse maps of arrays": CH.map(CH.string, CH.array(CH.nullable(CH.string))).schema,
	"custom transformed values": transformed.schema,
	"Postgres jsonb payload": PG.jsonb(payload).schema,
	"SQLite json payload": SQLite.json(payload).schema,
	"SQLite binary wire": SQLite.blob.schema,
	"Postgres nested nullable arrays": PG.array(PG.array(PG.nullable(PG.text))).schema,
} satisfies Record<string, Schema.Codec<any, any>>

describe("Effect codec round-trips", () => {
	for (const [name, schema] of Object.entries(cases)) {
		it(`${name} survives encode and decode`, () => new TestSchema.Asserts(schema).verifyRoundTrip(effectOptions(100)))
	}
})

const row = Schema.Struct({ id: Id, payload, transformed: Schema.FiniteFromString })
const equivalentRows = Schema.toEquivalence(Schema.Array(row))
const columns = {
	id: CH.brand(CH.string, Id),
	payload: CH.custom("String", Schema.fromJsonString(payload)),
	transformed,
}

describe("Effect generated compiled row codecs", () => {
	for (const dialect of dialects) {
		// These are wire-only codec tests; the custom descriptors need no SQL storage counterpart.
		const table = dialect.module.table("codec_rows", { external: true, columns })
		const compiled = Effect.runSync(dialect.module.compile(dialect.module.from(table).select()))
		const name = `compiled row codec retains generated values (${dialect.name})`
		it(name, () => property(name, Arbitrary.schema(row), async (value) => {
			const wire = await Effect.runPromise(compiled.encodeRows([value]))
			const decoded = await Effect.runPromise(compiled.decodeRows(wire))
			await withContext({ wire, decoded }, () => {
				expect(equivalentRows(decoded, [value])).toBe(true)
			})
		}, { runs: 100 }))

		const invalidName = `compiled row codec rejects malformed wire (${dialect.name})`
		it(invalidName, () => property(invalidName, Arbitrary.all({
			value: Arbitrary.schema(row),
			corruption: Arbitrary.schema(Schema.Literals(["missing", "null", "json", "brand", "number"])),
		}), async ({ value, corruption }) => {
			const wire = await Effect.runPromise(compiled.encodeRows([value]))
			const bad = { ...wire[0] }
			switch (corruption) {
				case "missing": delete bad.id; break
				case "null": bad.payload = null; break
				case "json": bad.payload = "{"; break
				case "brand": bad.id = ""; break
				case "number": bad.transformed = "not a number"; break
			}
			const exit = await Effect.runPromiseExit(compiled.decodeRows([wire[0]!, bad]))
			await withContext({ corruption, bad, exit }, () => {
				expect(Exit.isFailure(exit)).toBe(true)
				if (Exit.isSuccess(exit)) return
				expect(exit.cause.reasons).toHaveLength(1)
				const reason = exit.cause.reasons[0]!
				expect(reason._tag).toBe("Fail")
				if (reason._tag !== "Fail") return
				expect(reason.error._tag).toBe("@maple-dev/effect-orm/CompiledQueryDecodeError")
				expect(reason.error.rowIndex).toBe(1)
			})
		}, { runs: 100 }))
	}
})

// A round trip uses the encoder's preferred union branch. Check alternate
// producer forms independently so quoted numeric wire values are covered too.
describe("Effect generated numeric wire representations", () => {
	for (const [name, type] of [["clickhouse", CH.float64], ["postgres", PG.float8]] as const) {
		const table = CH.table("numeric_rows", { external: true, columns: { value: type } })
		const compiled = (name === "postgres" ? PG.compileUnsafe : CH.compileUnsafe)(CH.from(table).select())
		const label = `quoted and unquoted numeric wire agree (${name})`
		it(label, () => property(label, Arbitrary.schema(Schema.Finite), async (value) => {
			const decoded = await Effect.runPromise(compiled.decodeRows([{ value }, { value: String(value) }]))
			expect(normalize(decoded)).toEqual(normalize([{ value }, { value }]))
		}, { runs: 100 }))
	}
})
