// A jsonb path's keys and result type come from the column's schema.

import { expectTypeOf } from "expect-type"
import { Schema } from "effect"
import type { Expr } from "../ch/expr"
import * as PG from "../postgres"

const Payload = Schema.Struct({
	profile: Schema.Struct({ city: Schema.String, zip: Schema.optionalKey(Schema.String), visits: Schema.NumberFromString }),
	tags: Schema.Array(Schema.String),
	archived: Schema.optional(Schema.NullOr(Schema.Struct({ city: Schema.String }))),
})

const Docs = PG.table("docs", {
	columns: { id: PG.int4, payload: PG.jsonb(Payload), maybe: PG.nullable(PG.jsonb(Payload)), loose: PG.jsonb() },
	primaryKey: ["id"],
})

PG.from(Docs).select(($) => {
	// Reads: the field's decoded type, or null when a key is absent (never undefined).
	expectTypeOf(PG.jsonPath($.payload, "profile", "city")).toEqualTypeOf<Expr<string | null>>()
	expectTypeOf(PG.jsonPath($.payload, "profile", "visits")).toEqualTypeOf<Expr<number | null>>()
	expectTypeOf(PG.jsonPath($.payload, "profile", "zip")).toEqualTypeOf<Expr<string | null>>()
	expectTypeOf(PG.jsonPath($.payload, "tags", 0)).toEqualTypeOf<Expr<string | null>>()
	expectTypeOf(PG.jsonPath($.payload, "archived", "city")).toEqualTypeOf<Expr<string | null>>()
	expectTypeOf(PG.jsonPath($.maybe, "profile", "city")).toEqualTypeOf<Expr<string | null>>()
	expectTypeOf(PG.jsonPath($.loose, "any", 1, "key")).toEqualTypeOf<Expr<unknown>>()
	expectTypeOf(PG.jsonPathText($.payload, "profile", "visits")).toEqualTypeOf<Expr<string | null>>()

	// Only paths the schema has.
	// @ts-expect-error -- no such field
	PG.jsonPath($.payload, "profile", "town")
	// @ts-expect-error -- an array takes an index, not a key
	PG.jsonPath($.payload, "tags", "first")
	// @ts-expect-error -- a path needs a key
	PG.jsonPath($.payload)

	// Comparisons take the field's type.
	PG.jsonPath($.payload, "profile", "visits").eq(3)
	// @ts-expect-error -- visits is a number
	PG.jsonPath($.payload, "profile", "visits").eq("3")

	// Containment takes part of the document.
	PG.jsonContains($.payload, { profile: { city: "Kyiv" }, tags: ["a"] })
	// @ts-expect-error -- city is a string
	PG.jsonContains($.payload, { profile: { city: 1 } })

	// jsonb_set: the value has the path's type, and the result is the document.
	expectTypeOf(PG.jsonSet($.payload, ["profile", "visits"], 4)).toEqualTypeOf<Expr<typeof Payload.Type>>()
	// @ts-expect-error -- visits is a number
	PG.jsonSet($.payload, ["profile", "visits"], "4")
	// @ts-expect-error -- not a path of the document
	PG.jsonSet($.payload, ["profile", "town"], "x")
	return { id: $.id }
})

PG.update(Docs).set(($) => ({ payload: PG.jsonSet($.payload, ["profile", "city"], "Lviv") }))
