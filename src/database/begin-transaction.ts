// Effect's `SqlClient.BeginTransaction` (effect 4.0.6, Effect-TS/effect#9576):
// a reference whose value replaces the client's BEGIN for one top-level
// transaction. With it, a transaction's settings travel in BEGIN itself, one
// round trip less than a separate `SET TRANSACTION`.
//
// The peer range starts at effect 4.0.0, which has no such export, so it is read
// by name at run time: `undefined` there, and `transaction` keeps sending `SET
// TRANSACTION`. `Reflect.get` keeps bundlers from flagging a missing export
// on an older effect. When the peer range moves to ^4.0.6, this module becomes
// a plain `SqlClient.BeginTransaction`.

import { Context } from "effect"
import * as SqlClient from "effect/sql/SqlClient"

/** The statement that starts a top-level transaction; `undefined` keeps the client's. */
export type BeginTransactionReference = Context.Reference<string | undefined>

const found: unknown = Reflect.get(SqlClient, "BeginTransaction")

/** `SqlClient.BeginTransaction` when the installed effect has it. */
export const coreBeginTransaction: BeginTransactionReference | undefined =
	Context.isKey(found) && Context.isReference(found) ? (found as BeginTransactionReference) : undefined
