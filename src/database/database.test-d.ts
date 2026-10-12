// Type-level tests: rows from `run`, `requireTransaction`, and what `transaction` removes.

import { Effect, Schema } from "effect"
import { expectTypeOf } from "expect-type"
import * as CH from "../ch/index"
import * as PG from "../postgres"
import * as Db from "../database"

class Domain {
	readonly _tag = "Domain"
}

const Items = CH.table("t", { id: PG.int4, note: PG.text })
type Row = { readonly id: number; readonly note: string }
type RunError = Db.DatabaseError | CH.QueryBuilderError | CH.CompiledQueryDecodeError

// `run` takes the query itself and infers its rows.
expectTypeOf(Db.run(CH.from(Items).select("id", "note"))).toEqualTypeOf<Effect.Effect<ReadonlyArray<Row>, RunError, Db.Database>>()
expectTypeOf(Db.run(CH.unionAll(CH.from(Items).select("id", "note"), CH.from(Items).select("id", "note")))).toEqualTypeOf<
	Effect.Effect<ReadonlyArray<Row>, RunError, Db.Database>
>()
// ...or a query compiled elsewhere.
expectTypeOf(Db.run(PG.compileUnsafe(CH.from(Items).select("id", "note"), {}))).toEqualTypeOf<
	Effect.Effect<ReadonlyArray<Row>, RunError, Db.Database>
>()

// `query` is untyped without a schema and typed with one.
expectTypeOf(Db.query(Db.sql`SELECT 1`)).toEqualTypeOf<
	Effect.Effect<ReadonlyArray<Record<string, unknown>>, Db.DatabaseError, Db.Database>
>()
expectTypeOf(Db.query(Db.sql`SELECT 1 AS n`, Schema.Struct({ n: Schema.Number }))).toEqualTypeOf<
	Effect.Effect<ReadonlyArray<{ readonly n: number }>, Db.DatabaseError | CH.CompiledQueryDecodeError, Db.Database>
>()

// `requireTransaction` adds the requirement; `transaction` removes it.
const revoke = Effect.fn("revoke")(function* (family: string) {
	yield* Db.execute(Db.sql`UPDATE t SET note = '' WHERE note = ${family}`)
	return 1
}, Db.requireTransaction)
expectTypeOf(revoke).returns.toEqualTypeOf<Effect.Effect<number, Db.DatabaseError, Db.Database | Db.Transaction>>()

type Wrapped = Effect.Effect<number, Db.DatabaseError | Db.TransactionError, Db.Database>
expectTypeOf(Db.transaction(revoke("f"))).toEqualTypeOf<Wrapped>()
expectTypeOf(revoke("f").pipe(Db.transaction({ isolationLevel: "serializable" }))).toEqualTypeOf<Wrapped>()

const op = Effect.fn("op")(function* () {
	return yield* revoke("f")
}, Db.transaction())
expectTypeOf(op).returns.toEqualTypeOf<Wrapped>()

// Domain errors stay in the error channel beside the transaction's.
expectTypeOf(Db.transaction(Effect.fail(new Domain()))).toEqualTypeOf<
	Effect.Effect<never, Domain | Db.DatabaseError | Db.TransactionError, Db.Database>
>()

// Without the wrapper, the requirement cannot be satisfied by a Database alone.
// @ts-expect-error Transaction is still required
const unwrapped: Effect.Effect<number, Db.DatabaseError, Db.Database> = revoke("f")
void unwrapped

// Settings are typed: an unknown isolation level does not compile.
// @ts-expect-error not an isolation level
void Db.transaction(Effect.void, { isolationLevel: "read uncommitted" })

// Any concrete insert is a `Runnable`, and `compile` takes it, upserts included:
// both take an insert by its tag, state and phantom, not by comparing its generic
// methods, which TypeScript 5 rejects for `CHInsert<any, ...>`. (tests/package-consumer-ts5.mts
// checks this against the built types with TypeScript 5 as well.)
const Counters = PG.table("counters", { columns: { key: PG.text, count: PG.int4 }, primaryKey: ["key"] })
const upsert = CH.insertInto(Counters)
	.values({ key: "k", count: CH.param.int("count") })
	.onConflictDoUpdate({ target: ["key"], set: { count: 1 } })
	.returning("count")
expectTypeOf(CH.insertInto(Counters).values({ key: "k", count: 1 })).toExtend<Db.Runnable>()
expectTypeOf(upsert).toExtend<Db.Runnable>()
expectTypeOf(Db.run(upsert, { count: 1 })).toEqualTypeOf<Effect.Effect<ReadonlyArray<{ readonly count: number }>, RunError, Db.Database>>()
// @ts-expect-error the param is still required
Db.run(upsert)
expectTypeOf(PG.compileUnsafe(upsert, { count: 1 })).toEqualTypeOf<CH.CompiledQuery<{ readonly count: number }, undefined>>()
