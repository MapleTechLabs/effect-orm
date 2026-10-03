// Type-level tests: `Transaction` as a requirement, and what `transaction` removes.

import { Effect } from "effect"
import { expectTypeOf } from "expect-type"
import * as CH from "../index"
import * as PG from "../postgres"
import * as Db from "../database"

class Domain {
	readonly _tag = "Domain"
}

const compiled = PG.compileUnsafe(CH.from(CH.table("t", { id: PG.int4, note: PG.text })).select("id", "note"), {})

// `run` infers rows from the compiled query and needs only a Database.
expectTypeOf(Db.run(compiled)).toEqualTypeOf<
	Effect.Effect<ReadonlyArray<{ readonly id: number; readonly note: string }>, Db.DatabaseError | CH.CompiledQueryDecodeError, Db.Database>
>()

// A helper that must run in a transaction carries `Transaction` in R.
const mustBeAtomic = Effect.gen(function* () {
	yield* Db.Transaction
	yield* Db.execute({ sql: "UPDATE t SET note = ''" })
	return 1
})
expectTypeOf(mustBeAtomic).toEqualTypeOf<Effect.Effect<number, Db.DatabaseError, Db.Transaction | Db.Database>>()

// `transaction` removes it, data-first and pipeable, and adds its own errors.
type Wrapped = Effect.Effect<number, Db.DatabaseError | Db.TransactionError, Db.Database>
expectTypeOf(Db.transaction(mustBeAtomic)).toEqualTypeOf<Wrapped>()
expectTypeOf(mustBeAtomic.pipe(Db.transaction({ isolationLevel: "serializable" }))).toEqualTypeOf<Wrapped>()

// Domain errors stay in the error channel beside the transaction's.
expectTypeOf(Db.transaction(Effect.fail(new Domain()))).toEqualTypeOf<
	Effect.Effect<never, Domain | Db.DatabaseError | Db.TransactionError, Db.Database>
>()

// As an Effect.fn pipe argument.
const method = Effect.fn("method")(function* (id: number) {
	yield* Db.Transaction
	return id
}, Db.transaction())
expectTypeOf(method).returns.toEqualTypeOf<Effect.Effect<number, Db.DatabaseError | Db.TransactionError, Db.Database>>()

// Without the wrapper, a Transaction requirement cannot be provided by Database alone.
// @ts-expect-error Transaction is still required
const unwrapped: Effect.Effect<number, Db.DatabaseError, Db.Database> = mustBeAtomic
void unwrapped

// Settings are typed: an unknown isolation level does not compile.
// @ts-expect-error not an isolation level
void Db.transaction(Effect.void, { isolationLevel: "read uncommitted" })
