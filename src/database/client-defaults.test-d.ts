// Type-level tests: client-side defaults make a column optional in an insert,
// and their requirements become the requirements of the write that runs them.

import { Context, DateTime, Effect } from "effect"
import { expectTypeOf } from "expect-type"
import * as PG from "../postgres"
import * as Db from "../database"

class IdGen extends Context.Service<IdGen, { readonly next: Effect.Effect<string> }>()("test/IdGen") {}
class Audit extends Context.Service<Audit, { readonly now: Effect.Effect<DateTime.Utc> }>()("test/Audit") {}

/** What an Effect requires, to assert on. */
const services = <R>(_: Effect.Effect<any, any, R>) => expectTypeOf<R>()

const nextId = Effect.flatMap(Effect.service(IdGen), (gen) => gen.next)
const auditNow = Effect.flatMap(Effect.service(Audit), (audit) => audit.now)

const Notes = PG.table("notes", {
	columns: {
		id: PG.column(PG.text, { defaultFn: nextId }),
		body: PG.text,
		updatedAt: PG.column(PG.timestamptz, { onUpdate: DateTime.now }),
	},
})

// defaultFn and onUpdate columns may be left out; the others may not.
expectTypeOf<PG.InsertRowOf<typeof Notes>>().toEqualTypeOf<{
	readonly body: PG.InsertValue<typeof PG.text>
	readonly id?: PG.InsertValue<typeof PG.text> | undefined
	readonly updatedAt?: PG.InsertValue<typeof PG.timestamptz> | undefined
}>()

// The insert requires the id generator; the update does not, as `DateTime.now` needs only the clock.
const insert = PG.insertInto(Notes).values({ body: "a" })
const update = PG.update(Notes).set({ body: "b" }).allRows()
expectTypeOf(Db.run(insert)).toEqualTypeOf<
	Effect.Effect<ReadonlyArray<never>, Db.DatabaseError | PG.QueryBuilderError | PG.CompiledQueryDecodeError, Db.Database | IdGen>
>()
services(Db.run(update)).toEqualTypeOf<Db.Database>()
services(PG.fillDefaults(insert)).toEqualTypeOf<IdGen>()

// A query, and a write to a table without client defaults, require only the database.
const Plain = PG.table("plain", { columns: { id: PG.text } })
const plainInsert = PG.insertInto(Plain).values({ id: "x" })
services(Db.run(plainInsert)).toEqualTypeOf<Db.Database>()
const select = PG.from(Notes).select("id")
services(Db.run(select)).toEqualTypeOf<Db.Database>()

// An onUpdate that needs a service: the update requires it, and so does an
// insert, which runs the onUpdate for a column with no other default.
const Audited = PG.table("audited", {
	columns: {
		id: PG.text,
		at: PG.column(PG.timestamptz, { onUpdate: auditNow }),
		stamped: PG.column(PG.timestamptz, { defaultExpr: "now()", onUpdate: auditNow }),
	},
})
const auditedUpdate = PG.update(Audited).set({ id: "x" }).allRows()
services(Db.run(auditedUpdate)).toEqualTypeOf<Db.Database | Audit>()
const auditedInsert = PG.insertInto(Audited).values({ id: "x" })
services(Db.run(auditedInsert)).toEqualTypeOf<Db.Database | Audit>()

// The Effect must give a value of the column's type, and must not fail.
// @ts-expect-error -- a number is not a text value
PG.column(PG.text, { defaultFn: Effect.succeed(1) })
// @ts-expect-error -- a default that can fail has no place to send its error
PG.column(PG.text, { defaultFn: Effect.fail("no id") })
